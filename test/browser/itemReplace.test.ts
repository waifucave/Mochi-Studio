import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext, Page, Request } from 'playwright-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { staticCatalog } from '../../bridge/src/mcp.ts';
import { BridgeServer } from '../../bridge/src/server.ts';
import { BridgeStore } from '../../bridge/src/store.ts';
import { syntheticModelFiles } from '../support/syntheticModel';
import { startHarness, syntheticItemZip, syntheticModelZip, type Harness } from './harness';

/**
 * An item whose files are replaced (a plugin's brightness redraws a still
 * picture; a collaborator shares another model) stays on the stage as it
 * was until the new files have loaded, in the window and in output views,
 * and views get the new files. Each test holds the new files' load open
 * itself (Mochi2D's `addItem` waits for the test), so no runner's timing
 * decides what a frame shows.
 */
let H: Harness;
let control: Page;
let bridge: BridgeServer;
let obsCtx: BrowserContext;
const errors: string[] = [];

/** Other files for an item: another settings file name, so a view's item tells which it has. */
const CAP = Object.entries(syntheticModelFiles({ name: 'cap', color: [60, 60, 220] })).map(
  ([p, d]) => [`Cap/${p}`, [...d]] as [string, number[]],
);
const STUDIO = '(window).mochiStudio.runtime';
const VIEW = '(window).mochiOutput.runtime';

const addItem = async (n: number) => {
  await control.locator('#item-zip').setInputFiles({
    name: `Hat${n}.zip`,
    mimeType: 'application/zip',
    buffer: Buffer.from(syntheticItemZip()),
  });
  await control.waitForFunction((n) => (window as any).mochiStudio.items.length === n, n);
  return control.evaluate(() => (window as any).mochiStudio.items.at(-1).id as string);
};

/** Replaces item `id`'s files with `CAP` in the window. */
const replaceWithCap = (id: string) =>
  control.evaluate(
    ({ id, files }) =>
      (window as any).mochiStudio.replaceItemFiles(
        id,
        files.map(([p, d]) => [p, new Uint8Array(d)]),
      ) as Promise<void>,
    { id, files: CAP },
  );

/**
 * Makes the next `addItem` of a page's view wait until `release()` (in the
 * page); `window.held` resolves once it has been asked for.
 */
const holdNextLoad = (p: Page, runtime: string) =>
  p.evaluate((runtime) => {
    const view = (0, eval)(runtime).view;
    const orig = view.addItem;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let asked!: () => void;
    (window as any).held = new Promise<void>((r) => (asked = r));
    (window as any).release = release;
    view.addItem = async function (this: unknown, ...args: unknown[]) {
      view.addItem = orig;
      asked();
      await gate;
      return orig.apply(this, args);
    };
  }, runtime);

/**
 * Opens a page at `url` within 120 s; else fails with the requests it still had open (when
 * each began, in ms since `t0`), to tell a page that waits for a file from a page that
 * doesn't get to run. (Under load, a page in a new browser context once asked for its own
 * scripts only 60 s after it was opened.)
 */
const open = async (p: Page, url: string, t0: number) => {
  const pending = new Map<Request, number>();
  const on = (r: Request) => void pending.set(r, Date.now() - t0);
  const off = (r: Request) => void pending.delete(r);
  p.on('request', on);
  p.on('requestfinished', off);
  p.on('requestfailed', off);
  try {
    await p.goto(url, { timeout: 120_000 });
  } catch (e) {
    const open = [...pending].map(([r, t]) => `${t} ms ${r.method()} ${new URL(r.url()).pathname}`);
    throw new Error(
      `${(e as Error).message.split('\n')[0]} (at ${Date.now() - t0} ms)\nrequests still open: ${JSON.stringify(open, null, 1)}`,
    );
  } finally {
    p.off('request', on);
    p.off('requestfinished', off);
    p.off('requestfailed', off);
  }
};

/** Whether the page's held load was asked for within 15 s. */
const loadAsked = (p: Page) =>
  p.evaluate(() =>
    Promise.race([
      (window as any).held.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 15_000)),
    ]),
  );

