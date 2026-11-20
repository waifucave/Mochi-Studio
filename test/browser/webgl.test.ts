import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, syntheticModelZip, type Harness, openSection } from './harness';

/** Without WebGL 2, Mochi Studio says so and the rest of the interface keeps working. */
let H: Harness;
let noGl: Browser;
beforeAll(async () => {
  H = await startHarness();
  const executablePath = process.env.CHROMIUM_PATH;
  noGl = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    args: ['--disable-webgl', '--disable-webgl2'],
  });
});
afterAll(async () => {
  await noGl?.close();
  await H?.close();
});

describe('without WebGL 2', () => {
  it('shows what is missing and what to try, and the rest still works', async () => {
    const page = await noGl.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(H.url);
    await page.waitForFunction(() => 'mochiStudio' in window && 'mochiAgentLink' in window);
    const box = page.locator('#stage-problem');
    expect(await box.textContent()).toContain('does not offer WebGL 2');
    expect(await box.textContent()).toContain('hardware acceleration');
    // The tabs still work.
    await openSection(page, 'Hotkeys');
    expect(await page.locator('#panel-hotkeys').isVisible()).toBe(true);
    // Loading a model says why it cannot be shown.
    await openSection(page, 'Model');
    await page.locator('#model-zip').setInputFiles({
      name: 'Test.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(syntheticModelZip()),
    });
    await expect.poll(() => page.locator('.toast').textContent()).toContain('WebGL 2');
    expect(errors).toEqual([]);
    await page.close();
  });
});
