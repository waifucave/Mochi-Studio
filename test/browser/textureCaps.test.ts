import { readFileSync } from 'node:fs';
import { zipSync } from 'fflate';
import type { Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { avifStart, pngDeclaring } from '../support/craftedTexture';
import { syntheticModelFiles } from '../support/syntheticModel';
import { startHarness, syntheticModelZip, type Harness } from './harness';

/**
 * Textures and motion sounds through the app's own inputs, with Mochi2D's
 * caps: a model the person opens, an item zip, a dropped picture. A texture
 * past a cap (its header honest), a lying one (a few hundred bytes declaring
 * a huge size), and one in a format Mochi2D doesn't read are each refused
 * in plain words. (A shared model: collab.test.ts; a plugin's picture:
 * pluginItems.test.ts.)
 */
let H: Harness;
let page: Page;
const enc = new TextEncoder();
const toast = () => page.locator('.toast').last().textContent();
const logText = () =>
  page.evaluate(() =>
    ((window as any).mochiLog.entries as Array<{ text: string }>).map((e) => e.text).join('\n'),
  );

/** The synthetic model (or item) with its texture replaced, and more textures if given. */
function modelZip(folder: string, textures: Uint8Array[], item = false): Uint8Array {
  const files = syntheticModelFiles(item ? { name: 'hat', withItemExtras: true } : {});
  const name = item ? 'hat' : 'test';
  const settings = JSON.parse(new TextDecoder().decode(files[`${name}.model3.json`]));
  settings.FileReferences.Textures = textures.map((_, i) => `texture_${i}.png`);
  delete files['texture_00.png'];
  textures.forEach((t, i) => (files[`texture_${i}.png`] = t));
  files[`${name}.model3.json`] = enc.encode(JSON.stringify(settings));
  return zipSync(Object.fromEntries(Object.entries(files).map(([p, d]) => [`${folder}/${p}`, d])), {
    level: 1,
  });
}

const choose = (id: string, name: string, zip: Uint8Array) =>
  page.locator(id).setInputFiles({ name, mimeType: 'application/zip', buffer: Buffer.from(zip) });

/** The model shown now: its settings file, or undefined. */
const shown = () =>
  page.evaluate(() => (window as any).mochiStudio.model?.manifest.file as string | undefined);

beforeAll(async () => {
  H = await startHarness();
  page = await H.context.newPage();
  await page.goto(H.url);
  await page.waitForFunction(() => 'mochiStudio' in window);
}, 60_000);
afterAll(async () => {
  await H?.close();
});

describe('a texture past the caps, a lying one, and one in a format we don’t open', () => {
  it('refuses them in a model the person opens, and keeps the model shown before', async () => {
    await choose('#model-zip', 'Test.zip', syntheticModelZip());
    await page.waitForFunction(() => (window as any).mochiStudio.settings !== undefined);
    expect(await shown()).toBe('test.model3.json');

    const cases: Array<[string, Uint8Array[], RegExp]> = [
      [
        'Wide.zip',
        [pngDeclaring(8193, 16)],
        /^This model is larger than we accept\. Its texture “texture_0\.png” is 8,193 × 16 pixels; the most is 8,192 a side\./,
      ],
      [
        'Many.zip',
        Array(5).fill(pngDeclaring(8192, 8192)),
        /^This model is larger than we accept\. Its textures come to 335,544,320 pixels; the most in all is 268,435,456\./,
      ],
      [
        'Lying.zip',
        [pngDeclaring(30000, 30000, true)],
        /^This model can’t be opened\. Its texture “texture_0\.png” isn’t a picture we can read: it is damaged, or shorter than the size it declares\. Download or copy it again\./,
      ],
      [
        'Avif.zip',
        [avifStart()],
        /^This model can’t be opened\. Its texture “texture_0\.png” is an AVIF picture, which we don’t open\. Save it as PNG and try again\./,
      ],
    ];
    for (const [name, textures, message] of cases) {
      await choose('#model-zip', name, modelZip('Crafted', textures));
      await expect.poll(toast, { timeout: 20_000 }).toMatch(message);
      // Nothing of it is shown: the model from before stays.
      expect(await shown()).toBe('test.model3.json');
    }
    // The stage still draws the model from before.
    const drawn = await page.evaluate(() => (window as any).mochiStudio.framesPainted as number);
    await page.waitForTimeout(500);
    expect(
      await page.evaluate(() => (window as any).mochiStudio.framesPainted as number),
    ).toBeGreaterThan(drawn);
  });

  it('refuses them in an item, in the item’s words', async () => {
    const cases: Array<[Uint8Array, RegExp]> = [
      [
        pngDeclaring(16, 9000),
        /^This item is larger than we accept\. Its texture “texture_0\.png” is 16 × 9,000 pixels; the most is 8,192 a side\./,
      ],
      [
        pngDeclaring(20000, 20000, true),
        /^This item can’t be opened\. Its texture .* isn’t a picture/,
      ],
      [avifStart(), /^This item can’t be opened\. Its texture .* is an AVIF picture/],
    ];
    for (const [texture, message] of cases) {
      await choose('#item-zip', 'Prop.zip', modelZip('Prop', [texture], true));
      await expect.poll(toast, { timeout: 20_000 }).toMatch(message);
    }
    expect(await page.evaluate(() => (window as any).mochiStudio.items.length)).toBe(0);
  });

  it('refuses a dropped picture past the cap, a lying one, and says why', async () => {
    const drop = (name: string, bytes: Uint8Array) =>
      page.evaluate(
        ({ name, b64 }) => {
          const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
          const dt = new DataTransfer();
          dt.items.add(new File([bytes], name, { type: 'image/png' }));
          document
            .querySelector('.stage-wrap')!
            .dispatchEvent(
              new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }),
            );
        },
        { name, b64: Buffer.from(bytes).toString('base64') },
      );
    await drop('huge.png', pngDeclaring(9000, 8000));
    await expect
      .poll(toast, { timeout: 15_000 })
      .toMatch(
        /This picture is larger than we accept\. It is 9,000 × 8,000 pixels; the most is 64 million pixels\./,
      );
    await drop('lying.png', pngDeclaring(30000, 30000, true));
    await expect
      .poll(toast, { timeout: 15_000 })
      .toMatch(/This picture can’t be read: it is damaged, or shorter than the size it declares\./);
    expect(await page.evaluate(() => (window as any).mochiStudio.items.length)).toBe(0);
  });
});

