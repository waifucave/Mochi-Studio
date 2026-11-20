import { readFileSync } from 'node:fs';
import { zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { syntheticModelFiles } from '../support/syntheticModel';
import { startHarness, syntheticItemZip, type Harness, openSection } from './harness';

/** The settings import in the app, the settings export with items, and the noise gate. */
let H: Harness;
beforeAll(async () => {
  H = await startHarness();
});
afterAll(async () => {
  await H?.close();
});

/** A made-up `.vtube.json` (from the file format's field tables) for the synthetic model. */
const vtubeJson = JSON.stringify(
  {
    Version: 1,
    Name: 'Test',
    FileReferences: { Model: 'test.model3.json', Icon: '', IdleAnimation: 'wave.motion3.json' },
    ParameterSettings: [
      {
        Name: 'Mouth',
        Input: 'MouthOpen',
        InputRangeLower: 0.0,
        InputRangeUpper: 1.0,
        OutputRangeLower: 0.0,
        OutputRangeUpper: 1.0,
        ClampInput: false,
        ClampOutput: false,
        UseBlinking: false,
        UseBreathing: false,
        OutputLive2D: 'ParamMouthOpenY',
        Smoothing: 10,
      },
    ],
    Hotkeys: [
      {
        HotkeyID: '00000000000000000000000000000001',
        Name: 'Blush',
        Action: 'ToggleExpression',
        File: 'blush.exp3.json',
        Triggers: { Trigger1: 'LeftShift', Trigger2: 'B', Trigger3: '', ScreenButton: 1 },
        IsActive: true,
      },
    ],
    Mystery: true,
  },
  null,
  4,
);

function modelZip(withVtube: boolean): Uint8Array {
  const files = syntheticModelFiles();
  const entries = Object.fromEntries(Object.entries(files).map(([p, d]) => [`Test/${p}`, d]));
  if (withVtube) entries['Test/test.vtube.json'] = new TextEncoder().encode(vtubeJson);
  return zipSync(entries);
}

async function openStudio(withVtube = false): Promise<Page> {
  const page = await H.context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(H.url);
  await page.waitForFunction(() => 'mochiStudio' in window);
  (page as unknown as { errors: string[] }).errors = errors;
  await page.locator('#model-zip').setInputFiles({
    name: 'Test.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(modelZip(withVtube)),
  });
  await page.waitForFunction(() => (window as any).mochiStudio.settings !== undefined);
  return page;
}

describe('the settings import, the export and the noise gate in Chromium', () => {
  it('imports VTube Studio settings from the model folder, after showing the report', async () => {
    const page = await openStudio(true);
    await openSection(page, 'Model');
    await page.getByRole('button', { name: 'Import test.vtube.json' }).click();
    const report = page.locator('#vts-import .report');
    await expect.poll(() => report.textContent()).toContain('1 mappings and 1 hotkeys');
    expect(await report.textContent()).toContain('Unknown fields (ignored) (1)');
    // Nothing changes before Apply.
    expect(await page.evaluate(() => (window as any).mochiStudio.settings.hotkeys.length)).toBe(0);
    await page.getByRole('button', { name: 'Apply' }).click();
    const s = await page.evaluate(() => (window as any).mochiStudio.settings);
    expect(s.mapping).toHaveLength(1);
    expect(s.hotkeys[0]).toMatchObject({
      keys: 'Shift+KeyB',
      button: true,
      action: { type: 'expression', expression: 'Blush' },
    });
    expect(s.idleMotion).toBe('wave.motion3.json');
    // The idle motion loops.
    await expect
      .poll(() => page.evaluate(() => (window as any).mochiStudio.runtime.model.motions))
      .toContain('wave.motion3.json');
    // The imported key works.
    await page.locator('#stage').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Shift+KeyB');
    expect(await page.evaluate(() => [...(window as any).mochiStudio.activeExpressions])).toEqual([
      'Blush',
    ]);
    expect((page as any).errors).toEqual([]);
    await page.close();
  });

  it('exports settings with item files as a zip and imports them back', async () => {
    const page = await openStudio();
    await page.locator('#item-zip').setInputFiles({
      name: 'Hat.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(syntheticItemZip()),
    });
    await page.waitForFunction(() => (window as any).mochiStudio.runtime.items().length === 1);
    await openSection(page, 'Model');
    await page.locator('#export-items').check();
    expect(await page.locator('#item-terms-note').isVisible()).toBe(true);
    const [d] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export…' }).click(),
    ]);
    expect(d.suggestedFilename()).toBe('test.mochi-settings.zip');
    const zip = readFileSync((await d.path())!);

    // Remove the item, then import the zip: it comes back with new files.
    const oldId = await page.evaluate(() => (window as any).mochiStudio.items[0].id);
    await page.evaluate((id) => (window as any).mochiStudio.removeItem(id), oldId);
    expect(await page.evaluate(() => (window as any).mochiStudio.runtime.items().length)).toBe(0);
    await page.evaluate(
      (bytes) => (window as any).mochiStudio.importSettingsFile(new Uint8Array(bytes)),
      [...zip],
    );
    const items = await page.evaluate(() => (window as any).mochiStudio.runtime.items());
    expect(items).toHaveLength(1);
    expect(items[0].id).not.toBe(oldId);
    await page.close();
  });

  it('sets the noise gate and shows the input level', async () => {
    const page = await openStudio();
    await openSection(page, 'Audio');
    await page.locator('#mic-toggle').click();
    await expect.poll(() => page.locator('#mic-indicator').getAttribute('data-on')).toBe('true');
    await page.locator('details.advanced summary').click();
    await page.locator('#gate').fill('-30');
    expect(await page.locator('#gate-value').textContent()).toBe('-30 dB');
    await expect
      .poll(() =>
        page.evaluate(() => (window as any).mochiStudio.runtime.model.liveLipSync.settings.gate),
      )
      .toBe(-30);
    await expect
      .poll(() => page.evaluate(() => (window as any).mochiStudio.micLevel))
      .toBeGreaterThan(-200);
    expect(await page.locator('.meter .gate').evaluate((e) => (e as HTMLElement).style.left)).toBe(
      '62.5%',
    );
    await page.locator('#mic-toggle').click();
    await page.close();
  });
});
