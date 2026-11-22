import type { Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, syntheticModelZip, type Harness } from './harness';

/**
 * A control window out of sight advances
 * every frame without drawing (Mochi2D 0.18.0's `advance(s, { draw: false })`).
 * Its output views keep getting the parameters at the stage's rate, while
 * its own draw calls stop.
 *
 * Headless Chromium never hides a page, so the test makes the window report
 * itself hidden, as a minimized one does (document.hidden and
 * visibilitychange). Animation frames keep coming then, as they do in
 * Electron's windows (`backgroundThrottling: false`). The second test stops
 * them too, as a browser does for a minimized window.
 */
let H: Harness;
let page: Page;
let out: Page;
const errors: string[] = [];

const studio = <T>(fn: string): Promise<T> =>
  page.evaluate(
    (f) => new Function('s', `return ${f}`)((window as any).mochiStudio),
    fn,
  ) as Promise<T>;

/** What the window and the view did over some time. */
async function counts(ms: number) {
  const read = async () => ({
    frames: await studio<number>('s.framesDrawn'),
    painted: await studio<number>('s.framesPainted'),
    ticked: await studio<number>('s.backgroundFrames'),
    drawCalls: await page.evaluate(() => (window as any).drawCalls as number),
    params: await out.evaluate(() => (window as any).mochiOutput.paramsReceived as number),
  });
  const a = await read();
  await page.waitForTimeout(ms);
  const b = await read();
  const per = (k: keyof typeof a) => Math.round(((b[k] - a[k]) * 1000) / ms);
  return {
    frames: per('frames'),
    painted: per('painted'),
    ticked: per('ticked'),
    drawCalls: per('drawCalls'),
    params: per('params'),
  };
}

/** Makes the page report itself hidden or shown, as minimizing and restoring do. */
const setHidden = (hidden: boolean) =>
  page.evaluate((hidden) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (hidden ? 'hidden' : 'visible'),
    });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);

beforeAll(async () => {
  H = await startHarness();
  page = await H.context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  // Counts the page's WebGL draw calls (the control window's canvas draws them all).
  await page.addInitScript(() => {
    const w = window as any;
    w.drawCalls = 0;
    for (const C of [WebGLRenderingContext, WebGL2RenderingContext])
      for (const name of [
        'drawElements',
        'drawArrays',
        'drawElementsInstanced',
        'drawArraysInstanced',
      ])
        if (name in C.prototype) {
          const f = (C.prototype as any)[name];
          (C.prototype as any)[name] = function (this: unknown, ...a: unknown[]) {
            w.drawCalls++;
            return f.apply(this, a);
          };
        }
  });
  await page.goto(H.url);
  await page.waitForFunction(() => 'mochiStudio' in window);
  await page.locator('#model-zip').setInputFiles({
    name: 'Test.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(syntheticModelZip()),
  });
  await page.waitForFunction(() => (window as any).mochiStudio.settings !== undefined);
  out = await H.context.newPage();
  out.on('pageerror', (e) => errors.push(`output: ${e.message}`));
  await out.goto(new URL('output.html', H.url).href);
  await out.waitForFunction(() => document.body.dataset.model?.startsWith('test.model3.json'));
  // A moving head, as tracking gives: a new value every frame for the view.
  await page.evaluate(() => {
    const w = window as any;
    const t0 = performance.now();
    w.moving = setInterval(() => {
      const t = (performance.now() - t0) / 1000;
      w.mochiStudio.setOverrides({ ParamAngleX: Math.sin(t * 3) * 30 });
    }, 10);
  });
}, 60_000);
afterAll(async () => {
  await H?.close();
});

