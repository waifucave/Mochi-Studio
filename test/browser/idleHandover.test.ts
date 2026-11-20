import { readFileSync } from 'node:fs';
import type { Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  openSection,
  startHarness,
  syntheticItemZip,
  syntheticModelZip,
  type Harness,
} from './harness';

/**
 * Tracking wins over the idle animation, with faded
 * handovers, in the control window and in an output view; model items flip
 * with Mochi2D's mirror, by hand and in the Items sheet. (Plugin tints and
 * plugin flips are in plugins.test.ts and pluginItems.test.ts.)
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
) as { frames: Array<{ t: number; face: boolean }> };

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

/**
 * Drives the control window's frames by hand (25 ms apart): `frames` of the
 * recorded session (with or without the face), or none (no tracking), and
 * returns, for each frame, ParamAngleX's idle weight, what Mochi Studio wrote,
 * the base value Mochi2D kept (a motion's result stays in it) and the drawn value.
 */
function drive(
  page: Page,
  frames: Array<{ t: number; face: boolean }> | number,
  face = true,
): Promise<Array<{ w: number; written: number | undefined; base: number; drawn: number }>> {
  return page.evaluate(
    ({ frames, face }) => {
      const s = (window as any).mochiStudio;
      const rt = s.runtime;
      const w = window as any;
      w.clock ??= 1_000_000;
      const out: Array<{ w: number; written: number | undefined; base: number; drawn: number }> =
        [];
      const n = typeof frames === 'number' ? frames : frames.length;
      for (let i = 0; i < n; i++) {
        w.clock += 25;
        if (typeof frames !== 'number') s.feedFrame({ ...frames[i], t: w.clock, face });
        s.frame(w.clock);
        out.push({
          w: rt.idleWeight('ParamAngleX'),
          written: s.lastParams.ParamAngleX,
          base: rt.parameterBase('ParamAngleX'),
          drawn: rt.parameterValue('ParamAngleX'),
        });
      }
      return out;
    },
    { frames, face },
  );
}

