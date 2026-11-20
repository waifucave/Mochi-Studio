import type { Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openSection, startHarness, syntheticModelZip, type Harness } from './harness';

/**
 * The display light overlay, through a stand-in for
 * the browser's screen capture (a canvas whose thirds are red, green and
 * blue); the model drawn with it, and output views given it.
 */
let H: Harness;
let page: Page;
const errors: string[] = [];
const SKIN = [240, 180, 150];
const BODY = { x: 0, y: 0.15 };

function colorAt(p: Page, at: { x: number; y: number }, output = false): Promise<number[]> {
  return p.evaluate(
    async ({ at, output }) => {
      const w = window as any;
      const rt = output ? w.mochiOutput.runtime : w.mochiStudio.runtime;
      const pt = rt.modelToPage(at.x, at.y);
      const shot = output ? await rt.screenshot() : await w.mochiStudio.screenshot();
      const blob = shot instanceof Blob ? shot : new Blob([shot], { type: 'image/png' });
      const bmp = await createImageBitmap(blob);
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext('2d')!;
      g.drawImage(bmp, 0, 0);
      const canvas = document.querySelector('canvas')!.getBoundingClientRect();
      const k = bmp.width / canvas.width;
      const d = g.getImageData(
        Math.round((pt.x - canvas.left) * k),
        Math.round((pt.y - canvas.top) * k),
        1,
        1,
      ).data;
      return [d[0]!, d[1]!, d[2]!];
    },
    { at, output },
  );
}
const near = (a: number[], b: readonly number[]): boolean =>
  a.every((v, i) => Math.abs(v - b[i]!) <= 14);
const light = (p: Page, g = 'mochiStudio') =>
  p.evaluate((g) => (window as any)[g].runtime.lightColor(), g);

beforeAll(async () => {
  H = await startHarness();
  page = await H.context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  // The capture's stand-in: the browser's picker is not scriptable.
  await page.addInitScript(() => {
    const w = window as any;
    w.captureAsked = 0;
    navigator.mediaDevices.getDisplayMedia = async () => {
      w.captureAsked++;
      const c = document.createElement('canvas');
      c.width = 90;
      c.height = 30;
      const g = c.getContext('2d')!;
      ['#ff0000', '#00ff00', '#0000ff'].forEach((col, i) => {
        g.fillStyle = col;
        g.fillRect(i * 30, 0, 30, 30);
      });
      w.paint = setInterval(() => g.fillRect(0, 0, 0, 0), 50);
      return c.captureStream(10);
    };
  });
  await page.goto(H.url);
  await page.waitForFunction(() => 'mochiStudio' in window);
  await page.locator('#model-zip').setInputFiles({
    name: 'Test.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(syntheticModelZip()),
  });
  await page.waitForFunction(() => (window as any).mochiStudio.settings !== undefined);
  await page.evaluate(() => {
    const s = (window as any).mochiStudio;
    s.runtime.setEffect?.('breath', false);
    s.setOverrides({ ParamAngleX: 0 });
  });
}, 60_000);
afterAll(async () => {
  await H?.close();
});

describe('the display light overlay', () => {
  it('starts only when asked, lights the model by the parts that are on, in output views too', async () => {
    // Nothing is captured until the person starts it.
    expect(await page.evaluate(() => (window as any).captureAsked)).toBe(0);
    expect((await light(page)).rgb).toBeUndefined();
    await openSection(page, 'Tracking');
    // The documented defaults: 15, 40, 3, every part, items too.
    expect(
      await Promise.all(
        ['#light-base', '#light-boost', '#light-smoothing'].map((x) =>
          page.locator(x).inputValue(),
        ),
      ),
    ).toEqual(['15', '40', '3']);
    expect(await page.locator('#light-items').isChecked()).toBe(true);
    const slide = (sel: string, v: number) =>
      page.locator(sel).evaluate((el, v) => {
        (el as HTMLInputElement).value = String(v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }, v);
    // Round numbers for the checks: 50, 50, no smoothing; items off for now.
    await slide('#light-base', 50);
    await slide('#light-boost', 50);
    await slide('#light-smoothing', 0);
    await page.locator('#light-items').uncheck();
    await page.locator('#light-toggle').click();
    expect(await page.evaluate(() => (window as any).captureAsked)).toBe(1);
    // All three parts: the average is grey 85; 85 + 127.5 = 212.5 of 255.
    await expect
      .poll(async () => (await light(page)).rgb?.map((c: number) => Math.round(c * 100)), {
        timeout: 5000,
      })
      .toEqual([83, 83, 83]);
    await expect.poll(() => page.locator('#light-status').textContent()).toContain('a screen');
    // Without the middle: red and blue, 127.5 → the light 255, 127.5, 255.
    await page.locator('#light-part-middle').uncheck();
    await expect
      .poll(async () => (await light(page)).rgb?.map((c: number) => Math.round(c * 100)))
      .toEqual([100, 50, 100]);
    // The model is drawn with it: green halved.
    await page.keyboard.press('Escape');
    await expect
      .poll(async () => near(await colorAt(page, BODY), [SKIN[0]!, SKIN[1]! / 2, SKIN[2]!]), {
        timeout: 10_000,
      })
      .toBe(true);
    // Output views get the color (they capture nothing themselves).
    const out = await H.context.newPage();
    await out.goto(new URL('output.html', H.url).href);
    await out.waitForFunction(() => document.body.dataset.model?.startsWith('test.model3.json'));
    await expect
      .poll(async () =>
        (await light(out, 'mochiOutput')).rgb?.map((c: number) => Math.round(c * 100)),
      )
      .toEqual([100, 50, 100]);
    expect(await out.evaluate(() => (window as any).captureAsked ?? 0)).toBe(0);
    // Items too, when chosen; saved app-wide.
    await page.bringToFront();
    await openSection(page, 'Tracking');
    await page.locator('#light-items').check();
    await expect.poll(async () => (await light(page)).items).toBe(true);
    await expect.poll(async () => (await light(out, 'mochiOutput')).items).toBe(true);
    expect(
      await page.evaluate(
        async () => (await (window as any).mochiStudio.store.getApp()).lightOverlay,
      ),
    ).toMatchObject({
      items: true,
      smoothing: 0,
      parts: { left: true, middle: false, right: true },
    });
    // Stopped: off everywhere, and the model's own colors again.
    await page.locator('#light-toggle').click();
    await expect.poll(async () => (await light(page)).rgb).toBeUndefined();
    await expect.poll(async () => (await light(out, 'mochiOutput')).rgb).toBeUndefined();
    await page.keyboard.press('Escape');
    await expect
      .poll(async () => near(await colorAt(page, BODY), SKIN), { timeout: 10_000 })
      .toBe(true);
    await out.close();
    expect(errors).toEqual([]);
  });
});
