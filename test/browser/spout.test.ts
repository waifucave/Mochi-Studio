import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

const probeFile = join(home, 'probe.jsonl');

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
      // The app's probe of its window, written by the app itself (desktop/windowProbe.ts).
      MOCHI_PROBE_FILE: probeFile,
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

/** How many frames the app says an output has sent (0 if it can't tell). */
async function sent(name: string): Promise<number> {
  const outputs = await appSpout();
  if (!Array.isArray(outputs)) return 0;
  return (
    (outputs as Array<{ name: string; frames?: number }>).find((o) => o.name === name)?.frames ?? 0
  );
}

/**
 * Waits for a frame of the sender with content (the receiver's first reads are empty), once
 * the app has sent ten frames: a new output window's very first frames can come before its
 * page has drawn (once, on the runner, opaque white). A frame read after that is the page's.
 */
async function frame(name: string, w = W, h = H) {
  for (const settle = Date.now() + 20_000; (await sent(name)) < 10 && Date.now() < settle;)
    await new Promise((res) => setTimeout(res, 100));
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

/** A promise, or an error once `ms` have passed without an answer. */
const limit = <T>(what: string, p: Promise<T>, ms = 30_000): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>(
      (_, reject) =>
        (timer = setTimeout(() => reject(new Error(`${what}: no answer in ${ms / 1000} s`)), ms)),
    ),
  ]).finally(() => clearTimeout(timer));
};

/**
 * Code run in the control window through the app's own channel (from its main process). On the
 * runner, Playwright's DevTools connection to the window stopped answering for seconds to
 * minutes at times while the window answered the app's own calls in milliseconds.
 */
const inWindow = <T>(code: string, ms = 30_000): Promise<T> =>
  limit(
    code.slice(0, 60),
    app.evaluate((_electron, code) => {
      const wc = (globalThis as any).__mochiSpout.probe.target();
      return wc.mainFrame.executeJavaScript(code);
    }, code) as Promise<T>,
    ms,
  );

