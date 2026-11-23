import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, syntheticModelZip, type Harness, openSection } from './harness';

/**
 * A lost graphics context (the graphics driver or the browser's graphics process restarted):
 * on the Windows runner the app's window sometimes lost it as the app started, and a model
 * loaded then failed with "Texture size 1x1 outside [1, null]". A load waits for the context
 * now, and the log says what happened. The context is lost and restored here with WebGL's
 * own WEBGL_lose_context extension.
 */
let H: Harness;
beforeAll(async () => {
  H = await startHarness();
});
afterAll(async () => {
  await H?.close();
});

describe('a lost graphics context', () => {
  it('holds a model load until the context is back, and says so in the log', async () => {
    const page = await H.context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(H.url);
    await page.waitForFunction(() => 'mochiStudio' in window && 'mochiLog' in window);
    const lose = (how: 'loseContext' | 'restoreContext') =>
      page.evaluate((how) => {
        // (Kept from before the loss: a lost context gives no extensions.)
        const c = document.getElementById('stage') as HTMLCanvasElement;
        const w = window as any;
        w.loseExt ??= c.getContext('webgl2')?.getExtension('WEBGL_lose_context');
        if (!w.loseExt) throw new Error('no WEBGL_lose_context');
        w.loseExt[how]();
      }, how);
    const lost = () => page.evaluate(() => (window as any).mochiStudio.runtime.graphicsLost);
    const log = () => page.evaluate(() => (window as any).mochiLog.lines().join('\n'));

    await lose('loseContext');
    await expect.poll(lost).toBe(true);
    expect(await log()).toContain('The graphics context was lost');

    await openSection(page, 'Model');
    await page.locator('#model-zip').setInputFiles({
      name: 'Test.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(syntheticModelZip()),
    });
    await expect.poll(log).toContain('Loading Test.zip');
    // Held while the context is lost: not loaded, and not refused.
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => (window as any).mochiStudio.settings)).toBeUndefined();
    expect(await log()).not.toContain('Could not load');

    await lose('restoreContext');
    await expect
      .poll(() => page.evaluate(() => (window as any).mochiStudio.settings !== undefined), {
        timeout: 20_000,
      })
      .toBe(true);
    expect(await lost()).toBe(false);
    expect(await log()).toContain('The graphics context is back.');
    expect(await log()).toContain('Loaded Test.zip');
    expect(errors).toEqual([]);
    await page.close();
  });
});
