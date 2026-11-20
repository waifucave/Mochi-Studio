import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeGif } from '../support/gif';
import { encodePng } from '../support/syntheticModel';
import { openSection, startHarness, syntheticModelZip, type Harness } from './harness';

/**
 * The handover setting, and animated items (a GIF,
 * and a folder of PNG frames) drawn frame by frame in the window and in an
 * output view. (The plugin API's frame controls are in pluginBeta.test.ts.)
 */
let H: Harness;
beforeAll(async () => {
  H = await startHarness();
});
afterAll(async () => {
  await H?.close();
});

const palette: Array<[number, number, number]> = [
  [230, 40, 40],
  [40, 200, 70],
  [40, 90, 230],
  [240, 200, 30],
  [160, 60, 200],
];

/** A GIF of solid frames, one palette color each, at 10 fps. */
const solidGif = (n: number): Uint8Array =>
  encodeGif(
    64,
    64,
    palette,
    Array.from({ length: n }, (_, i) => ({ indices: new Uint8Array(64 * 64).fill(i), delay: 10 })),
  );

async function openStudio(): Promise<Page & { errors: string[] }> {
  const page = (await H.context.newPage()) as Page & { errors: string[] };
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(H.url);
  await page.waitForFunction(() => 'mochiStudio' in window);
  await page.locator('#model-zip').setInputFiles({
    name: 'Test.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(syntheticModelZip()),
  });
  await page.waitForFunction(() => (window as any).mochiStudio.settings !== undefined);
  return page;
}

/** The color at the middle of an item, in a page's screenshot (the window's or an output view's). */
function itemColor(page: Page, id: string, output: boolean): Promise<number[]> {
  return page.evaluate(
    async ({ id, output }) => {
      const w = window as any;
      const rt = output ? w.mochiOutput.runtime : w.mochiStudio.runtime;
      const p = rt.items().find((i: any) => i.id === id).placement;
      const at = rt.modelToPage(p.x, p.y);
      const shot = output ? await rt.screenshot() : await w.mochiStudio.screenshot();
      const blob = shot instanceof Blob ? shot : new Blob([shot], { type: 'image/png' });
      const bmp = await createImageBitmap(blob);
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext('2d')!;
      g.drawImage(bmp, 0, 0);
      const canvas = document.querySelector('canvas')!.getBoundingClientRect();
      const k = bmp.width / canvas.width;
      const d = g.getImageData(
        Math.round((at.x - canvas.left) * k),
        Math.round((at.y - canvas.top) * k),
        1,
        1,
      ).data;
      return [d[0]!, d[1]!, d[2]!];
    },
    { id, output },
  );
}

const near = (a: number[], b: readonly number[]): boolean =>
  a.every((v, i) => Math.abs(v - b[i]!) <= 14);

