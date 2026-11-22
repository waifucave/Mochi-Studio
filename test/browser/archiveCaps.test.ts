import type { Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { craftZip, crc32, zeros } from '../support/craftedZip';
import { openSection, startHarness, syntheticModelZip, type Harness } from './harness';

/**
 * Archives from outside, through the app's own file inputs: a model zip,
 * an item zip and a settings file, each crafted to be too large or damaged.
 * The person is told which, in plain words.
 */
let H: Harness;
let page: Page;
const MB = 2 ** 20;
const enc = new TextEncoder();
const manifest = {
  name: 'Crafted/c.model3.json',
  data: enc.encode(JSON.stringify({ Version: 3, FileReferences: { Moc: 'c.moc3', Textures: [] } })),
};
const toast = () => page.locator('.toast').last().textContent();
const choose = (id: string, name: string, zip: Uint8Array) =>
  page.locator(id).setInputFiles({ name, mimeType: 'application/zip', buffer: Buffer.from(zip) });

beforeAll(async () => {
  H = await startHarness();
  page = await H.context.newPage();
  await page.goto(H.url);
  await page.waitForFunction(() => 'mochiStudio' in window);
}, 60_000);
afterAll(async () => {
  await H?.close();
});

describe('archives from outside', () => {
  it('refuses a model zip bomb as too large, and a damaged one as damaged', async () => {
    await choose(
      '#model-zip',
      'Bomb.zip',
      craftZip([manifest, { name: 'Crafted/c.moc3', deflated: zeros(65 * MB) }]),
    );
    await expect
      .poll(toast, { timeout: 15_000 })
      .toMatch(
        /This model is larger than we accept\. “Crafted\/c\.moc3” is 65 MB; the most for one file is 64 MB\./,
      );

    const moc = enc.encode('not really a moc file');
    await choose(
      '#model-zip',
      'Damaged.zip',
      craftZip([manifest, { name: 'Crafted/c.moc3', data: moc, crc: crc32(moc) ^ 1 }]),
    );
    await expect
      .poll(toast, { timeout: 15_000 })
      .toMatch(/This model is a damaged zip, so it can’t be opened\./);

    const crowded = craftZip([
      manifest,
      ...Array.from({ length: 2000 }, (_, i) => ({
        name: `Crafted/x/${i}`,
        data: new Uint8Array(1),
      })),
    ]);
    await choose('#model-zip', 'Crowded.zip', crowded);
    await expect
      .poll(toast, { timeout: 15_000 })
      .toMatch(/It has 2,001 files; the most is 2,000\./);
    expect(await page.evaluate(() => (window as any).mochiStudio.model)).toBeUndefined();
  });

  it('refuses an item zip bomb in the item’s own words', async () => {
    await choose('#model-zip', 'Test.zip', syntheticModelZip());
    await page.waitForFunction(() => (window as any).mochiStudio.settings !== undefined);
    await choose(
      '#item-zip',
      'Prop.zip',
      craftZip([manifest, { name: 'Crafted/c.moc3', deflated: zeros(65 * MB) }]),
    );
    await expect.poll(toast, { timeout: 15_000 }).toMatch(/This item is larger than we accept\./);
    expect(await page.evaluate(() => (window as any).mochiStudio.items.length)).toBe(0);
  });

  it('refuses a settings file with a zip bomb among its item files', async () => {
    const settings = await page.evaluate(async () => {
      const s = (window as any).mochiStudio;
      return new TextDecoder().decode(await s.exportSettingsFile(false));
    });
    const withItem = JSON.parse(settings);
    const target = withItem.settings ?? withItem;
    target.items = [{ id: 'item-a', label: 'Hat', visible: true, pinned: true }];
    const zip = craftZip([
      { name: 'mochi-settings.json', data: enc.encode(JSON.stringify(withItem)) },
      { name: 'items/item-a/hat.model3.json', data: enc.encode('{}') },
      { name: 'items/item-a/t.png', deflated: zeros(65 * MB) },
    ]);
    await openSection(page, 'Model');
    const chooser = page.waitForEvent('filechooser');
    await page.locator('button:visible', { hasText: /^Import…$/ }).click();
    await (
      await chooser
    ).setFiles({ name: 'Settings.zip', mimeType: 'application/zip', buffer: Buffer.from(zip) });
    await expect
      .poll(toast, { timeout: 15_000 })
      .toMatch(
        /This settings file is larger than we accept\. “items\/item-a\/t\.png” is 65 MB; the most for one file is 64 MB\./,
      );
  });
});
