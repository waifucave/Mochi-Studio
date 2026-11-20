import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron, type ElectronApplication, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SpoutAddon } from '../../desktop/spout.ts';
import { syntheticModelZip } from './harness';

/**
 * Spout2 output, on Windows: the desktop app sends its outputs
 * as Spout2 senders, and a Spout2 receiver here (the addon's own) reads
 * them back. Run on the Windows runner with MOCHI_SPOUT_TEST=1, after
 * `npm run fetch:spout`, `npm run build:spout` and `npm run desktop:build`.
 *
 * The model's body is tinted to half opacity, so its pixels show whether the
 * color is premultiplied: (240, 180, 150) at alpha 0.5 is sent as
 * (120, 90, 75, 128).
 */
const run = !!process.env.MOCHI_SPOUT_TEST && process.platform === 'win32';
const require = createRequire(import.meta.url);
const addon: SpoutAddon | undefined = run
  ? (require('../../native/spout/build/Release/mochi_spout.node') as SpoutAddon)
  : undefined;
const home = mkdtempSync(join(tmpdir(), 'mochi-spout-'));
const port = 47_900 + Math.floor(Math.random() * 90);
const W = 640;
const H = 360;
/** The body, right of the middle (the model is turned: ParamAngleX 30 slides it right). */
const BODY_RIGHT = { x: 0.38, y: 0.1 };
/** Its mirror image, left of the middle: no body there. */
const EMPTY_LEFT = { x: -0.38, y: 0.1 };
let app: ElectronApplication;
let win: Page;

async function launch(): Promise<ElectronApplication> {
  const electron = (await import('electron')).default as unknown as string;
  return _electron.launch({
    executablePath: electron,
    args: ['desktop/dist/app'],
    env: {
      ...process.env,
      MOCHI_STUDIO_PORT: String(port),
      MOCHI_STUDIO_BRIDGE_HOME: home,
      MOCHI_STUDIO_USER_DATA: join(home, 'app-data'),
    } as Record<string, string>,
  });
}

const senders = () => addon!.senders().filter((n) => n.startsWith('MochiStudio'));

/** The app's own view of its senders (for messages). */
const appSpout = () =>
  win
    ?.evaluate(async () => {
      const s = (window as any).mochiStudio;
      await s.refreshSpout();
      return s.spoutStatus().outputs;
    })
    .catch((e: Error) => e.message);

/** Waits for a frame of the sender with content (the receiver's first reads are empty). */
async function frame(name: string, w = W, h = H) {
  const r = new addon!.Receiver(name);
  try {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const f = r.receive();
      if (f && f.width === w && f.height === h && f.data.some((v) => v !== 0)) return f;
      if (Date.now() > deadline)
        throw new Error(
          `no frame from ${name} (last: ${JSON.stringify(f && { w: f.width, h: f.height })}; senders: ${JSON.stringify(senders())}; app: ${JSON.stringify(await appSpout())})`,
        );
      await new Promise((res) => setTimeout(res, 100));
    }
  } finally {
    r.release();
  }
}

/** The RGBA at a pixel of a received frame (the receiver gives the texture's order: BGRA here). */
const px = (f: { width: number; format: number; data: Buffer }, x: number, y: number): number[] => {
  const o = (Math.round(y) * f.width + Math.round(x)) * 4;
  const [a, b, c, d] = [f.data[o]!, f.data[o + 1]!, f.data[o + 2]!, f.data[o + 3]!];
  return f.format === 87 ? [c, b, a, d] : [a, b, c, d];
};
const near = (a: number[], b: number[], tol = 8) => a.every((v, i) => Math.abs(v - b[i]!) <= tol);

/** Where a model point is drawn in an output's page (CSS pixels = frame pixels at scale 1). */
async function at(name: string, p: { x: number; y: number }): Promise<{ x: number; y: number }> {
  const page = app.windows().find((w) => w.url().includes(`spout=${name}`));
  if (page)
    return page.evaluate((p) => (window as any).mochiOutput.runtime.modelToPage(p.x, p.y), p);
  // Not listed (a hidden offscreen window): the fitted view of the square synthetic model,
  // 95% of the shorter side (Mochi2D's default fit), centred, y up.
  const k = 0.95 * Math.min(W, H);
  return { x: W / 2 + p.x * k, y: H / 2 - p.y * k };
}

/** CPU of all the app's processes over some seconds, in percent of one core. */
async function cpu(seconds: number): Promise<Record<string, number>> {
  await app.evaluate(({ app }) => app.getAppMetrics());
  await new Promise((r) => setTimeout(r, seconds * 1000));
  const m = await app.evaluate(({ app }) =>
    app.getAppMetrics().map((p) => ({ type: p.type, cpu: p.cpu.percentCPUUsage })),
  );
  const out: Record<string, number> = {};
  for (const p of m) out[p.type] = Math.round(((out[p.type] ?? 0) + p.cpu) * 10) / 10;
  out.total = Math.round(m.reduce((a, p) => a + p.cpu, 0) * 10) / 10;
  return out;
}