/** What each of the next `n` frames of a page shows of item `id`. */
const watchFrames = (p: Page, runtime: string, id: string, n: number) =>
  p.evaluate(
    async ({ runtime, id, n }) => {
      const rt = (0, eval)(runtime);
      const seen = [];
      for (let i = 0; i < n; i++) {
        await new Promise((r) => requestAnimationFrame(r));
        const item = rt.itemMap.get(id);
        seen.push({
          drawn: !!item && rt.view.items.includes(item),
          opacity: item?.opacity as number | undefined,
          mirror: item?.mirror as boolean | undefined,
          order: rt.itemOrder() as string[],
        });
      }
      return seen;
    },
    { runtime, id, n },
  );

beforeAll(async () => {
  H = await startHarness();
  bridge = new BridgeServer({
    port: 0,
    store: new BridgeStore(mkdtempSync(join(tmpdir(), 'mochi-bridge-replace-'))),
    catalog: staticCatalog(),
    log: () => undefined,
  });
  await bridge.listen();
  control = await H.context.newPage();
  control.on('pageerror', (e) => errors.push(`control: ${e.message}`));
  await control.goto(H.url);
  await control.waitForFunction(() => 'mochiStudio' in window);
  await control.locator('#model-zip').setInputFiles({
    name: 'Test.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(syntheticModelZip()),
  });
  await control.waitForFunction(() => (window as any).mochiStudio.settings !== undefined);
}, 60_000);
// (Closing a browser context under load once took over a minute.)
afterAll(async () => {
  await obsCtx?.close();
  await bridge?.close();
  await H?.close();
}, 120_000);

