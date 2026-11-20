import type { Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startSignalingServer } from '../../collab/server';
import { startLocalWorker } from '../../collab/worker/local';
import { startHarness, syntheticModelZip, type Harness } from './harness';

/**
 * Collaboration without people (docs/collaboration.md,
 * section 6): the Node signaling server here, and three Mochi Studio pages,
 * each in a browser context of its own (as on three computers), joining one
 * room over WebRTC.
 */
let H: Harness;
/**
 * The signaling server: the Node one, or, with MOCHI_COLLAB_SERVER=worker,
 * the Worker under Miniflare (collab/worker/local.ts), as on Cloudflare.
 */
let server: {
  wsUrl: string;
  stats(): Promise<{ rooms: number; members: number; knocking: number }>;
  close(): Promise<void>;
};
const onWorker = process.env.MOCHI_COLLAB_SERVER === 'worker';
let host: Page;
let guest: Page;
let third: Page;
const errors: string[] = [];

async function app(name: string, sharing: 'shared' | 'video' = 'shared'): Promise<Page> {
  const ctx = await H.browser.newContext({ viewport: { width: 1000, height: 700 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  await p.goto(H.url);
  await p.waitForFunction(() => 'mochiStudio' in window && 'mochiCollab' in window);
  await p.locator('#model-zip').setInputFiles({
    name: 'Test.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(syntheticModelZip()),
  });
  await p.waitForFunction(() => (window as any).mochiStudio.settings !== undefined);
  await p.evaluate(
    ({ server, name, sharing }) => {
      const s = (window as any).mochiStudio;
      // As a minimized window: every frame still runs (and the session with it), but the stage
      // isn't drawn. Three pages drawing under software WebGL would starve the shared GPU
      // process, and the avatar frames and output view still draw.
      // (`mochiTestShown` shows it again, for a test that needs a drawing window.)
      Object.defineProperty(document, 'hidden', {
        configurable: true,
        get: () => !(window as any).mochiTestShown,
      });
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => ((window as any).mochiTestShown ? 'visible' : 'hidden'),
      });
      s.setCollabSettings({ server, nickname: name, hideAddress: false });
      s.updateSettings({ collabSharing: sharing });
      // A video avatar half the stage's height: a smaller video (and less work for three pages
      // under software WebGL).
      if (sharing === 'video')
        s.updateSettings({ transform: { x: 0, y: 0, zoom: 0.5, rotation: 0 } });
    },
    { server: server.wsUrl, name, sharing },
  );
  return p;
}

/** The page's session, as plain data. */
const session = (p: Page) =>
  p.evaluate(() => {
    const s = (window as any).mochiCollab.session;
    if (!s) return undefined;
    return {
      status: s.status as string,
      message: s.message as string | undefined,
      you: s.you as string,
      link: s.link as string | undefined,
      locked: s.locked as boolean,
      knocks: [...s.knocks.values()] as { id: string; name: string; valid: boolean }[],
      people: [...s.participants.values()].map((x: any) => ({
        id: x.id,
        name: x.name,
        host: x.host,
        me: x.me,
        connection: x.connection,
        mode: x.model?.mode,
        received: x.received,
        files: x.files ? x.files.size : 0,
        place: x.place,
        hidden: x.hidden,
        error: x.error,
      })),
    };
  });
const person = async (p: Page, name: string) =>
  (await session(p))?.people.find((x) => x.name === name);
/** The item ids of collaborators in a page's runtime. */
const collabItems = (p: Page) =>
  p.evaluate(() =>
    (window as any).mochiStudio.runtime
      .items()
      .filter((i: any) => i.id.startsWith('collab:'))
      .map((i: any) => ({
        id: i.id,
        visible: i.visible,
        front: i.placement.front,
        x: i.placement.x,
      })),
  );
const itemParam = (p: Page, id: string, param: string) =>
  p.evaluate(
    ({ id, param }) => (window as any).mochiStudio.runtime.itemMap.get(id)?.getParameter(param),
    { id, param },
  );

beforeAll(async () => {
  H = await startHarness();
  server = onWorker
    ? await startLocalWorker({
        // Three pages and their reconnects, all from 127.0.0.1.
        bindings: {
          LIMIT_CONNECTIONS_PER_ADDRESS: '200',
          LIMIT_ROOMS_PER_ADDRESS: '200',
          LIMIT_NEW_CONNECTIONS_PER_MINUTE: '2000',
        },
      })
    : await startSignalingServer({ log: () => {} });
  host = await app('Hana');
  guest = await app('Kiri');
  third = await app('Ume', 'video');
}, 120_000);
afterAll(async () => {
  await server?.close();
  await H?.close();
});

describe('collaboration, with the local signaling server', () => {
  it('hosts, invites, and lets in only whom the host admits', async () => {
    await host.evaluate(() => (window as any).mochiCollab.host());
    await expect.poll(async () => (await session(host))?.status).toBe('hosting');
    const link = (await session(host))!.link!;
    expect(link).toMatch(/\/join\/[0-9a-f]+#[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{8}$/);
    // The server never saw the secret, nor the names in clear.
    expect(await server.stats()).toMatchObject({ rooms: 1, members: 1 });
    await guest.evaluate((l) => (window as any).mochiCollab.join(l), link);
    await expect.poll(async () => (await session(guest))?.status).toBe('waiting');
    await expect
      .poll(async () => (await session(host))?.knocks)
      .toEqual([expect.objectContaining({ name: 'Kiri', valid: true })]);
    // The host's screen shows the knock with a "Let in" button.
    await host.evaluate(() => {
      const s = (window as any).mochiCollab.session;
      s.admit([...s.knocks.keys()][0]);
    });
    await expect.poll(async () => (await session(guest))?.status).toBe('member');
    await expect
      .poll(async () => (await person(host, 'Kiri'))?.connection, { timeout: 20_000 })
      .toBe('connected');
    await expect.poll(async () => (await person(guest, 'Hana'))?.connection).toBe('connected');
    expect((await person(guest, 'Hana'))!.host).toBe(true);
  });

  it('shares a model once, encrypted, and shows it as an avatar that moves with its owner', async () => {
    // Each side's files reach the other, and become an avatar there.
    await expect
      .poll(async () => (await person(host, 'Kiri'))?.files, { timeout: 30_000 })
      .toBeGreaterThan(0);
    await expect.poll(async () => (await collabItems(host)).length, { timeout: 20_000 }).toBe(1);
    await expect.poll(async () => (await collabItems(guest)).length, { timeout: 20_000 }).toBe(1);
    const k = (await person(host, 'Kiri'))!;
    expect(k.mode).toBe('shared');
    expect(k.received).toBeGreaterThan(1000);
    // The guest turns its head: the host's copy of its avatar follows (16-bit, smoothed).
    await guest.evaluate(() => (window as any).mochiStudio.setOverrides({ ParamAngleX: 20 }));
    await expect
      .poll(() => itemParam(host, `collab:${k.id}`, 'ParamAngleX'), { timeout: 10_000 })
      .toBeCloseTo(20, 0);
    await guest.evaluate(() => (window as any).mochiStudio.setOverrides({ ParamAngleX: -10 }));
    await expect
      .poll(() => itemParam(host, `collab:${k.id}`, 'ParamAngleX'), { timeout: 10_000 })
      .toBeCloseTo(-10, 0);
    // It moves: its place on the shared stage reaches the host.
    await guest.evaluate(() =>
      (window as any).mochiStudio.updateSettings({
        transform: { x: 0.4, y: 0, zoom: 1, rotation: 0 },
      }),
    );
    await expect.poll(async () => (await person(host, 'Kiri'))?.place?.x).toBeCloseTo(0.4, 3);
  });

  it('passes expressions and motions as events, and keeps one front-to-back order', async () => {
    const k = (await person(host, 'Kiri'))!;
    await host.evaluate(() => {
      const r = (window as any).mochiStudio.runtime;
      (window as any).itemEvents = [];
      const e = r.setItemExpression.bind(r);
      r.setItemExpression = (id: string, file: string, on: boolean) => {
        (window as any).itemEvents.push(['expr', id, file, on]);
        e(id, file, on);
      };
    });
    const expression = await guest.evaluate(() => {
      const s = (window as any).mochiStudio;
      const name = s.model.manifest.expressions[0]?.name;
      if (name) s.setExpression(name, true);
      return name as string | undefined;
    });
    if (expression)
      await expect
        .poll(() => host.evaluate(() => (window as any).itemEvents))
        .toContainEqual(['expr', `collab:${k.id}`, expect.any(String), true]);
    // Bringing an avatar to the front, for everyone.
    await guest.evaluate(() => (window as any).mochiCollab.session.bringToFront());
    await expect.poll(async () => (await collabItems(host))[0]?.front).toBe(true);
    await host.evaluate(() => (window as any).mochiCollab.session.bringToFront());
    await expect.poll(async () => (await collabItems(host))[0]?.front).toBe(false);
    // And on the guest's screen, the host's avatar is now in front of the guest's own.
    await expect.poll(async () => (await collabItems(guest))[0]?.front).toBe(true);
  });

  it('hides a participant on this screen only', async () => {
    const k = (await person(host, 'Kiri'))!;
    await host.evaluate((id) => (window as any).mochiCollab.session.setHidden(id, true), k.id);
    await expect.poll(async () => (await collabItems(host))[0]?.visible).toBe(false);
    expect((await collabItems(guest))[0]?.visible).toBe(true);
    await host.evaluate((id) => (window as any).mochiCollab.session.setHidden(id, false), k.id);
    await expect.poll(async () => (await collabItems(host))[0]?.visible).toBe(true);
  });

  it('declines a knock, refuses all when locked, and lets a video-only model in without files', async () => {
    const link = (await session(host))!.link!;
    await third.evaluate((l) => (window as any).mochiCollab.join(l), link);
    await expect.poll(async () => (await session(host))?.knocks.length).toBe(1);
    await host.evaluate(() => {
      const s = (window as any).mochiCollab.session;
      s.decline([...s.knocks.keys()][0]);
    });
    await expect
      .poll(async () => (await session(third))?.message)
      .toBe('The host didn’t let you in.');
    await host.evaluate(() => (window as any).mochiCollab.session.lock(true));
    await expect.poll(async () => (await session(host))?.locked).toBe(true);
    await third.evaluate((l) => (window as any).mochiCollab.join(l), link);
    await expect
      .poll(async () => (await session(third))?.message)
      .toBe('The session is locked: the host lets no one else in.');
    await host.evaluate(() => (window as any).mochiCollab.session.lock(false));
    await expect.poll(async () => (await session(host))?.locked).toBe(false);
    await third.evaluate((l) => (window as any).mochiCollab.join(l), link);
    await expect.poll(async () => (await session(host))?.knocks.length).toBe(1);
    await host.evaluate(() => {
      const s = (window as any).mochiCollab.session;
      s.admit([...s.knocks.keys()][0]);
    });
    // Video only: listed, connected, but no files travel.
    await expect
      .poll(async () => (await person(host, 'Ume'))?.connection, { timeout: 20_000 })
      .toBe('connected');
    await expect.poll(async () => (await person(host, 'Ume'))?.mode).toBe('video');
    expect((await person(host, 'Ume'))!.received).toBe(0);
    expect((await person(guest, 'Ume'))?.name).toBe('Ume');
  });

  it('shows a video-only participant from their video, with its transparency', async () => {
    const u = (await person(host, 'Ume'))!;
    // A window out of sight makes no pictures nobody sees: the host's is shown for this test.
    await host.evaluate(() => ((window as any).mochiTestShown = true));
    // Ume's body at half opacity, turned so it stands right of the middle.
    await third.evaluate(() => {
      const s = (window as any).mochiStudio;
      s.runtime.setEffect?.('breath', false);
      s.setOverrides({ ParamAngleX: 30, ParamMouthOpenY: 0 });
      s.setModelTints([['ArtMeshBody', [1, 1, 1, 0.5]]]);
    });
    // Ume sends video (no files), and the host shows it as an avatar.
    await expect
      .poll(() => third.evaluate(() => (window as any).mochiCollab.sender?.frames ?? 0), {
        timeout: 20_000,
      })
      .toBeGreaterThan(10);
    await expect
      .poll(
        async () =>
          (await collabItems(host)).some((i: { id: string }) => i.id === `collab:${u.id}`),
        {
          timeout: 20_000,
        },
      )
      .toBe(true);
    const frame = (x: number, y: number) =>
      host.evaluate(
        ({ id, x, y }) => {
          const a = (window as any).mochiCollab.avatars.get(id);
          return a?.receiver
            ? { size: a.receiver.size, frames: a.receiver.frames, px: a.receiver.pixel(x, y) }
            : undefined;
        },
        { id: u.id, x, y },
      );
    await expect
      .poll(async () => (await frame(0, 0))?.frames ?? 0, { timeout: 20_000 })
      .toBeGreaterThan(5);
    const { size } = (await frame(0, 0))!;
    // Half the stage's height on a 1080-line stage: 540 lines.
    expect(size).toMatchObject({ width: 540, height: 540, fit: 0.95 });
    // The body, through the video: straight color and half alpha again (video coding blurs a little).
    const k = 0.95 * size.height;
    const body = { x: size.width / 2 + 0.38 * k, y: size.height / 2 - 0.1 * k };
    const near = (a: number[], b: number[], tol: number) =>
      a.every((v, i) => Math.abs(v - b[i]!) <= tol);
    await expect
      .poll(async () => (await frame(body.x, body.y))!.px, { timeout: 15_000 })
      .toSatisfy(
        (c: number[]) => near(c.slice(0, 3), [240, 180, 150], 30) && Math.abs(c[3]! - 128) <= 20,
      );
    // Around the avatar: transparent.
    expect((await frame(4, 4))!.px[3]).toBe(0);
    // Its place on the shared stage, at the avatar picture's size.
    expect((await person(host, 'Ume'))!.mode).toBe('video');
    expect((await person(host, 'Ume'))!.received).toBe(0);
    // Out of sight again, with no output view: no more pictures are made.
    await host.evaluate(() => ((window as any).mochiTestShown = false));
    await new Promise((r) => setTimeout(r, 300));
    const made = (await frame(0, 0))!.frames;
    await new Promise((r) => setTimeout(r, 1000));
    expect((await frame(0, 0))!.frames).toBe(made);
  });

  it('shows the others’ avatars in an output view too', { timeout: 90_000 }, async () => {
    let step = 'open the view';
    const view = await host.context().newPage();
    view.on('pageerror', (e) => errors.push(`view: ${e.message}`));
    // Which page stops answering, if one does: each gets 3 s to evaluate 1 + 1.
    const probe = async () => {
      const out: Record<string, string> = { step };
      for (const [name, pg] of Object.entries({ host, guest, third, view })) {
        const t0 = Date.now();
        out[name] = await Promise.race([
          pg.evaluate(() => 1 + 1).then(() => `ok in ${Date.now() - t0} ms`),
          new Promise<string>((r) => setTimeout(() => r('no answer in 3 s'), 3000)),
        ]).catch((e: Error) => e.message.slice(0, 80));
      }
      return JSON.stringify(out);
    };
    const watchdog = setTimeout(() => {
      void probe().then((d) => console.log('collab output view: stalled', d));
    }, 50_000);
    try {
      await view.goto(new URL('output.html', H.url).href);
      step = 'the view gets the avatars';
      const k = (await person(host, 'Kiri'))!;
      const u = (await person(host, 'Ume'))!;
      const viewItems = () =>
        view.evaluate(() =>
          (window as any).mochiOutput.runtime
            .items()
            .filter((i: any) => i.id.startsWith('collab:'))
            .map((i: any) => i.id)
            .sort(),
        );
      await expect
        .poll(viewItems, { timeout: 30_000 })
        .toEqual([`collab:${k.id}`, `collab:${u.id}`].sort());
      // Kiri's head turn reaches the view through the host: the view shows what the host shows.
      step = 'the head turn reaches the view';
      await guest.evaluate(() => (window as any).mochiStudio.setOverrides({ ParamAngleX: 15 }));
      const inView = () =>
        view.evaluate(
          (id) =>
            (window as any).mochiOutput.runtime.itemMap.get(id)?.getParameterBase('ParamAngleX'),
          `collab:${k.id}`,
        );
      const inHost = () =>
        host.evaluate(
          (id) =>
            (window as any).mochiStudio.runtime.itemMap.get(id)?.getParameterBase('ParamAngleX'),
          `collab:${k.id}`,
        );
      const diag = async () =>
        JSON.stringify({
          view: await inView(),
          host: await inHost(),
          hostLatest: await host.evaluate(
            (pid) => (window as any).mochiCollab.session.participants.get(pid)?.params?.latest(),
            k.id,
          ),
          guestOwn: await guest.evaluate(() =>
            (window as any).mochiStudio.runtime.getParameter?.('ParamAngleX'),
          ),
          frames: await view.evaluate(() => (window as any).mochiOutput.collabFrames),
          now: await host.evaluate(() => performance.now()),
        });
      try {
        await expect
          .poll(async () => Math.abs(((await inView()) ?? 99) - 15), { timeout: 30_000 })
          .toBeLessThan(1);
      } catch (e) {
        const d1 = await diag();
        await new Promise((r) => setTimeout(r, 2000));
        throw new Error(`${(e as Error).message}\n${d1}\n${await diag()}`);
      }
      expect(Math.abs((await inView()) - (await inHost()))).toBeLessThan(1);
      // Ume's video avatar gets its pictures there too (WebP, as web items do).
      step = 'the video avatar in the view';
      await expect
        .poll(
          () =>
            view.evaluate(
              (id) => (window as any).mochiOutput.runtime.itemMap.get(id)?.placement?.scale ?? 0,
              `collab:${u.id}`,
            ),
          { timeout: 10_000 },
        )
        .toBeGreaterThan(0);
    } finally {
      clearTimeout(watchdog);
      step = 'close the view';
      await view.close();
    }
  });

  it('refuses a shared model over 300 MB', async () => {
    const u = (await person(host, 'Ume'))!;
    const error = await host.evaluate((id) => {
      const s = (window as any).mochiCollab.session;
      s.ctlMessage(
        id,
        JSON.stringify({
          t: 'model',
          serial: 99,
          name: 'Big',
          mode: 'shared',
          table: [],
          neverSmoothed: [],
          files: [{ path: 'big.moc3', size: 400 * 1024 * 1024 }],
          bytes: 400 * 1024 * 1024,
        }),
      );
      return s.participants.get(id).error;
    }, u.id);
    expect(error).toMatch(/over 300 MB/);
  });

  it('comes back after a dropped connection to the server, host and guest, without losing anyone', async () => {
    const k = (await person(host, 'Kiri'))!;
    // The host's connection to the server drops: the guest hears the host is away, then back.
    await host.evaluate(() => (window as any).mochiCollab.session.dropServerConnection());
    await expect
      .poll(() => host.evaluate(() => (window as any).mochiCollab.state().reconnecting), {
        timeout: 10_000,
      })
      .toBe(false);
    await expect.poll(async () => (await session(host))?.status).toBe('hosting');
    await expect
      .poll(() => guest.evaluate(() => (window as any).mochiCollab.session.hostAway), {
        timeout: 10_000,
      })
      .toBe(false);
    // The guest's turn: nobody is told it left.
    await guest.evaluate(() => (window as any).mochiCollab.session.dropServerConnection());
    await expect
      .poll(() => guest.evaluate(() => (window as any).mochiCollab.state().reconnecting), {
        timeout: 10_000,
      })
      .toBe(false);
    expect((await person(host, 'Kiri'))?.id).toBe(k.id);
    // Both new connections work: the host locks, and the guest hears it.
    await host.evaluate(() => (window as any).mochiCollab.session.lock(true));
    await expect.poll(async () => (await session(guest))?.locked).toBe(true);
    await host.evaluate(() => (window as any).mochiCollab.session.lock(false));
    await expect.poll(async () => (await session(guest))?.locked).toBe(false);
    // And the avatar kept moving over WebRTC all along.
    await guest.evaluate(() => (window as any).mochiStudio.setOverrides({ ParamAngleX: 5 }));
    await expect
      .poll(() => itemParam(host, `collab:${k.id}`, 'ParamAngleX'), { timeout: 20_000 })
      .toBeCloseTo(5, 0);
  });

  it('blocks a participant on this screen only, through the agent API', async () => {
    const run = (p: Page, name: string, args: unknown) =>
      p.evaluate(({ name, args }) => (window as any).mochiStudio.run(name, args), { name, args });
    const k = (await person(host, 'Kiri'))!;
    await run(host, 'collab_block', { peer: 'Kiri', blocked: true });
    const st = (await run(host, 'get_state', {})) as any;
    expect(st.collab.people.find((p: any) => p.name === 'Kiri')).toMatchObject({
      blocked: true,
      hidden: true,
    });
    expect(JSON.stringify(st.collab)).not.toContain('#');
    await expect
      .poll(
        async () =>
          (await collabItems(host)).find((i: { id: string }) => i.id === `collab:${k.id}`)?.visible,
      )
      .toBe(false);
    // Their events are ignored here; the guest isn't told, and still sees everyone.
    const before = await host.evaluate(() => (window as any).itemEvents?.length ?? 0);
    const expression = await guest.evaluate(() => {
      const s = (window as any).mochiStudio;
      const name = s.model.manifest.expressions[0]?.name;
      if (name) s.setExpression(name, false);
      return name as string | undefined;
    });
    if (expression) {
      await new Promise((r) => setTimeout(r, 1000));
      expect(await host.evaluate(() => (window as any).itemEvents?.length ?? 0)).toBe(before);
    }
    expect((await person(guest, 'Hana'))?.connection).toBe('connected');
    await run(host, 'collab_block', { peer: k.id, blocked: false });
    await expect
      .poll(
        async () =>
          (await collabItems(host)).find((i: { id: string }) => i.id === `collab:${k.id}`)?.visible,
      )
      .toBe(true);
  });

  it('places someone by hand and pins them to this model, and keeps an order of its own, on this screen only', async () => {
    const k = (await person(host, 'Kiri'))!;
    const id = `collab:${k.id}`;
    const item = () =>
      host.evaluate(
        (id) => (window as any).mochiStudio.runtime.items().find((i: any) => i.id === id),
        id,
      );
    // Placed by hand: a drag (here, the runtime's own placement) stays, wherever Kiri goes.
    await host.evaluate((pid) => (window as any).mochiCollab.placeHere(pid, true), k.id);
    await host.evaluate(
      (id) => (window as any).mochiStudio.runtime.placeItem(id, { x: 0.123, y: -0.05 }),
      id,
    );
    await guest.evaluate(() =>
      (window as any).mochiStudio.updateSettings({
        transform: { x: -0.3, y: 0, zoom: 1, rotation: 0 },
      }),
    );
    await expect.poll(async () => (await person(host, 'Kiri'))?.place?.x).toBeCloseTo(-0.3, 3);
    await new Promise((r) => setTimeout(r, 500));
    expect((await item()).placement.x).toBeCloseTo(0.123, 3);
    // Pinned to this app's model, through the agent API.
    await host.evaluate(() =>
      (window as any).mochiStudio.run('collab_place', { peer: 'Kiri', here: true, pinned: true }),
    );
    expect((await item()).pinned).toBe(true);
    const st = (await host.evaluate(() => (window as any).mochiStudio.run('get_state', {}))) as any;
    expect(st.collab.people.find((p: any) => p.name === 'Kiri')).toMatchObject({
      placedHere: true,
      pinnedHere: true,
    });
    // Back to where Kiri stands.
    await host.evaluate((pid) => (window as any).mochiCollab.placeHere(pid, false), k.id);
    await expect.poll(async () => (await item()).pinned).toBe(false);
    await expect.poll(async () => (await item()).placement.x).not.toBeCloseTo(0.123, 2);
    // This screen's own order: Kiri at the back, then at the front; Kiri's screen keeps its own.
    const guestBefore = (await collabItems(guest))[0]?.front;
    await host.evaluate(() =>
      (window as any).mochiStudio.run('collab_order', { order: ['Kiri', 'Hana'] }),
    );
    await expect.poll(async () => (await item()).placement.front).toBe(false);
    await host.evaluate(() =>
      (window as any).mochiStudio.run('collab_order', { order: ['Hana', 'Kiri'] }),
    );
    await expect.poll(async () => (await item()).placement.front).toBe(true);
    expect((await collabItems(guest))[0]?.front).toBe(guestBefore);
    await host.evaluate(() => (window as any).mochiStudio.run('collab_order', {}));
    expect(await host.evaluate(() => (window as any).mochiCollab.state().localOrder)).toBe(false);
  });

  it('removes a participant: they are told, their avatar and files go everywhere, and they can’t come back', async () => {
    const k = (await person(host, 'Kiri'))!;
    await host.evaluate((id) => (window as any).mochiCollab.session.kick(id), k.id);
    await expect
      .poll(async () => (await session(guest))?.message)
      .toBe('You were removed from the session.');
    await expect.poll(async () => await person(host, 'Kiri')).toBeUndefined();
    await expect
      .poll(async () =>
        (await collabItems(host)).some((i: { id: string }) => i.id === `collab:${k.id}`),
      )
      .toBe(false);
    await expect.poll(async () => await person(third, 'Kiri'), { timeout: 15_000 }).toBeUndefined();
    // The guest's own screen dropped the others' avatars too.
    await expect.poll(async () => (await collabItems(guest)).length, { timeout: 15_000 }).toBe(0);
    // Knocking again from the same app is refused.
    await guest.evaluate((l) => (window as any).mochiCollab.join(l), (await session(host))!.link!);
    await expect
      .poll(async () => (await session(guest))?.message)
      .toBe('The host removed you from this session.');
  });

  it('ends for everyone when the host ends it', async () => {
    await host.evaluate(() => (window as any).mochiCollab.leave());
    await expect
      .poll(async () => (await session(third))?.message)
      .toBe('The host ended the session.');
    await expect.poll(async () => (await server.stats()).rooms).toBe(0);
    expect(errors).toEqual([]);
  });
});

describe('collaboration: codes, a password, a new link, and chat', () => {
  const knocks = async (p: Page) => (await session(p))?.knocks.length ?? 0;
  const admitFirst = (p: Page) =>
    p.evaluate(() => {
      const s = (window as any).mochiCollab.session;
      s.admit([...s.knocks.keys()][0]);
    });

  it('joins with the code and the password; a wrong password is declined at once', async () => {
    const { code } = await host.evaluate(() =>
      (window as any).mochiCollab.host({ password: 'mochi-pw' }),
    );
    expect(code).toMatch(/^MOCHI(-[0-9A-HJKMNP-TV-Z]{5}){10}$/);
    // The code, typed: lower case, spaces. A wrong password never reaches the host's list.
    await third.evaluate(
      (c) => (window as any).mochiCollab.join(c.toLowerCase().replace(/-/g, ' '), 'wrong'),
      code,
    );
    await expect
      .poll(async () => (await session(third))?.message)
      .toBe('The host didn’t let you in.');
    expect(await knocks(host)).toBe(0);
    await expect
      .poll(() => host.evaluate(() => (window as any).mochiCollab.session.wrongPasswords))
      .toBe(1);
    // No password at all: the same.
    await third.evaluate((c) => (window as any).mochiCollab.join(c), code);
    await expect
      .poll(() => host.evaluate(() => (window as any).mochiCollab.session.wrongPasswords))
      .toBe(2);
    // The right one: asks, and is let in.
    await third.evaluate((c) => (window as any).mochiCollab.join(c, 'mochi-pw'), code);
    await expect.poll(() => knocks(host)).toBe(1);
    expect((await session(host))!.knocks[0]).toMatchObject({ name: 'Ume', valid: true });
    await admitFirst(host);
    await expect.poll(async () => (await session(third))?.status).toBe('member');
  });

  it('retires the old link when the host makes a new one', async () => {
    const old = (await session(host))!.link!;
    const fresh = await host.evaluate(() => (window as any).mochiCollab.newLink());
    expect(fresh.invitation).not.toBe(old);
    await guest.evaluate((l) => (window as any).mochiCollab.join(l, 'mochi-pw'), old);
    await expect
      .poll(async () => (await session(guest))?.message)
      .toBe('That invitation was replaced by a new one: ask the host for the new link.');
    await guest.evaluate((l) => (window as any).mochiCollab.join(l, 'mochi-pw'), fresh.invitation);
    await expect.poll(() => knocks(host)).toBe(1);
    await admitFirst(host);
    await expect.poll(async () => (await session(guest))?.status).toBe('member');
    // Ume, let in with the old link, stays.
    expect((await person(host, 'Ume'))?.name).toBe('Ume');
    await expect
      .poll(async () => (await person(guest, 'Ume'))?.connection, { timeout: 30_000 })
      .toBe('connected');
  });

  it('chats with everyone, within the limits, ignoring someone blocked, and keeps nothing after', async () => {
    const chat = (p: Page) =>
      p.evaluate(() =>
        (window as any).mochiCollab.state().chat.map((m: any) => `${m.name}: ${m.text}`),
      );
    await expect
      .poll(async () => (await person(host, 'Kiri'))?.connection, { timeout: 30_000 })
      .toBe('connected');
    expect(await host.evaluate(() => (window as any).mochiCollab.chat('Hello, both of you!'))).toBe(
      true,
    );
    await expect.poll(() => chat(guest)).toContain('Hana: Hello, both of you!');
    await expect.poll(() => chat(third)).toContain('Hana: Hello, both of you!');
    // Through the agent API too.
    await guest.evaluate(() => (window as any).mochiStudio.run('collab_chat', { text: 'Hi!' }));
    await expect.poll(() => chat(host)).toContain('Kiri: Hi!');
    // Limits: 500 characters, and 5 messages in 10 seconds.
    expect(await third.evaluate(() => (window as any).mochiCollab.chat('x'.repeat(501)))).toBe(
      false,
    );
    const sent = await third.evaluate(() =>
      [1, 2, 3, 4, 5, 6].map((i) => (window as any).mochiCollab.chat(`m${i}`)),
    );
    expect(sent).toEqual([true, true, true, true, true, false]);
    await expect.poll(() => chat(host)).toContain('Ume: m5');
    expect(await chat(host)).not.toContain('Ume: m6');
    // Blocked here: their messages are ignored here only.
    const k = (await person(host, 'Kiri'))!;
    await host.evaluate((id) => (window as any).mochiCollab.block(id, true), k.id);
    await guest.evaluate(() => (window as any).mochiCollab.chat('Can you hear me?'));
    await expect.poll(() => chat(third)).toContain('Kiri: Can you hear me?');
    await new Promise((r) => setTimeout(r, 500));
    expect(await chat(host)).not.toContain('Kiri: Can you hear me?');
    // The session ends: nothing of it is kept.
    await host.evaluate(() => (window as any).mochiCollab.leave());
    await expect
      .poll(async () => (await session(third))?.status, { timeout: 15_000 })
      .toBe('ended');
    expect(await chat(third)).toEqual([]);
    expect(await chat(host)).toEqual([]);
  });
});

describe('collaboration through a relay only (“Hide my address”)', () => {
  it('asks WebRTC for relay candidates only, with the server’s short-lived credentials', async () => {
    const relayed = await startSignalingServer({
      log: () => {},
      turn: { urls: ['turn:127.0.0.1:3478'], secret: 'test-secret' },
    });
    try {
      for (const p of [host, guest])
        await p.evaluate(
          (server) => (window as any).mochiStudio.setCollabSettings({ server, hideAddress: true }),
          relayed.wsUrl,
        );
      await host.evaluate(() => (window as any).mochiCollab.host());
      await expect.poll(async () => (await session(host))?.status).toBe('hosting');
      await guest.evaluate(
        (l) => (window as any).mochiCollab.join(l),
        (await session(host))!.link!,
      );
      await expect.poll(async () => (await session(host))?.knocks.length).toBe(1);
      await host.evaluate(() => {
        const s = (window as any).mochiCollab.session;
        s.admit([...s.knocks.keys()][0]);
      });
      await expect.poll(async () => (await session(guest))?.status).toBe('member');
      const hostId = (await session(host))!.you;
      // No TURN server runs here, so the connection itself can't complete; its setup is what's checked.
      await expect
        .poll(() =>
          guest.evaluate((id) => (window as any).mochiCollab.session.linkConfig(id), hostId),
        )
        .toMatchObject({
          iceTransportPolicy: 'relay',
          iceServers: [
            {
              urls: ['turn:127.0.0.1:3478'],
              username: expect.stringMatching(/^\d+:/),
              credential: expect.any(String),
            },
          ],
        });
      await host.evaluate(() => (window as any).mochiCollab.leave());
    } finally {
      await relayed.close();
    }
  });

  it('says so, and doesn’t connect, when the server has no relay', async () => {
    for (const p of [host, guest])
      await p.evaluate(
        (server) => (window as any).mochiStudio.setCollabSettings({ server, hideAddress: true }),
        server.wsUrl,
      );
    await host.evaluate(() => (window as any).mochiCollab.host());
    await expect.poll(async () => (await session(host))?.status).toBe('hosting');
    await guest.evaluate((l) => (window as any).mochiCollab.join(l), (await session(host))!.link!);
    await expect.poll(async () => (await session(host))?.knocks.length).toBe(1);
    await host.evaluate(() => {
      const s = (window as any).mochiCollab.session;
      s.admit([...s.knocks.keys()][0]);
    });
    await expect.poll(async () => (await person(guest, 'Hana'))?.error).toMatch(/offers no relay/);
    expect((await person(guest, 'Hana'))!.connection).toBe('failed');
    await host.evaluate(() => (window as any).mochiCollab.leave());
  });
});

describe('collaboration with no server set', () => {
  it('ships with none: the tab says one is needed, and shows the hosting guide and the terms', async () => {
    const ctx = await H.browser.newContext({ viewport: { width: 1000, height: 700 } });
    const p = await ctx.newPage();
    await p.goto(H.url);
    await p.waitForFunction(() => 'mochiStudio' in window && 'mochiCollab' in window);
    expect(await p.evaluate(() => (window as any).mochiStudio.app.collab.server)).toBe('');
    const note = p.locator('#collab-no-server');
    await expect.poll(() => note.textContent()).toContain('A signaling server address is needed');
    expect(await p.locator('#collab-host').isDisabled()).toBe(true);
    // Bundled with the app: no web address, no network.
    await p.evaluate(() => (document.querySelector('#collab-hosting') as HTMLElement).click());
    const doc = p.locator('dialog.doc-dialog');
    await expect.poll(() => doc.locator('pre').textContent()).toContain('npm run collab:server');
    expect(await doc.locator('h2').textContent()).toBe('Hosting a server');
    await doc.locator('.doc-close').click();
    await expect.poll(() => p.locator('dialog.doc-dialog').count()).toBe(0);
    await p.evaluate(() => (document.querySelector('#collab-terms') as HTMLElement).click());
    await expect
      .poll(() => p.locator('dialog.doc-dialog pre').textContent())
      .toContain('You are responsible for');
    expect(await p.locator('dialog.doc-dialog pre').textContent()).toContain(
      'Video only is the default',
    );
    await p.locator('dialog.doc-dialog .doc-close').click();
    await p.evaluate(() => (document.querySelector('#collab-privacy') as HTMLElement).click());
    await expect
      .poll(() => p.locator('dialog.doc-dialog pre').textContent())
      .toContain('What the server sees');
    await ctx.close();
  });
});