/** Where the first model load got to, from the window (for a load that does not finish). */
const LOAD_STATE = `JSON.stringify({
  loaded: window.mochiStudio?.settings !== undefined,
  graphicsLost: window.mochiStudio?.runtime?.graphicsLost,
  startup: window.mochiStudio?.startup,
  files: document.getElementById('model-zip')?.files?.length,
  url: location.href,
  readyState: document.readyState,
  log: window.mochiLog?.lines().slice(-12),
})`;

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
  // Asked through the app's own channel: in 3 of 31 runs, a wait through Playwright's (as the
  // trial's measures once were) had no answer in 60 or 120 s here, with nothing to show why.
  const since = Date.now();
  let state: { loaded?: boolean } & Record<string, unknown> = {};
  let asked = 0;
  let unanswered = 0;
  while (Date.now() - since < 120_000) {
    asked++;
    try {
      state = JSON.parse(await inWindow<string>(LOAD_STATE, 10_000));
      if (state.loaded) break;
    } catch {
      unanswered++;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log(
    `Spout2 first load: ${JSON.stringify({
      s: Math.round((Date.now() - since) / 100) / 10,
      asked,
      unanswered,
      startup: state.startup,
      // Whether the window's graphics context was lost (and is back), from the app's log.
      graphics: ((state.log as string[] | undefined) ?? []).filter((l) =>
        l.includes('graphics context'),
      ),
    })}`,
  );
  if (!state.loaded) {
    // Whether Playwright's own connection answers, beside the app's.
    const devtools = await limit(
      'devtools',
      win.evaluate(() => (window as any).mochiStudio?.settings !== undefined),
      10_000,
    ).catch((e: Error) => e.message);
    throw new Error(
      `The model did not load in 120 s: ${JSON.stringify({ ...state, asked, unanswered, devtools })}`,
    );
  }
  await inWindow(`(() => {
    const s = window.mochiStudio;
    s.runtime.setEffect?.('breath', false);
    s.setOverrides({ ParamAngleX: 30, ParamMouthOpenY: 0 });
    s.setModelTints([['ArtMeshBody', [1, 1, 1, 0.5]]]);
    return 1;
  })()`);
}, 240_000);
// (An app stalled by the large trial may not close; the job ends it.)
afterAll(async () => {
  await Promise.race([
    app?.close().catch(() => undefined),
    new Promise((r) => setTimeout(r, 20_000)),
  ]);
}, 30_000);

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
      // The app's own window: the one its probe asks (other hidden windows can come first).
      const wc = (globalThis as any).__mochiSpout?.probe?.target();
      const w = wc ? BrowserWindow.fromWebContents(wc) : null;
      if (on) w?.minimize();
      else w?.restore();
    }, on);

  /** What the main process measures: its loop's lag, and each output's paints and their costs. */
  const perfSummary = () =>
    app.evaluate(() => {
      const p = (globalThis as any).__mochiSpout?.perf();
      if (!p) return null;
      const outputs: Record<string, unknown> = {};
      for (const [n, o] of Object.entries(p.outputs) as Array<[string, any]>)
        outputs[n] = {
          paints: o.paints,
          frames: o.frames,
          copyAvg: o.paints ? Math.round(o.copyMs / o.paints) : 0,
          copyMax: Math.round(o.copyMaxMs),
          sendAvg: o.paints ? Math.round(o.sendMs / o.paints) : 0,
          sendMax: Math.round(o.sendMaxMs),
          fps: o.fps,
          held: o.held,
        };
      return { lagMaxMs: p.lagMaxMs, windowMaxMs: p.windowMaxMs, outputs };
    });

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
    record(costs, 'autoPerf', await perfSummary());
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
    record(costs, 'readbackPerf', await perfSummary());
    await setPath('auto');
    await minimize(false);
  });

  // Larger than the screen (the runner's is 1024 × 720), with the control window shown. Drawing
  // 1920 × 1080 in software takes the graphics process the window shares; the output's frame
  // rate follows (src/core/frameGovernor.ts).
  //
  // Measured by the app itself: its main process asks the window four times a second, as it does
  // to drive it, and writes each answer to a file (MOCHI_PROBE_FILE) with what each output sent.
  // The test reads that file, so its own connections to the app (DevTools, the main process's
  // inspector), which on this runner stopped answering for seconds and minutes, are not the
  // measure. Required: the window answers within a second throughout and goes on drawing; an
  // output that sends less than half its allowed rate is held (the person is told). Reported:
  // the rate it sends at.
  it(
    'keeps the window answering with an output larger than the screen',
    { timeout: 240_000 },
    async () => {
      const steps: Array<[number, string]> = [];
      const t0 = Date.now();
      const step = (what: string) => {
        steps.push([Math.round((Date.now() - t0) / 100) / 10, what]);
        record(costs, 'largeSteps', steps);
      };
      const setOutputs = (outputs: unknown[]) =>
        inWindow(
          `Promise.resolve(window.mochiStudio.setSpout({ outputs: ${JSON.stringify(outputs)} })).then(() => 1)`,
        );
      type Line = {
        t: number;
        ms: number;
        frames?: number;
        extra?: Array<{
          name: string;
          frames: number;
          fps: number;
          sentFps: number;
          held: boolean;
        }>;
      };
      const lines = (): Line[] => {
        try {
          return readFileSync(probeFile, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l) as Line)
            .filter((l) => l.t >= t0);
        } catch {
          return [];
        }
      };
      const output = (l: Line | undefined) => l?.extra?.find((o) => o.name === 'MochiStudio');
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      let result: Record<string, unknown> = {};
      let onAt = Infinity;
      let controlFrom = Infinity;
      let controlTo = -Infinity;
      let measuredTo = Infinity;
      try {
        step('show the window');
        await limit('show the window', minimize(false));
        step('switch the output off');
        await setOutputs([{ enabled: false, mirror: false }]);
        // The control: 10 s with the window shown and no output (the probe runs all the same).
        controlFrom = Date.now();
        await sleep(10_000);
        controlTo = Date.now();
        step('1920 × 1080 on');
        onAt = Date.now();
        await setOutputs([{ enabled: true, mirror: false, size: { width: 1920, height: 1080 } }]);
        // 5 s for it to start, then 20 s of a moving head: what the app wrote.
        await sleep(5000);
        const from = Date.now();
        step('measure');
        await sleep(20_000);
        measuredTo = Date.now();
        const span = lines().filter((l) => l.t >= from && output(l));
        const first = output(span[0]);
        const last = output(span.at(-1));
        const secs = span.length > 1 ? (span.at(-1)!.t - span[0]!.t) / 1000 : 0;
        result = {
          sentFps:
            first && last && secs > 0
              ? Math.round(((last.frames - first.frames) / secs) * 10) / 10
              : 0,
          allowedFps: last?.fps,
          appSentFps: last?.sentFps,
          held: !!last?.held,
          samples: span.length,
        };
        step('read a frame');
        if ((result.sentFps as number) > 0) {
          // A receiver reads it (directly: not through the app, whose test connections stall).
          const r = new addon!.Receiver('MochiStudio');
          try {
            let f: { width: number; height: number; data: Buffer } | null = null;
            for (const end = Date.now() + 30_000; Date.now() < end; await sleep(100)) {
              const g = r.receive();
              if (g && g.width === 1920 && g.data.some((v: number) => v !== 0)) {
                f = g;
                break;
              }
              if (g) f = g;
            }
            result.size = f ? [f.width, f.height] : 'no frame in 30 s';
          } finally {
            r.release();
          }
        }
        record(costs, 'large', result);
      } finally {
        step('stop');
        await inWindow('clearInterval(window.spoutFeed), 1').catch(() => undefined);
        await setOutputs([{ enabled: false, mirror: false }]).catch(() => undefined);
        step('done');
      }
      // From the moment the large output was switched on (the probe runs while an output does).
      const all = lines().filter((l) => l.t >= onAt && l.t <= measuredTo);
      const ms = all.map((l) => l.ms);
      const frames = all.map((l) => l.frames).filter((x): x is number => typeof x === 'number');
      // The longest time without a sample (the probe asks four times a second): a main process
      // or window that stopped would show as a gap.
      const gaps = all.slice(1).map((l, i) => l.t - all[i]!.t);
      const window = {
        samples: all.length,
        worstMs: Math.max(0, ...ms),
        longestGapMs: Math.max(0, ...gaps),
        mainLateMs: Math.max(0, ...all.map((l) => (l as { late?: number }).late ?? 0)),
        windowFps:
          frames.length > 1 && all.length > 1
            ? Math.round(
                ((frames.at(-1)! - frames[0]!) / ((all.at(-1)!.t - all[0]!.t) / 1000)) * 10,
              ) / 10
            : null,
      };
      // The same measures in the control (no output).
      const ctl = lines().filter((l) => l.t >= controlFrom && l.t <= controlTo);
      const ctlGaps = ctl.slice(1).map((l, i) => l.t - ctl[i]!.t);
      const control = {
        samples: ctl.length,
        worstMs: Math.max(0, ...ctl.map((l) => l.ms)),
        longestGapMs: Math.max(0, ...ctlGaps),
        mainLateMs: Math.max(0, ...ctl.map((l) => (l as { late?: number }).late ?? 0)),
      };
      // The window's own measure: how late its timers ran (it handles clicks and draws), per
      // second, from the window itself; the probe's samples above are timed from the main
      // process, which on this runner is itself late by seconds at times (run 147: 3.4 s, with
      // the output paused, while the window drew 107 frames).
      const own = async (from: number, to: number) =>
        JSON.parse(
          await inWindow<string>(
            `JSON.stringify(window.mochiPageLateness.between(${from}, ${to}))`,
          ),
        ) as { worstMs: number; seconds: number };
      const windowOwn = await own(onAt, measuredTo);
      const controlOwn = await own(controlFrom, controlTo);
      Object.assign(window, { ownWorstMs: windowOwn.worstMs, ownSeconds: windowOwn.seconds });
      Object.assign(control, { ownWorstMs: controlOwn.worstMs, ownSeconds: controlOwn.seconds });
      record(costs, 'largeControl', control);
      record(costs, 'largeWindow', { ...window, lines: all.slice(0, 400) });
      console.log(
        `Spout2 at 1920 × 1080 on this runner: ${result.sentFps} frames a second sent (allowed ${result.allowedFps}${result.held ? ', held' : ''}); the window's own timers were at most ${windowOwn.worstMs} ms late (without an output ${controlOwn.worstMs} ms) and it drew ${window.windowFps} frames a second; asked from the main process, it answered within ${window.worstMs} ms (${window.samples} samples, the main process late by up to ${window.mainLateMs} ms, without an output ${control.mainLateMs} ms).`,
      );
      // Required: the window answers within a second throughout, by its own measure, over the
      // whole measured time (a second with no timer at all would be missing).
      const span = Math.floor((measuredTo - onAt) / 1000);
      expect(windowOwn.seconds, 'the window measured itself throughout').toBeGreaterThanOrEqual(
        span - 1,
      );
      expect(windowOwn.worstMs, JSON.stringify(windowOwn)).toBeLessThan(1000);
      // Recorded, not required: the round trip from the main process, and the main process's own
      // gaps. On this runner (no graphics card, the window shown) the main process is late by a
      // second or more at times, with the output paused and without any output (the control).
      expect(frames.at(-1)! - frames[0]!, 'the window went on drawing').toBeGreaterThan(0);
      // When it sends frames at all, they have the full size (drawn smaller and scaled up).
      if ((result.sentFps as number) >= 1) expect(result.size).toEqual([1920, 1080]);
      // However few frames it gets, the person is told: below half its allowed rate, it is held.
      if ((result.sentFps as number) < (result.allowedFps as number) / 2)
        expect(result.held, JSON.stringify(result)).toBe(true);
    },
  );
});
