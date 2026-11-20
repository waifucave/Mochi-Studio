/**
 * The frame budget: what a frame costs with a model of
 * a real streaming model's size, in the control window and in an output
 * view, at up to 60 frames a second, with tracking fed at 30.
 *
 * - **Per frame**, in each page: the whole frame callback, and inside it the
 *   time spent in Mochi2D's `advance` (evaluation and drawing calls), by
 *   wrapping the page's own functions.
 * - **CPU:** each Chromium process's CPU time over the run (CDP's
 *   `SystemInfo.getProcessInfo`), as a share of one core.
 * - **Hot spots:** a CPU profile of the window (CDP's `Profiler`), with the
 *   self time per function, highest first.
 *
 * WebGL here may be software (SwiftShader): its drawing cost lands in the GPU
 * process, so the per-frame JS times are the meaningful part, and GPU process
 * CPU is reported apart.
 */
import type { Browser, CDPSession, Page } from 'playwright-core';
import { startHarness, type Harness } from '../browser/harness';
import { KEEP_NAMES, openViewWindow } from './soak';

export interface FrameStats {
  frames: number;
  fps: number;
  /** Frames that drew the canvas (a window out of sight advances without drawing). */
  paintedFps: number;
  /** Milliseconds per frame: the frame callback, and Mochi2D's advance inside it. */
  frameMs: { mean: number; p50: number; p95: number; max: number };
  advanceMs: { mean: number; p50: number; p95: number };
}

export interface BudgetResult {
  windowHidden: boolean;
  window: FrameStats;
  view?: FrameStats;
  /** CPU per process type, in percent of one core, over the measured seconds. */
  cpu: Record<string, number>;
  /** Self time per function in the window's profile, ms over the profiled seconds. */
  hot: { fn: string; url: string; selfMs: number }[];
  seconds: number;
}

/** Wraps the frame and Mochi2D's advance to time them (in the page). */
function instrument(global: string): void {
  const w = window as any;
  const g = w[global];
  const rt = g.runtime;
  const times: number[] = [];
  const adv: number[] = [];
  w.frameTimes = times;
  w.advanceTimes = adv;
  const view = () => rt.view ?? rt.v?.view;
  // The window: Studio.frame; an output view: its runtime's render (its whole frame).
  if (global === 'mochiStudio') {
    const frame = g.frame.bind(g);
    g.frame = (now: number, draw?: boolean) => {
      const f0 = g.framesDrawn;
      const t = performance.now();
      frame(now, draw);
      // Only frames that ran (the frame cap skips the rest).
      if (g.framesDrawn !== f0) times.push(performance.now() - t);
    };
  }
  const render = rt.render.bind(rt);
  rt.render = (dt: number, draw?: boolean) => {
    const v = view();
    if (v && !v.__timed) {
      const a = v.advance.bind(v);
      v.advance = (s: number, o?: unknown) => {
        const t = performance.now();
        a(s, o);
        adv.push(performance.now() - t);
      };
      v.__timed = true;
    }
    const t = performance.now();
    render(dt, draw);
    if (global !== 'mochiStudio') times.push(performance.now() - t);
  };
}

const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
  const r = (v: number) => Math.round(v * 100) / 100;
  return {
    mean: r(s.reduce((a, b) => a + b, 0) / Math.max(1, s.length)),
    p50: r(at(0.5)),
    p95: r(at(0.95)),
    max: r(s.at(-1) ?? 0),
  };
};

async function collect(page: Page, seconds: number, frames0: number, global: string) {
  const d = await page.evaluate(
    ({ global }) => {
      const w = window as any;
      return {
        times: w.frameTimes as number[],
        adv: w.advanceTimes as number[],
        frames: w[global].framesDrawn as number,
        painted: (w[global].framesPainted ?? w[global].framesDrawn) as number,
        painted0: (w.painted0 ?? 0) as number,
      };
    },
    { global },
  );
  const frames = d.frames - frames0;
  const f = stats(d.times);
  const a = stats(d.adv);
  return {
    frames,
    fps: Math.round((frames / seconds) * 10) / 10,
    paintedFps: Math.round(((d.painted - d.painted0) / seconds) * 10) / 10,
    frameMs: f,
    advanceMs: { mean: a.mean, p50: a.p50, p95: a.p95 },
  } satisfies FrameStats;
}

async function processCpu(browser: Browser): Promise<Record<string, number>> {
  const cdp = await browser.newBrowserCDPSession();
  const { processInfo } = (await cdp.send('SystemInfo.getProcessInfo')) as {
    processInfo: { type: string; id: number; cpuTime: number }[];
  };
  await cdp.detach();
  const out: Record<string, number> = {};
  for (const p of processInfo) out[`${p.type}:${p.id}`] = p.cpuTime;
  return out;
}

export interface BudgetOptions {
  modelZip: Uint8Array;
  seconds?: number;
  /**
   * An output view in a window of its own; with 'window hidden', the control
   * window reports itself hidden, as a minimized window does.
   */
  withView?: boolean | 'window hidden';
  /** Seconds of CPU profile (0: none). */
  profile?: number;
  log?: (m: string) => void;
}