describe('the handover setting and animated items', () => {
  it('sets the handover time in the Camera tab', async () => {
    const page = await openStudio();
    await openSection(page, 'Tracking');
    const input = page.locator('#handover-ms');
    expect(await input.inputValue()).toBe('500');
    await input.fill('1200');
    await input.dispatchEvent('change');
    expect(
      await page.evaluate(() => {
        const s = (window as any).mochiStudio;
        return [s.settings.handoverMs, s.handover.fadeMs];
      }),
    ).toEqual([1200, 1200]);
    await input.fill('0');
    await input.dispatchEvent('change');
    expect(await page.evaluate(() => (window as any).mochiStudio.handover.fadeMs)).toBe(0);
    await page.close();
  });

  it('draws an animated GIF frame by frame, in the window and in an output view', async () => {
    const page = await openStudio();
    const out = await H.context.newPage();
    await out.goto(new URL('output.html', H.url).href);
    await out.waitForFunction(() => document.body.dataset.model?.startsWith('test.model3.json'));
    // Dropped on the stage, as from the desktop.
    await page.evaluate(
      async (b64) => {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const dt = new DataTransfer();
        dt.items.add(new File([bytes], 'spin.gif', { type: 'image/gif' }));
        document
          .querySelector('.stage-wrap')!
          .dispatchEvent(
            new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }),
          );
      },
      Buffer.from(solidGif(5)).toString('base64'),
    );
    await page.waitForFunction(() => (window as any).mochiStudio.items.length === 1, null, {
      timeout: 15_000,
    });
    const id = await page.evaluate(() => (window as any).mochiStudio.items[0].id as string);
    expect(
      await page.evaluate((id) => (window as any).mochiStudio.itemAnimation(id), id),
    ).toMatchObject({
      frames: 5,
      fps: 10,
      playing: true,
    });
    await out.waitForFunction(() => document.body.dataset.items === '1');
    const frameOf = (p: Page, output: boolean) =>
      p.evaluate(
        ({ id, output }) =>
          (output ? (window as any).mochiOutput : (window as any).mochiStudio).runtime.itemFrame(
            id,
          ),
        { id, output },
      );
    // It plays by itself (sampled until three frames were seen: slow test machines draw seldom).
    const seen = new Set<number>();
    await expect
      .poll(
        async () => {
          seen.add(await frameOf(page, false));
          return seen.size;
        },
        { timeout: 10_000, interval: 50 },
      )
      .toBeGreaterThan(2);
    // Paused, then shown one frame at a time: the right color in the window and in the output view.
    await page.evaluate(
      (id) => (window as any).mochiStudio.setItemAnimation(id, { playing: false }),
      id,
    );
    for (const f of [0, 1, 2, 3, 4, 2]) {
      await page.evaluate(
        ({ id, f }) => (window as any).mochiStudio.setItemAnimation(id, { frame: f }),
        { id, f },
      );
      await expect.poll(() => frameOf(out, true)).toBe(f);
      await expect
        .poll(() => itemColor(page, id, false).then((c) => near(c, palette[f]!)))
        .toBe(true);
      await expect
        .poll(() => itemColor(out, id, true).then((c) => near(c, palette[f]!)))
        .toBe(true);
    }
    // The rate and the play state are kept with the item; the Items sheet shows and changes them.
    await page.locator('#menu-button').click();
    await page.locator('#menu-items').click();
    const row = page.locator(`[data-item="${id}"]`);
    expect(await row.locator('.item-animation').textContent()).toContain('5 frames');
    await row.locator('.item-fps').fill('24');
    await row.locator('.item-fps').dispatchEvent('change');
    await row.locator('.item-play').click();
    expect(
      await page.evaluate(() => (window as any).mochiStudio.settings.items[0].animation),
    ).toEqual({ fps: 24, playing: true });
    expect(page.errors).toEqual([]);
    await out.close();
    await page.close();
  });

  it('makes an animated item of a folder of PNG frames', async () => {
    const page = await openStudio();
    // Items are kept per model in this browser profile: start without the earlier test's.
    await page.evaluate(() => {
      const s = (window as any).mochiStudio;
      for (const i of [...s.items]) s.removeItem(i.id);
    });
    const dir = mkdtempSync(join(tmpdir(), 'mochi-frames-'));
    const folder = join(dir, 'Sparkle');
    mkdirSync(folder);
    // Named so that only natural order is right: frame2 before frame10.
    const names = ['frame1.png', 'frame2.png', 'frame10.png'];
    names.forEach((n, i) => {
      const px = new Uint8Array(48 * 48 * 4);
      for (let k = 0; k < 48 * 48; k++) px.set([...palette[i]!, 255], k * 4);
      writeFileSync(join(folder, n), encodePng(48, 48, px));
    });
    await page.locator('#item-folder').setInputFiles(folder);
    await page.waitForFunction(() => (window as any).mochiStudio.items.length === 1, null, {
      timeout: 15_000,
    });
    const id = await page.evaluate(() => (window as any).mochiStudio.items[0].id as string);
    expect(
      await page.evaluate((id) => (window as any).mochiStudio.itemAnimation(id), id),
    ).toMatchObject({
      frames: 3,
      fps: 10,
    });
    await page.evaluate(
      (id) => (window as any).mochiStudio.setItemAnimation(id, { playing: false, frame: 2 }),
      id,
    );
    // Frame 2 is frame10.png, the third color.
    await expect
      .poll(() => itemColor(page, id, false).then((c) => near(c, palette[2]!)))
      .toBe(true);
    expect(page.errors).toEqual([]);
    await page.close();
  });
});
