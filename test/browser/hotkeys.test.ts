import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, syntheticModelZip, type Harness, openSection } from './harness';

/** Chords (keys held together) and the turn-off options, from the keyboard. */
let H: Harness;
beforeAll(async () => {
  H = await startHarness();
});
afterAll(async () => {
  await H?.close();
});

describe('hotkeys in Chromium', () => {
  it('fires chords, turns "while held" hotkeys off on release, and times others out', async () => {
    const page = await H.context.newPage();
    await page.goto(H.url);
    await page.waitForFunction(() => 'mochiStudio' in window);
    await page.locator('#model-zip').setInputFiles({
      name: 'Test.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(syntheticModelZip()),
    });
    await page.waitForFunction(() => (window as any).mochiStudio.settings !== undefined);
    await page.evaluate(() =>
      (window as any).mochiStudio.updateSettings({
        hotkeys: [
          {
            id: 'chord',
            label: '',
            keys: 'KeyQ+KeyW',
            button: false,
            action: { type: 'expression', expression: 'Blush' },
            release: 'hold',
          },
          {
            id: 'timed',
            label: '',
            keys: 'KeyT',
            button: true,
            action: { type: 'expression', expression: 'Blush' },
            release: 'timer',
            seconds: 0.5,
          },
        ],
      }),
    );
    const active = () => page.evaluate(() => [...(window as any).mochiStudio.activeExpressions]);
    await page.locator('#stage').click({ position: { x: 5, y: 5 } });
    await page.keyboard.down('KeyQ');
    expect(await active()).toEqual([]);
    await page.keyboard.down('KeyW');
    expect(await active()).toEqual(['Blush']);
    await page.keyboard.up('KeyW');
    expect(await active()).toEqual([]);
    await page.keyboard.up('KeyQ');

    await page.keyboard.press('KeyT');
    expect(await active()).toEqual(['Blush']);
    await expect.poll(active, { timeout: 3000 }).toEqual([]);

    // Capturing a chord in the editor.
    await openSection(page, 'Hotkeys');
    await page.locator('[data-hotkey=timed] .keycap').click();
    await page.keyboard.down('ShiftLeft');
    await page.keyboard.down('KeyA');
    await page.keyboard.down('KeyS');
    await page.keyboard.up('KeyS');
    await page.keyboard.up('KeyA');
    await page.keyboard.up('ShiftLeft');
    await expect
      .poll(() =>
        page.evaluate(() => (window as any).mochiStudio.settings.hotkeys[1].keys as string),
      )
      .toBe('Shift+KeyA+KeyS');
    await page.close();
  });
});