describe('a model’s own compressed motion sounds', () => {
  it('play for a model the person opens; one the browser can’t decode, or missing, is named in the log', async () => {
    const files = syntheticModelFiles();
    const settings = JSON.parse(new TextDecoder().decode(files['test.model3.json']));
    settings.FileReferences.Motions.Wave[0].Sound = 'sounds/tone.ogg';
    settings.FileReferences.Motions.Wave.push(
      { File: 'wave.motion3.json', Sound: 'sounds/broken.ogg' },
      // Named in the settings, not in the zip: since Mochi2D 0.24.1 it is named in the
      // warnings when its motion starts (it was dropped silently).
      { File: 'wave.motion3.json', Sound: 'sounds/missing.ogg' },
    );
    files['test.model3.json'] = enc.encode(JSON.stringify(settings));
    files['sounds/tone.ogg'] = new Uint8Array(readFileSync('test/fixtures/tone.ogg'));
    // An Ogg's first bytes, then nothing a decoder can use.
    files['sounds/broken.ogg'] = new Uint8Array([...enc.encode('OggS'), ...new Uint8Array(60)]);
    const zip = zipSync(
      Object.fromEntries(Object.entries(files).map(([p, d]) => [`Voice/${p}`, d])),
    );
    await choose('#model-zip', 'Voice.zip', zip);
    await page.waitForFunction(
      () => (window as any).mochiStudio.model?.files.label === 'Voice.zip',
      undefined,
      { timeout: 20_000 },
    );
    // Without the option for compressed sounds, the load would name both as not WAV.
    const notices = await page.evaluate(() => (window as any).mochiStudio.info.notices as string[]);
    expect(notices.filter((n) => /tone\.ogg|broken\.ogg/.test(n))).toEqual([]);

    await page.evaluate(() =>
      (window as any).mochiStudio.playMotion({ group: 'Wave', index: 0 }, 'once'),
    );
    await page.waitForTimeout(1500);
    expect(await logText()).not.toMatch(/tone\.ogg/);
    await page.evaluate(() =>
      (window as any).mochiStudio.playMotion({ group: 'Wave', index: 1 }, 'once'),
    );
    await expect.poll(logText, { timeout: 10_000 }).toMatch(/broken\.ogg/);
    // A sound that isn't there reaches the log too, the same way.
    await page.evaluate(() =>
      (window as any).mochiStudio.playMotion({ group: 'Wave', index: 2 }, 'once'),
    );
    await expect.poll(logText, { timeout: 10_000 }).toMatch(/missing\.ogg/);
  });
});