describe('tracking over the idle animation', () => {
  it('lets tracking win over the idle animation, with faded handovers, also in output views', async () => {
    const page = await openStudio();
    const out = await H.context.newPage();
    await out.goto(new URL('output.html', H.url).href);
    await out.waitForFunction(() => document.body.dataset.model?.startsWith('test.model3.json'));
    await page.evaluate(() => {
      const s = (window as any).mochiStudio;
      s.stop();
      // Breath also moves the head angle; off, the drawn value is base and idle animation only.
      s.runtime.setEffect('breath', false);
      s.updateSettings({ idleMotion: 'wave.motion3.json' });
    });
    // The output view plays the idle animation too.
    await expect
      .poll(() => out.evaluate(() => (window as any).mochiOutput.runtime.model.motions as string[]))
      .toContain('wave.motion3.json');
    /**
     * `drive` posts dozens of frames' messages to the output view at once; it works through
     * them between its own frames, which a busy machine without a graphics card draws in
     * software: give it the time to reach the last one. The window's source line (refreshed
     * a few times a second) can wait as long on such a machine.
     */
    const viewCatchesUp = { timeout: 15_000 };

    // No face: the idle animation moves the head (−20° at its middle).
    const idle = await drive(page, 30);
    expect(idle.every((f) => f.w === 1 && f.written === undefined)).toBe(true);
    expect(Math.min(...idle.map((f) => f.drawn))).toBeLessThan(-8);

    // A face: the idle weight fades to 0 over about half a second, and then the
    // head shows the tracked value only, while the idle animation goes on.
    const found = await drive(page, fixture.frames.slice(60, 120));
    expect(found[4]!.w).toBeGreaterThan(0);
    expect(found[4]!.w).toBeLessThan(1);
    expect(found.slice(25).every((f) => f.w === 0)).toBe(true);
    // What Mochi Studio wrote is what is drawn: the idle animation leaves it alone.
    for (const f of found.slice(25)) {
      expect(Math.abs(f.base - f.written!)).toBeLessThan(1e-3);
      expect(Math.abs(f.drawn - f.written!)).toBeLessThan(1e-3);
    }
    // The base value is the tracked one, and it moves (the recorded head turns).
    const tracked = found.slice(25).map((f) => f.base);
    expect(Math.max(...tracked) - Math.min(...tracked)).toBeGreaterThan(10);
    await expect
      .poll(
        () => out.evaluate(() => (window as any).mochiOutput.runtime.idleWeight('ParamAngleX')),
        viewCatchesUp,
      )
      .toBe(0);
    await openSection(page, 'Mapping');
    const source = page.locator('.rule[data-output="ParamAngleX"] .source');
    await expect
      .poll(() => source.textContent(), viewCatchesUp)
      .toBe('Driven by tracking (HeadYaw); it overrides the idle animation wave.motion3.json.');

    // The face is lost: the weight fades back to 1, and the last tracked value
    // fades to the default meanwhile (no jump); then the idle animation shows.
    const last = found.at(-1)!.written!;
    const lost = await drive(page, fixture.frames.slice(120, 160), false);
    expect(lost[4]!.w).toBeGreaterThan(0);
    expect(lost[4]!.w).toBeLessThan(1);
    expect(Math.abs(lost[0]!.written! - last)).toBeLessThan(Math.abs(last) * 0.2 + 1);
    expect(Math.abs(lost[4]!.written!)).toBeLessThan(Math.abs(last));
    expect(lost.slice(25).every((f) => f.w === 1 && f.written === undefined)).toBe(true);
    expect(Math.min(...lost.slice(25).map((f) => f.drawn))).toBeLessThan(-8);
    await expect
      .poll(
        () => out.evaluate(() => (window as any).mochiOutput.runtime.idleWeight('ParamAngleX')),
        viewCatchesUp,
      )
      .toBe(1);
    await expect
      .poll(() => source.textContent(), viewCatchesUp)
      .toBe(
        'Driven by the idle animation wave.motion3.json; tracking takes over when a face is found.',
      );
    expect(page.errors).toEqual([]);
    await out.close();
    await page.close();
  });

  it('flips a model item by hand, in the Items sheet, and in output views, with tints', async () => {
    const page = await openStudio();
    const out = await H.context.newPage();
    await out.goto(new URL('output.html', H.url).href);
    await out.waitForFunction(() => document.body.dataset.model?.startsWith('test.model3.json'));
    await page.locator('#item-zip').setInputFiles({
      name: 'Hat.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(syntheticItemZip()),
    });
    await page.waitForFunction(() => (window as any).mochiStudio.items.length === 1);
    const id = await page.evaluate(() => (window as any).mochiStudio.items[0].id as string);
    await out.waitForFunction(() => document.body.dataset.items === '1');
    // Somewhere on the item.
    const p = await page.evaluate((id) => {
      const rt = (window as any).mochiStudio.runtime;
      for (let r = 0; r < 300; r += 6)
        for (let a = 0; a < 360; a += 30) {
          const x = innerWidth / 2 + r * Math.cos((a * Math.PI) / 180);
          const y = innerHeight / 2 + r * Math.sin((a * Math.PI) / 180);
          if (rt.itemAt(x, y) === id) return { x, y };
        }
      return undefined;
    }, id);
    expect(p).toBeDefined();
    const mirrored = () =>
      page.evaluate((id) => (window as any).mochiStudio.isItemMirrored(id), id);
    await page.keyboard.down('Control');
    await page.mouse.click(p!.x, p!.y);
    await page.keyboard.up('Control');
    expect(await mirrored()).toBe(true);
    expect(await page.locator('.toast').textContent()).toContain('Flipped');
    // Saved with the item, and the output view's item is mirrored too.
    expect(
      await page.evaluate(() => (window as any).mochiStudio.settings.items[0].placement.mirror),
    ).toBe(true);
    await expect
      .poll(() =>
        out.evaluate((id) => (window as any).mochiOutput.runtime.itemMap.get(id)?.mirror, id),
      )
      .toBe(true);
    // The Items sheet shows it, and flips it back.
    await page.locator('#menu-button').click();
    await page.locator('#menu-items').click();
    const box = page.locator(`[data-item="${id}"] .item-mirror`);
    expect(await box.isChecked()).toBe(true);
    await box.uncheck();
    expect(await mirrored()).toBe(false);
    await expect
      .poll(() =>
        out.evaluate((id) => (window as any).mochiOutput.runtime.itemMap.get(id)?.mirror, id),
      )
      .toBe(false);
    // Tints reach the output view too: the model's (plugins' ColorTintRequest) and an item's (brightness).
    await page.evaluate((id) => {
      const s = (window as any).mochiStudio;
      s.setModelTints([['ArtMeshBody', [0, 0, 1, 1]]]);
      s.setItemTint(id, [0.5, 0.5, 0.5, 1]);
    }, id);
    await expect
      .poll(() =>
        out.evaluate((id) => {
          const rt = (window as any).mochiOutput.runtime;
          return {
            model: rt.model.getTint('ArtMeshBody'),
            item: [...rt.itemMap.get(id).tints.values()][0],
          };
        }, id),
      )
      .toEqual({ model: [0, 0, 1, 1], item: [0.5, 0.5, 0.5, 1] });
    await page.evaluate((id) => {
      const s = (window as any).mochiStudio;
      s.setModelTints([]);
      s.setItemTint(id, undefined);
    }, id);
    await expect
      .poll(() =>
        out.evaluate((id) => {
          const rt = (window as any).mochiOutput.runtime;
          return rt.model.tints.size + rt.itemMap.get(id).tints.size;
        }, id),
      )
      .toBe(0);
    expect(page.errors).toEqual([]);
    await out.close();
    await page.close();
  });
});