export async function measureFrameBudget(o: BudgetOptions): Promise<BudgetResult> {
  const log = o.log ?? (() => undefined);
  const seconds = o.seconds ?? 20;
  let H: Harness | undefined;
  try {
    H = await startHarness();
    await H.context.addInitScript({ content: KEEP_NAMES });
    const page = await H.context.newPage();
    await page.goto(H.url);
    await page.waitForFunction(() => 'mochiStudio' in window);
    const t0 = Date.now();
    await page.locator('#model-zip').setInputFiles({
      name: 'Model.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(o.modelZip),
    });
    await page.waitForFunction(() => (window as any).mochiStudio.settings !== undefined, null, {
      timeout: 180_000,
    });
    log(`model loaded in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    // Tracking at 30 frames a second, the head turning and the mouth moving.
    await page.evaluate(() => {
      const w = window as any;
      const t0 = performance.now();
      setInterval(() => {
        const t = performance.now();
        const s = (t - t0) / 1000;
        const yaw = Math.sin(s * 0.7) * 0.3;
        const c = Math.cos(yaw);
        const n = Math.sin(yaw);
        w.mochiStudio.feedFrame({
          t,
          face: true,
          blendshapes: { jawOpen: (Math.sin(s * 3) + 1) / 3, mouthSmileLeft: 0.3 },
          matrix: [c, 0, -n, 0, 0, 1, 0, 0, n, 0, c, 0, 0, 0, -40, 1],
        });
      }, 33);
    });
    let view: Page | undefined;
    if (o.withView) {
      const url = new URL('output.html', H.url).href;
      view = await openViewWindow(page, url);
      await view.waitForFunction(() => !!document.body.dataset.model, null, { timeout: 180_000 });
      log('output view ready');
      await page.bringToFront();
      // A minimized window: headless Chromium never hides a page, so the window says it is
      // hidden the way a minimized one does (document.hidden, visibilitychange).
      if (o.withView === 'window hidden')
        await page.evaluate(() => {
          Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
          Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            get: () => 'hidden',
          });
          document.dispatchEvent(new Event('visibilitychange'));
        });
    }
    // Settle, then measure.
    await new Promise((r) => setTimeout(r, 3000));
    await page.evaluate(instrument, 'mochiStudio');
    if (view) await view.evaluate(instrument, 'mochiOutput');
    const wf0 = await page.evaluate(() => {
      const w = window as any;
      w.painted0 = w.mochiStudio.framesPainted;
      return w.mochiStudio.framesDrawn as number;
    });
    const vf0 = view
      ? await view.evaluate(() => {
          const w = window as any;
          w.painted0 = w.mochiOutput.framesDrawn;
          return w.mochiOutput.framesDrawn as number;
        })
      : 0;
    const cpu0 = await processCpu(H.browser);
    const start = Date.now();
    let hot: BudgetResult['hot'] = [];
    let cdp: CDPSession | undefined;
    if (o.profile) {
      cdp = await page.context().newCDPSession(page);
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
      await cdp.send('Profiler.start');
    }
    await new Promise((r) => setTimeout(r, seconds * 1000));
    const measured = (Date.now() - start) / 1000;
    const cpu1 = await processCpu(H.browser);
    if (cdp) {
      const { profile } = (await cdp.send('Profiler.stop')) as { profile: any };
      hot = selfTimes(profile).slice(0, 25);
    }
    const cpu: Record<string, number> = {};
    for (const [k, v] of Object.entries(cpu1)) {
      const type = k.split(':')[0]!;
      cpu[type] = (cpu[type] ?? 0) + ((v - (cpu0[k] ?? 0)) / measured) * 100;
    }
    for (const k of Object.keys(cpu)) cpu[k] = Math.round(cpu[k]! * 10) / 10;
    return {
      windowHidden: await page.evaluate(() => document.hidden),
      window: await collect(page, measured, wf0, 'mochiStudio'),
      ...(view ? { view: await collect(view, measured, vf0, 'mochiOutput') } : {}),
      cpu,
      hot,
      seconds: Math.round(measured * 10) / 10,
    };
  } finally {
    await H?.close();
  }
}

/** Self time per function (name and script), from a CDP CPU profile. */
function selfTimes(profile: {
  nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number } }[];
  samples: number[];
  timeDeltas: number[];
}): BudgetResult['hot'] {
  const byNode = new Map<number, number>();
  for (let i = 0; i < profile.samples.length; i++)
    byNode.set(
      profile.samples[i]!,
      (byNode.get(profile.samples[i]!) ?? 0) + (profile.timeDeltas[i] ?? 0),
    );
  const byFn = new Map<string, { fn: string; url: string; selfMs: number }>();
  for (const n of profile.nodes) {
    const us = byNode.get(n.id);
    if (!us) continue;
    const fn = n.callFrame.functionName || '(anonymous)';
    const url = n.callFrame.url.split('/').pop() ?? '';
    const key = `${fn}@${url}:${n.callFrame.lineNumber}`;
    const e = byFn.get(key) ?? { fn: `${fn}:${n.callFrame.lineNumber}`, url, selfMs: 0 };
    e.selfMs += us / 1000;
    byFn.set(key, e);
  }
  return [...byFn.values()]
    .map((e) => ({ ...e, selfMs: Math.round(e.selfMs) }))
    .sort((a, b) => b.selfMs - a.selfMs);
}