describe('a control window out of sight advances without drawing', () => {
  it('keeps the views’ parameters at the stage’s rate while its own drawing stops', async () => {
    // The control window in front, drawn on animation frames (the view opened last).
    await page.bringToFront();
    await page.waitForTimeout(300);
    const shown = await counts(2000);
    expect(shown.painted).toBeGreaterThan(5);
    expect(shown.drawCalls).toBeGreaterThan(0);
    expect(shown.params).toBeGreaterThan(5);

    await setHidden(true);
    await page.waitForTimeout(200);
    const hiddenPainted = await studio<number>('s.framesPainted');
    const hidden = await counts(2000);
    console.log('Frames per second, shown and hidden:', JSON.stringify({ shown, hidden }));
    // The frames go on at the same rate, and so do the view's parameters.
    expect(hidden.frames).toBeGreaterThan(shown.frames * 0.6);
    expect(hidden.params).toBeGreaterThan(shown.params * 0.6);
    // Nothing is drawn.
    expect(hidden.painted).toBe(0);
    expect(hidden.drawCalls).toBe(0);
    // The view follows what the hidden window computes: a value set now arrives.
    await page.evaluate(() => {
      const w = window as any;
      clearInterval(w.moving);
      w.mochiStudio.setOverrides({ ParamAngleX: 17 });
    });
    // The view gets what the hidden window computed for it, not a frame behind: the
    // value it was sent last is the window's latest. (Each page also plays the idle
    // animation on its own clock, so the values they draw differ by the idle's phase.)
    // On a time-out, the message says what was read last.
    const reads: { mine?: number; got?: number }[] = [];
    await expect
      .poll(
        async () => {
          const mine = await studio<number | undefined>('s.lastParams.ParamAngleX');
          const got = await out.evaluate(
            () => (window as any).mochiOutput.params.ParamAngleX as number | undefined,
          );
          reads.push({ mine, got });
          return mine !== undefined && got === mine && Math.abs(mine - 17) < 0.01;
        },
        { timeout: 5000, message: 'the view gets what the hidden window computed' },
      )
      .toBe(true)
      .catch((e: Error) => {
        throw new Error(`${e.message}; read last: ${JSON.stringify(reads.slice(-5))}`);
      });
    expect(await studio<number>('s.framesPainted')).toBe(hiddenPainted);
    await page.evaluate(() => {
      const w = window as any;
      const t0 = performance.now();
      w.moving = setInterval(() => {
        const t = (performance.now() - t0) / 1000;
        w.mochiStudio.setOverrides({ ParamAngleX: Math.sin(t * 3) * 30 });
      }, 10);
    });

    // Shown again: it draws at once, the current state.
    await setHidden(false);
    await page.bringToFront();
    await page.waitForTimeout(200);
    const again = await counts(1000);
    expect(again.painted).toBeGreaterThan(5);
    expect(again.drawCalls).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });

  it('advances on the worker’s ticks without drawing when animation frames stop', async () => {
    // The head moves, so the view has values to get (set again here, so this test
    // doesn't depend on how the one before it ended).
    await page.evaluate(() => {
      const w = window as any;
      clearInterval(w.moving);
      const t0 = performance.now();
      w.moving = setInterval(() => {
        const t = (performance.now() - t0) / 1000;
        w.mochiStudio.setOverrides({ ParamAngleX: Math.sin(t * 3) * 30 });
      }, 10);
    });
    // As a browser does for a minimized window: no animation frames at all.
    await page.evaluate(() => {
      const s = (window as any).mochiStudio;
      s.stop();
      (window as any).realRaf = window.requestAnimationFrame;
      window.requestAnimationFrame = () => 0;
      s.start();
    });
    await page.waitForTimeout(300);
    const ticks = await counts(2000);
    console.log('Frames per second on the worker’s ticks:', JSON.stringify(ticks));
    expect(ticks.ticked).toBeGreaterThan(15);
    expect(ticks.frames).toBeGreaterThan(15);
    expect(ticks.params).toBeGreaterThan(15);
    expect(ticks.painted).toBe(0);
    expect(ticks.drawCalls).toBe(0);
    await page.evaluate(() => {
      const s = (window as any).mochiStudio;
      s.stop();
      window.requestAnimationFrame = (window as any).realRaf;
      s.start();
    });
    expect(errors).toEqual([]);
  });
});