describe('an item whose files are replaced', () => {
  // Each test starts with no items, and no load held by one before.
  beforeEach(async () => {
    await control.evaluate(() => {
      (window as any).release?.();
      const s = (window as any).mochiStudio;
      for (const i of [...s.items]) s.removeItem(i.id);
    });
    await control.waitForFunction(() => (window as any).mochiStudio.runtime.items().length === 0);
  });

  it('stays drawn as it was until its new files have loaded, then is swapped in one step', async () => {
    const a = await addItem(1);
    const b = await addItem(2);
    const set = await control.evaluate(
      ({ a, b }) => {
        const rt = (window as any).mochiStudio.runtime;
        rt.setItemOpacity(a, 0.5);
        rt.placeItem(a, { mirror: true, scale: 0.7, x: 0.1 });
        const mesh = rt.artMeshIds()[0] as string;
        rt.setItemSort(a, { below: mesh }, null);
        rt.stackItems([a, b]); // a below b
        return {
          mesh,
          order: rt.itemOrder() as string[],
          placement: rt.items().find((i: any) => i.id === a).placement,
        };
      },
      { a, b },
    );
    expect(set.order).toEqual([a, b]);
    await holdNextLoad(control, STUDIO);
    const done = replaceWithCap(a);
    await control.evaluate(() => (window as any).held);
    // Every frame while the new files load shows the item as it was.
    for (const f of await watchFrames(control, STUDIO, a, 6))
      expect(f).toEqual({ drawn: true, opacity: 0.5, mirror: true, order: [a, b] });
    expect(
      await control.evaluate((a) => (window as any).mochiStudio.runtime.itemOpacity(a), a),
    ).toBe(0.5);
    await control.evaluate(() => (window as any).release());
    await done;
    // The new item has all the old one had, and the old one is gone.
    const after = await control.evaluate((a) => {
      const rt = (window as any).mochiStudio.runtime;
      return {
        name: rt.itemMap.get(a).name as string,
        drawn: rt.view.items.length as number,
        order: rt.itemOrder() as string[],
        opacity: rt.itemOpacity(a) as number,
        placement: rt.items().find((i: any) => i.id === a).placement,
        sort: rt.itemSort(a),
        layoutIds: rt.exportItemLayout().items.map((e: any) => e.id) as string[],
      };
    }, a);
    expect(after).toMatchObject({
      name: expect.stringMatching(/cap\.model3\.json$/),
      drawn: 2,
      order: [a, b],
      opacity: 0.5,
      placement: set.placement,
      sort: { layer: { below: set.mesh }, split: null },
      layoutIds: [a, b],
    });
    for (const f of await watchFrames(control, STUDIO, a, 2))
      expect(f).toEqual({ drawn: true, opacity: 0.5, mirror: true, order: [a, b] });
    // Its layout, saved and applied again, finds it by Mochi Studio's id.
    expect(
      await control.evaluate((a) => {
        const rt = (window as any).mochiStudio.runtime;
        const layout = rt.exportItemLayout();
        rt.setItemOpacity(a, 1);
        rt.applyItemLayout(layout);
        return rt.itemOpacity(a) as number;
      }, a),
    ).toBe(0.5);
  });

  it('stays removed when it is removed while its new files load', async () => {
    const a = await addItem(1);
    await holdNextLoad(control, STUDIO);
    const done = replaceWithCap(a);
    await control.evaluate(() => (window as any).held);
    await control.evaluate((a) => (window as any).mochiStudio.removeItem(a), a);
    await control.evaluate(() => (window as any).release());
    await done;
    expect(
      await control.evaluate(() => {
        const rt = (window as any).mochiStudio.runtime;
        return { items: rt.items().length, drawn: rt.view.items.length };
      }),
    ).toEqual({ items: 0, drawn: 0 });
    // Nor are its new files kept, for views or in the browser's storage.
    expect(
      await control.evaluate(
        (a) => (window as any).mochiStudio.itemFilesOf(a).then((f: unknown) => f ?? null),
        a,
      ),
    ).toBeNull();
  });

  it("reaches output views, which keep it drawn until they've loaded the new files", async () => {
    const a = await addItem(1);
    await control.evaluate((a) => (window as any).mochiStudio.runtime.setItemOpacity(a, 0.5), a);
    const logStart = await control.evaluate(
      () => (window as any).mochiLog.entries.length as number,
    );
    // A view on the browser's channel, and one through the bridge.
    const local = await H.context.newPage();
    local.on('pageerror', (e) => errors.push(`view: ${e.message}`));
    // What each view is told of items, fetches of them, and logs as an error: to tell, if
    // it lacks an item, whether the item was announced, served, loaded or swapped away.
    const t0 = Date.now();
    const seen = { local: [] as string[], remote: [] as string[] };
    const note = (n: 'local' | 'remote', what: string) =>
      seen[n].push(`${Date.now() - t0} ms ${what}`);
    const announced = (
      items: Array<{ id: string; version?: number; files?: unknown[]; paths?: unknown[] }>,
    ) =>
      items.map((i) => `${i.id}@${i.version ?? 0}/${(i.files ?? i.paths ?? []).length}`).join(' ');
    local.on('console', (m) => {
      if (m.type() === 'error') note('local', `error: ${m.text()}`);
      else if (m.text().startsWith('items: ')) note('local', m.text());
    });
    await local.addInitScript(() => {
      const orig = BroadcastChannel.prototype.addEventListener as (...a: unknown[]) => void;
      BroadcastChannel.prototype.addEventListener = function (
        this: BroadcastChannel,
        type: string,
        fn: (e: MessageEvent) => void,
        o?: unknown,
      ) {
        if (type !== 'message') return orig.call(this, type, fn, o);
        const log = (e: MessageEvent): void => {
          const m = e.data;
          if (m?.type === 'items')
            console.log(
              `items: ${m.items.map((i: any) => `${i.id}@${i.version ?? 0}/${i.files.length}`).join(' ')}`,
            );
          fn(e);
        };
        return orig.call(this, type, log, o);
      } as typeof BroadcastChannel.prototype.addEventListener;
    });
    await open(local, new URL('output.html', H.url).href, t0);
    await control.evaluate(
      (u) => (window as any).mochiAgentLink.enableViews(u),
      `ws://127.0.0.1:${bridge.port}`,
    );
    await control.waitForFunction(() => (window as any).mochiAgentLink.state === 'pairing', null, {
      timeout: 20_000,
    });
    await control.evaluate(
      (c) => (window as any).mochiAgentLink.pair(c),
      bridge.store.pairingCode(),
    );
    await control.waitForFunction(
      () => (window as any).mochiAgentLink.state === 'connected',
      null,
      { timeout: 20_000 },
    );
    const url = await control.evaluate(() => (window as any).mochiAgentLink.viewUrl(location.href));
    obsCtx = await H.browser.newContext();
    const remote = await obsCtx.newPage();
    remote.on('pageerror', (e) => errors.push(`bridge view: ${e.message}`));
    remote.on('console', (m) => m.type() === 'error' && note('remote', `error: ${m.text()}`));
    remote.on('websocket', (ws) =>
      ws.on('framereceived', ({ payload }) => {
        try {
          const m = JSON.parse(String(payload));
          if (m.type === 'sync' && m.message?.type === 'itemsRemote')
            note('remote', `items: ${announced(m.message.items)}`);
        } catch {
          /* not JSON */
        }
      }),
    );
    remote.on(
      'response',
      (r) =>
        r.url().includes('/item/') && note('remote', `${r.status()} ${new URL(r.url()).pathname}`),
    );
    remote.on(
      'requestfailed',
      (r) => r.url().includes('/item/') && note('remote', `failed ${new URL(r.url()).pathname}`),
    );
    await open(remote, url, t0);
    /** The window's log about output views since the test began. */
    const viewLog = () =>
      control.evaluate(
        (since) =>
          ((window as any).mochiLog.entries as Array<{ kind: string; text: string }>)
            .slice(since)
            .filter((e) => e.text.includes('output view'))
            .map((e) => `${e.kind}: ${e.text}`),
        logStart,
      );
    /**
     * A view's items, its item's settings file and opacity, and (for a failure) the window's
     * items, the view's model, link, load state, what it saw and the window's log of views.
     */
    const viewState = async (n: 'local' | 'remote', v: Page) => ({
      view: n,
      items: await v.evaluate(() => [...(window as any).mochiOutput.runtime.itemMap.keys()]),
      ...(await v.evaluate((a) => {
        const rt = (window as any).mochiOutput.runtime;
        return {
          name: rt.itemMap.get(a)?.name as string | undefined,
          opacity: rt.itemMap.has(a) ? (rt.itemOpacity(a) as number) : undefined,
        };
      }, a)),
      window: await control.evaluate(() => (window as any).mochiStudio.items.map((i: any) => i.id)),
      ...(await v.evaluate(() => ({
        model: document.body.dataset.model,
        bridge: document.body.dataset.bridge,
      }))),
      status: await control.evaluate(() =>
        [...(window as any).mochiStudio.viewStatus.values()].map((s: any) => s.state),
      ),
      log: await viewLog(),
      seen: seen[n],
    });
    type ViewState = Awaited<ReturnType<typeof viewState>>;
    /**
     * Waits until a view's state passes `ok`; else fails with the whole state (a matcher's
     * diff would show only what it matches).
     */
    const until = async (
      n: 'local' | 'remote',
      v: Page,
      what: string,
      ok: (s: ViewState) => boolean,
      ms: number,
    ) => {
      let state = await viewState(n, v);
      for (const end = Date.now() + ms; !ok(state) && Date.now() < end;) {
        await new Promise((r) => setTimeout(r, 250));
        state = await viewState(n, v);
      }
      expect(ok(state), `the ${n} view, ${what}:\n${JSON.stringify(state, null, 1)}`).toBe(true);
    };
    const views = [
      ['local', local],
      ['remote', remote],
    ] as const;
    for (const [n, v] of views) {
      // Each view has this item, and no other, at the window's opacity.
      await until(n, v, 'with the item', (s) => s.items.join() === a, 60_000);
      await until(n, v, 'with the item', (s) => /hat\.model3\.json$/.test(s.name ?? ''), 1);
      await until(n, v, 'at its opacity', (s) => s.opacity === 0.5, 15_000);
      await holdNextLoad(v, VIEW);
    }
    await replaceWithCap(a);
    for (const [n, v] of views) {
      expect(await loadAsked(v), 'the view loads the new files').toBe(true);
      for (const f of await watchFrames(v, VIEW, a, 4))
        expect(f).toMatchObject({ drawn: true, opacity: 0.5 });
      await v.evaluate(() => (window as any).release());
      await until(
        n,
        v,
        'with the new files',
        (s) => /cap\.model3\.json$/.test(s.name ?? ''),
        30_000,
      );
      for (const f of await watchFrames(v, VIEW, a, 2))
        expect(f).toMatchObject({ drawn: true, opacity: 0.5 });
      expect(await v.evaluate(() => (window as any).mochiOutput.runtime.view.items.length)).toBe(1);
    }
    // No view missed a file and loaded it on a later try (the retries would hide it).
    expect(await viewLog()).toEqual([]);
    // Replaced again: the bridge keeps only the files views can still ask for.
    await control.evaluate(async (a) => {
      const s = (window as any).mochiStudio;
      await s.replaceItemFiles(a, [...(await s.itemFilesOf(a))]);
    }, a);
    const owners = () =>
      [...((bridge as any).cache as Map<string, unknown>).keys()]
        .filter((k) => k.startsWith('item/'))
        .map((k) => decodeURIComponent(k.split('/')[1]!));
    await expect
      .poll(() => owners().length > 0 && owners().every((o) => o === `${a}@2`), {
        timeout: 15_000,
      })
      .toBe(true);
    expect(errors).toEqual([]);
  }, 300_000);
});
