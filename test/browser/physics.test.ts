import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, syntheticPhysicsModelZip, type Harness, openSection } from './harness';

/**
 * Tracking aimed at a parameter physics overwrites goes to the parameter
 * that drives it. The synthetic model's physics file (written with Mochi2D's
 * `writePhysics`) has ParamAngleX overwritten from ParamCustom.
 */
let H: Harness;
beforeAll(async () => {
  H = await startHarness();
});
afterAll(async () => {
  await H?.close();
});
const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/synthetic-session.json', import.meta.url), 'utf8'),
);

describe('physics-driven parameters', () => {
  it('moves the head rule to the driver, says so in the editor, and warns agents', async () => {
    const page = await H.context.newPage();
    await page.goto(H.url);
    await page.waitForFunction(() => 'mochiStudio' in window);
    await page.locator('#model-zip').setInputFiles({
      name: 'Test.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(syntheticPhysicsModelZip()),
    });
    await page.waitForFunction(() => (window as any).mochiStudio.settings !== undefined);
    // Read from the physics file when the model loads: ParamAngleX (−30…30) from ParamCustom (0…1).
    await page.waitForFunction(
      () => (window as any).mochiStudio.physicsDrivers?.ParamAngleX?.from === 'ParamCustom',
    );
    const out = await page.evaluate((frames) => {
      const s = (window as any).mochiStudio;
      s.stop();
      let at: Record<string, number> = {};
      for (const f of frames) {
        s.feedFrame(f);
        s.frame(f.t + 100_000);
        if (f.t >= 3500 && !at.ParamCustom) at = { ...s.lastParams };
      }
      return at;
    }, fixture.frames);
    // +25° turn, mirrored: ParamAngleX would be > 15; scaled into 0..1 it is > 0.75.
    expect(out.ParamAngleX).toBeUndefined();
    expect(out.ParamCustom).toBeGreaterThan(0.75);
    await openSection(page, 'Mapping');
    expect(await page.locator('.rule .physics').first().textContent()).toContain(
      'Driven by physics from ParamCustom',
    );
    // The rule's switch: write ParamAngleX itself.
    await page.locator('.rule .follow-physics').first().uncheck();
    expect(
      await page.evaluate(() => (window as any).mochiStudio.settings.mapping[0].followPhysics),
    ).toBe(false);
    expect(await page.evaluate(() => (window as any).mochiStudio.trackingRedirects)).toEqual({});
    const r = await page.evaluate(() =>
      (window as any).mochiStudio.commands.dispatch('set_parameters', {
        values: { ParamAngleX: 5 },
      }),
    );
    expect(r.drivenByPhysics).toEqual({ ParamAngleX: 'ParamCustom' });
    await page.close();
  });
});