beforeAll(async () => {
  if (!run) return;
  app = await launch();
  win = await app.firstWindow();
  await win.waitForFunction(() => (window as any).mochiAgentLink?.state === 'connected', null, {
    timeout: 60_000,
  });
  const zip = join(home, 'Test.zip');
  writeFileSync(zip, syntheticModelZip());
  await win.locator('#model-zip').setInputFiles(zip);
  await win.waitForFunction(() => (window as any).mochiStudio.settings !== undefined);
  await win.evaluate(() => {
    const s = (window as any).mochiStudio;
    s.runtime.setEffect?.('breath', false);
    s.setOverrides({ ParamAngleX: 30, ParamMouthOpenY: 0 });
    s.setModelTints([['ArtMeshBody', [1, 1, 1, 0.5]]]);
  });
}, 120_000);
afterAll(async () => {
  await app?.close();
});

describe.skipIf(!run)('Spout2 output (Windows)', () => {
  it('sends two outputs as MochiStudio and MochiStudio2, premultiplied, transparent and mirrored', async () => {
    await expect
      .poll(() =>
        win.evaluate(async () => {
          const s = (window as any).mochiStudio;
          await s.refreshSpout();
          return s.spoutStatus();
        }),
      )
      .toMatchObject({ available: true });
    await win.evaluate(
      ({ W, H }) =>
        (window as any).mochiStudio.setSpout({
          outputs: [
            { enabled: true, mirror: false, size: { width: W, height: H } },
            { enabled: true, mirror: true, size: { width: W, height: H } },
          ],
        }),
      { W, H },
    );
    await expect
      .poll(senders, { timeout: 30_000 })
      .toEqual(expect.arrayContaining(['MochiStudio', 'MochiStudio2']));
    const plain = await frame('MochiStudio');
    // The sender's texture is BGRA (DXGI_FORMAT_B8G8R8A8_UNORM), what Spout2 receivers expect.
    expect(plain.format).toBe(87);
    const body = await at('MochiStudio', BODY_RIGHT);
    const empty = await at('MochiStudio', EMPTY_LEFT);
    // The tinted body: premultiplied (straight would be 240, 180, 150 at 128).
    expect(px(plain, body.x, body.y), 'premultiplied body').toSatisfy((c: number[]) =>
      near(c, [120, 90, 75, 128]),
    );
    // No background: transparent black.
    expect(px(plain, 2, 2)).toEqual([0, 0, 0, 0]);
    expect(px(plain, empty.x, empty.y)).toEqual([0, 0, 0, 0]);
    // The mirrored output: the body on the other side.
    const mirrored = await frame('MochiStudio2');
    expect(px(mirrored, W - 1 - body.x, body.y), 'mirrored body').toSatisfy((c: number[]) =>
      near(c, [120, 90, 75, 128]),
    );
    expect(px(mirrored, W - 1 - empty.x, empty.y)).toEqual([0, 0, 0, 0]);
    // The state in the agent API.
    const state = await win.evaluate(async () => {
      const s = (window as any).mochiStudio;
      await s.refreshSpout();
      return s.spoutStatus();
    });
    expect(state.outputs).toMatchObject([
      { name: 'MochiStudio', active: true, width: W, height: H, mirror: false },
      { name: 'MochiStudio2', active: true, width: W, height: H, mirror: true },
    ]);
    console.log(
      'Spout2 path chosen:',
      state.outputs.map((o: any) => `${o.name}: ${o.path}`),
    );
  });

  it('releases a sender that is turned off, and follows a size change', async () => {
    await win.evaluate(
      ({ W, H }) =>
        (window as any).mochiStudio.setSpout({
          outputs: [
            { enabled: true, mirror: false, size: { width: W / 2, height: H / 2 } },
            { enabled: false, mirror: true },
          ],
        }),
      { W, H },
    );
    await expect.poll(senders, { timeout: 15_000 }).toEqual(['MochiStudio']);
    await frame('MochiStudio', W / 2, H / 2);
  });

  /** Records a result at once (console and file), so a later step that hangs loses nothing. */
  const record = (results: Record<string, unknown>, key: string, value: unknown) => {
    results[key] = value;
    console.log(`Spout2 ${key}:`, JSON.stringify(value));
    mkdirSync('test-results', { recursive: true });
    writeFileSync('test-results/spout-cost.json', JSON.stringify(results, null, 2));
  };
  const costs: Record<string, unknown> = {};
  /**
   * A call into the control window with a deadline: on the runner (no GPU)
   * the window once stopped answering while an output ran, and the job hung
   * until its timeout. Now the stall is recorded, with the main process's
   * view, and the test fails at that step.
   */
  const page = async <T>(what: string, f: () => Promise<T>, ms = 20_000): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`the control window did not answer (${what}) in ${ms / 1000} s`)),
        ms,
      );
    });
    try {
      return await Promise.race([f(), late]);
    } catch (e) {
      const main = await app
        .evaluate(({ app }) =>
          app.getAppMetrics().map((p) => ({ type: p.type, cpu: p.cpu.percentCPUUsage })),
        )
        .catch((x: Error) => x.message);
      record(costs, `stalled:${what}`, {
        error: (e as Error).message,
        metrics: main,
        senders: senders(),
      });
      throw e;
    } finally {
      clearTimeout(timer);
    }
  };
  const set = (outputs: unknown[]) =>
    page('setSpout', () =>
      win.evaluate((o) => (window as any).mochiStudio.setSpout({ outputs: o }), outputs),
    );
  const state = () =>
    page('state', () =>
      win.evaluate(async () => {
        const s = (window as any).mochiStudio;
        await s.refreshSpout();
        return s.spoutStatus().outputs[0];
      }),
    );
  const setPath = (path: 'auto' | 'readback') =>
    page(`path ${path}`, () =>
      win.evaluate((path) => {
        const s = (window as any).mochiStudio;
        s.spoutPath = path;
        s.applySpout();
      }, path),
    );

  /**
   * Minimizes the control window, or shows it again. The runner has no graphics card: the
   * control window drawing its stage in software kept the GPU process near its limit, and with
   * an output too, the window stopped answering. Minimized, it still runs every frame (and the
   * outputs with it) without drawing, as when someone streams with it minimized, so the numbers
   * are the outputs' own cost.
   */
  const minimize = (on: boolean) =>
    app.evaluate(({ BrowserWindow }, on) => {
      const w = BrowserWindow.getAllWindows().find(
        (x) => !x.webContents.getURL().includes('spout='),
      );
      if (on) w?.minimize();
      else w?.restore();
    }, on);

  it('measures the cost of both paths', { timeout: 180_000 }, async () => {
    // A moving head, as in a stream: the output repaints every frame (a still page paints
    // only when something changes, which would cost nothing to send).
    await win.evaluate(() => {
      const w = window as any;
      const t0 = performance.now();
      w.spoutFeed = setInterval(() => {
        const s = (performance.now() - t0) / 1000;
        const yaw = Math.sin(s * 1.5) * 0.3;
        const c = Math.cos(yaw);
        const n = Math.sin(yaw);
        w.mochiStudio.feedFrame({
          t: performance.now(),
          face: true,
          blendshapes: { jawOpen: (Math.sin(s * 4) + 1) / 2 },
          matrix: [c, 0, -n, 0, 0, 1, 0, 0, n, 0, c, 0, 0, 0, -40, 1],
        });
      }, 33);
      w.mochiStudio.setOverrides({});
    });
    await set([{ enabled: false, mirror: false }]);
    await expect.poll(senders, { timeout: 15_000 }).toEqual([]);
    await minimize(true);
    record(costs, 'off', await cpu(8));
    // The cost, at a size that fits the runner's screen (1024 x 720).
    await set([{ enabled: true, mirror: false, size: { width: 960, height: 540 } }]);
    await frame('MochiStudio', 960, 540);
    record(costs, 'auto', await cpu(8));
    const auto = await state();
    record(costs, 'autoState', auto);
    expect(auto).toMatchObject({ width: 960, height: 540, active: true });
    // The frames sent in those seconds: the readback path keeps to READBACK_FPS.
    const before = auto.frames as number;
    await new Promise((r) => setTimeout(r, 4000));
    const after = (await state()).frames as number;
    record(costs, 'autoFps', Math.round(((after - before) / 4) * 10) / 10);
    await setPath('readback');
    await expect.poll(async () => (await state())?.path, { timeout: 15_000 }).toBe('readback');
    await frame('MochiStudio', 960, 540);
    record(costs, 'readback', await cpu(8));
    record(costs, 'readbackState', await state());
    await setPath('auto');
    await minimize(false);
  });

  // Larger than the screen: recorded, not required (the runner's screen is 1024 x 720).
  it('tries an output larger than the screen', { timeout: 120_000 }, async () => {
    await minimize(true);
    for (const noScale of [true, false]) {
      const key = noScale ? 'largeOwnSize' : 'largeScaled';
      await page('noScale', () =>
        win.evaluate((n) => {
          (window as any).mochiStudio.spoutNoScale = n;
        }, noScale),
      );
      await set([{ enabled: false, mirror: false }]);
      await expect.poll(senders, { timeout: 15_000 }).toEqual([]);
      await set([{ enabled: true, mirror: false, size: { width: 1920, height: 1080 } }]);
      const got = await frame('MochiStudio', 1920, 1080).then(
        (f) => ({ ok: true, size: [f.width, f.height] }),
        (e: Error) => ({ ok: false, error: e.message.slice(0, 400) }),
      );
      record(costs, key, { ...got, state: await state() });
    }
    await page('stop the feed', () => win.evaluate(() => clearInterval((window as any).spoutFeed)));
    await set([{ enabled: false, mirror: false }]);
    await expect.poll(senders, { timeout: 15_000 }).toEqual([]);
    await minimize(false);
  });
});
