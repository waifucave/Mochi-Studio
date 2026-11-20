import type { Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openSection, startHarness, syntheticModelZip, type Harness } from './harness';

/**
 * The light overlay's details: the static color, a
 * light above 1 (Mochi2D 0.14.0), the strength per art mesh, «Screen
 * Overlay» hotkeys and Reset.
 */
let H: Harness;
let page: Page;
const errors: string[] = [];
const SKIN = [240, 180, 150];
const BODY = { x: 0, y: 0.15 };

function colorAt(at: { x: number; y: number }): Promise<number[]> {
  return page.evaluate(async (at) => {
    const w = window as any;
    const pt = w.mochiStudio.runtime.modelToPage(at.x, at.y);
    const shot = await w.mochiStudio.screenshot();
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
  }, at);
}
const near = (a: number[], b: readonly number[]): boolean =>
  a.every((v, i) => Math.abs(v - b[i]!) <= 14);
const shows = (color: readonly number[]) =>
  expect.poll(async () => near(await colorAt(BODY), color), { timeout: 10_000 }).toBe(true);
const light = () =>
  page.evaluate(() =>
    (window as any).mochiStudio.runtime.lightColor().rgb?.map((c: number) => Math.round(c * 100)),
  );
const settings = (o: Record<string, unknown>) =>
  page.evaluate((o) => (window as any).mochiStudio.setLightOverlaySettings(o), o);

beforeAll(async () => {
  H = await startHarness();
  page = await H.context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
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

describe('the light overlay’s details', () => {
  it('lights the model with a static color, brighter than its own too', async () => {
    await openSection(page, 'Tracking');
    await page.locator('#light-static').fill('#808080');
    await page.locator('#light-static').dispatchEvent('change');
    await settings({ baseBrightness: 0, colorBoost: 50, smoothing: 0 });
    await page.locator('#light-static-on').click();
    // 128 × 50/50 + 0: half the model's colors.
    await expect.poll(light).toEqual([50, 50, 50]);
    await expect.poll(() => page.locator('#light-status').textContent()).toContain('static color');
    // Boost 100: 256 of 255, then base 30: 332, a light of 1.3 (the formula's range, up to 1.8).
    await settings({ colorBoost: 100, baseBrightness: 30 });
    await expect.poll(light).toEqual([130, 130, 130]);
    await page.keyboard.press('Escape');
    await shows(SKIN.map((c) => Math.min(255, c * 1.3)));
  });

  it('keeps an art mesh out of the light by its strength, from the Model tab', async () => {
    await settings({ colorBoost: 50, baseBrightness: 0 });
    await shows(SKIN.map((c) => c * 0.5));
    await openSection(page, 'Model');
    await page.locator('#light-strengths summary').click();
    await page.locator('#light-mesh').fill('ArtMeshBody');
    await page.locator('#light-mesh-add').click();
    await expect
      .poll(() => page.evaluate(() => (window as any).mochiStudio.settings.lightStrengths))
      .toEqual({ ArtMeshBody: 0.5 });
    // At 0.5: 1 + 0.5 · (0.5 − 1) = 0.75.
    await page.keyboard.press('Escape');
    await shows(SKIN.map((c) => c * 0.75));
    // At 0: its own colors in the light.
    await page.evaluate(() =>
      (window as any).mochiStudio.updateSettings({ lightStrengths: { ArtMeshBody: 0 } }),
    );
    await shows(SKIN);
    // An output view gets the strengths with the light.
    const out = await H.context.newPage();
    await out.goto(new URL('output.html', H.url).href);
    await out.waitForFunction(() => document.body.dataset.model?.startsWith('test.model3.json'));
    await expect
      .poll(() => out.evaluate(() => (window as any).mochiOutput.runtime.lightColor().rgb))
      .toBeTruthy();
    await out.close();
    await page.bringToFront();
    await page.evaluate(() => (window as any).mochiStudio.updateSettings({ lightStrengths: {} }));
  });

  it('records the light in Screen Overlay hotkeys, and applies them', async () => {
    const s = () => (window as any).mochiStudio;
    const recorded = await page.evaluate(() => (window as any).mochiStudio.recordScreenOverlay());
    expect(recorded).toMatchObject({ on: true, source: 'static' });
    await page.evaluate(
      (on) =>
        (window as any).mochiStudio.updateSettings({
          hotkeys: [
            {
              id: 'light-on',
              label: 'Grey light',
              keys: '',
              button: false,
              action: { type: 'screenOverlay', overlay: on },
            },
            {
              id: 'light-off',
              label: 'No light',
              keys: '',
              button: false,
              action: {
                type: 'screenOverlay',
                overlay: { ...on, on: false },
              },
            },
          ],
        }),
      recorded,
    );
    void s;
    await page.evaluate(() => (window as any).mochiStudio.run('fire_hotkey', { id: 'light-off' }));
    await expect.poll(light).toBeUndefined();
    await page.evaluate(() => (window as any).mochiStudio.run('fire_hotkey', { id: 'light-on' }));
    await expect.poll(light).toEqual([50, 50, 50]);
    // The Hotkeys tab offers the action and says what it does.
    await openSection(page, 'Hotkeys');
    await expect
      .poll(() => page.locator('[data-hotkey="light-on"] .screen-overlay-summary').textContent())
      .toContain('static color 128, 128, 128');
    await page.keyboard.press('Escape');
  });

  it('says in a browser that web items need the desktop app', async () => {
    await openSection(page, 'Items');
    await expect.poll(() => page.locator('#web-item-note').textContent()).toContain('desktop app');
    expect(await page.locator('#web-item-add').count()).toBe(0);
    await page.keyboard.press('Escape');
  });

  it('goes back to the defaults with Reset', async () => {
    await openSection(page, 'Tracking');
    await page.locator('#light-reset').click();
    expect(
      await page.evaluate(
        async () => (await (window as any).mochiStudio.store.getApp()).lightOverlay,
      ),
    ).toEqual({
      baseBrightness: 15,
      colorBoost: 40,
      smoothing: 3,
      parts: { left: true, middle: true, right: true },
      items: true,
      staticColor: [255, 255, 255],
    });
    await page.locator('#light-toggle').click();
    await expect.poll(light).toBeUndefined();
    await page.keyboard.press('Escape');
    expect(errors).toEqual([]);
  });
});
