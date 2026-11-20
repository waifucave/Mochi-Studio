import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import {
  startHarness,
  syntheticItemZip,
  syntheticModelZip,
  type Harness,
  openSection,
} from './harness';

/**
 * Milestone 1 on the real renderer: Mochi2D draws a made-up model (built
 * with Mochi2D's writeMoc, see test/support/syntheticModel.ts), items, and
 * live lip sync from Chromium's fake microphone.
 */
let H: Harness;
beforeAll(async () => {
  H = await startHarness();
});
afterAll(async () => {
  await H?.close();
});

const file = (name: string, data: Uint8Array) => ({
  name,
  mimeType: 'application/zip',
  buffer: Buffer.from(data),
});

async function openStudio(): Promise<Page> {
  const page = await H.context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(H.url);
  await page.waitForFunction(() => 'mochiStudio' in window);
  (page as unknown as { errors: string[] }).errors = errors;
  await page.locator('#model-zip').setInputFiles(file('Test.zip', syntheticModelZip()));
  await page.waitForFunction(() => (window as any).mochiStudio.settings !== undefined);
  return page;
}

/** Statistics of the opaque pixels of a screenshot of the stage, computed in the page. */
async function shot(page: Page): Promise<{
  count: number;
  lum: number;
  cx: number;
  cy: number;
  w: number;
  h: number;
}> {
  return page.evaluate(async () => {
    const blob: Blob = await (window as any).mochiStudio.runtime.screenshot();
    const img = await createImageBitmap(blob);
    const c = new OffscreenCanvas(img.width, img.height);
    const g = c.getContext('2d')!;
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, img.width, img.height).data;
    let count = 0;
    let lum = 0;
    let sx = 0;
    let sy = 0;
    for (let y = 0; y < img.height; y++)
      for (let x = 0; x < img.width; x++)
        if (d[(y * img.width + x) * 4 + 3]! > 128) {
          count++;
          lum += d[(y * img.width + x) * 4]! + d[(y * img.width + x) * 4 + 1]!;
          sx += x;
          sy += y;
        }
    return { count, lum, cx: sx / count, cy: sy / count, w: img.width, h: img.height };
  });
}

describe('the Mochi2D renderer behind AvatarRuntime', () => {
  it('draws the model, with parameters, zoom, position and rotation', async () => {
    const page = await openStudio();
    await expect.poll(() => page.locator('.model-info').textContent()).toContain('Mochi2D');
    const s = (o: Record<string, number>) =>
      page.evaluate((v) => ((window as any).mochiStudio.overrides = v), o);
    await s({ ParamMouthOpenY: 0 });
    await page.waitForTimeout(200);
    const closed = await shot(page);
    expect(closed.count).toBeGreaterThan(1000);
    await s({ ParamMouthOpenY: 1 });
    await page.waitForTimeout(200);
    const open = await shot(page);
    // The darker mouth mesh grows over the body.
    expect(open.lum).toBeLessThan(closed.lum * 0.98);

    // Position: x is in canvas heights, positive to the right; y positive down.
    const move = (t: Record<string, number>) =>
      page.evaluate((t) => {
        const st = (window as any).mochiStudio;
        st.updateSettings({ transform: { ...st.settings.transform, ...t } });
      }, t);
    await move({ x: 0.1, y: 0.05 });
    await page.waitForTimeout(200);
    const moved = await shot(page);
    expect(moved.cx - open.cx).toBeCloseTo(0.1 * open.h, -1);
    expect(moved.cy - open.cy).toBeCloseTo(0.05 * open.h, -1);
    // Zoom 1.5: about 2.25 times the pixels, less what the canvas edge cuts off.
    await move({ x: 0, y: 0, zoom: 1.5 });
    await page.waitForTimeout(200);
    const zoomed = await shot(page);
    expect(zoomed.count / open.count).toBeGreaterThan(1.6);
    // Rotation goes to Mochi2D's view (counterclockwise), not to the canvas
    // element; Mochi Studio's is clockwise, as in CSS. The model turns about
    // its own center, so its center stays where the offset puts it.
    // Zoomed out, so that the canvas edge cuts nothing off.
    await move({ x: 0, y: 0, zoom: 0.5, rotation: 30 });
    await page.waitForTimeout(200);
    expect(await page.locator('#stage').evaluate((c) => c.style.transform)).toBe('');
    expect(
      await page.evaluate(() => (window as any).mochiStudio.runtime.view.viewTransform.rotation),
    ).toBeCloseTo(-30);
    const turned = await shot(page);
    expect(turned.count).toBeGreaterThan(1000);
    // The offset stays on screen whatever the rotation: right is right, down is down.
    await move({ x: 0.1, y: 0.05 });
    await page.waitForTimeout(200);
    const turnedMoved = await shot(page);
    expect(turnedMoved.count / turned.count).toBeCloseTo(1, 2);
    expect(turnedMoved.cx - turned.cx).toBeCloseTo(0.1 * open.h, -1);
    expect(turnedMoved.cy - turned.cy).toBeCloseTo(0.05 * open.h, -1);
    // Settings persist in this browser profile: put the model back for the next tests.
    await move({ x: 0, y: 0, zoom: 1, rotation: 0 });
    await page.evaluate(() => (window as any).mochiStudio.flushSave());
    expect((page as any).errors).toEqual([]);
    await page.close();
  });

  it('layers expressions and plays motions, holding the last frame', async () => {
    const page = await openStudio();
    const rt = 'window.mochiStudio.runtime';
    const added = () =>
      page.evaluate(() => (window as any).mochiStudio.runtime.model.addedExpressions.join());
    await page.evaluate(() => (window as any).mochiStudio.setExpression('Blush', true));
    await expect.poll(added).toContain('blush.exp3.json');
    await page.evaluate(() => (window as any).mochiStudio.setExpression('Blush', false));
    await expect.poll(added).toBe('');
    const finished = page.evaluate(
      () =>
        new Promise((r) =>
          (window as any).mochiStudio.events.on('motionFinished', (p: unknown) => r(p)),
        ),
    );
    await page.evaluate(() =>
      (window as any).mochiStudio.playMotion({ group: 'Wave', index: 0 }, 'hold'),
    );
    expect(await finished).toEqual({ motion: { group: 'Wave', index: 0 } });
    // Mochi2D holds the last frame: the motion stays, and its values win over tracking.
    expect(await page.evaluate(`${rt}.held`)).toEqual({ ref: { group: 'Wave', index: 0 } });
    const motions = () => page.evaluate(() => (window as any).mochiStudio.runtime.model.motions);
    expect(await motions()).toHaveLength(1);
    const angle = () =>
      page.evaluate(() => (window as any).mochiStudio.runtime.model.getParameter('ParamAngleZ'));
    // The motion ends at 0; breath still adds a few degrees on top.
    for (const o of [-25, 25]) {
      await page.evaluate((o) => ((window as any).mochiStudio.overrides = { ParamAngleZ: o }), o);
      await page.waitForTimeout(200);
      expect(Math.abs(await angle())).toBeLessThan(10);
    }
    await page.evaluate(() => ((window as any).mochiStudio.overrides = {}));
    // Pressing it again releases it.
    await page.evaluate(() =>
      (window as any).mochiStudio.playMotion({ group: 'Wave', index: 0 }, 'hold'),
    );
    expect(await page.evaluate(`${rt}.held`)).toBeUndefined();
    await expect.poll(motions).toEqual([]);
    await page.close();
  });

  it('mixes Mochi2D live lip sync from the microphone with the tracked mouth', async () => {
    const page = await openStudio();
    const mouth = () =>
      page.evaluate(() => {
        const m = (window as any).mochiStudio.runtime.model.runtime;
        const i = m.instance.parameterIndex('ParamMouthOpenY');
        return m.instance.parameterValues[i] as number;
      });
    const setMode = (mode: string) =>
      page.evaluate((mode) => {
        const st = (window as any).mochiStudio;
        st.updateSettings({ lipSync: { ...st.settings.lipSync, mode, gain: 4 } });
      }, mode);
    await setMode('microphone');
    await openSection(page, 'Audio');
    await page.locator('#mic-toggle').click();
    await expect.poll(() => page.locator('#mic-indicator').getAttribute('data-on')).toBe('true');
    // Chromium's fake microphone beeps: the mouth opens at some point.
    let peak = 0;
    for (let i = 0; i < 40 && peak < 0.2; i++) {
      peak = Math.max(peak, await mouth());
      await page.waitForTimeout(50);
    }
    expect(peak).toBeGreaterThan(0.2);
    expect(await page.evaluate(() => (window as any).mochiStudio.micLevel)).toBeGreaterThan(-200);

    // Camera only: the microphone's effect is silenced.
    await setMode('tracking');
    // The value falls with Mochi2D's release time.
    await page.waitForTimeout(1500);
    let max = 0;
    for (let i = 0; i < 20; i++) {
      max = Math.max(max, await mouth());
      await page.waitForTimeout(25);
    }
    expect(max).toBeLessThan(0.02);

    // Max: Mochi2D takes the larger of the two in the same frame.
    await setMode('max');
    await page.evaluate(() => ((window as any).mochiStudio.overrides = { ParamMouthOpenY: 0.3 }));
    await expect
      .poll(() => page.evaluate(() => (window as any).mochiStudio.runtime.model.liveLipSync.mix))
      .toBe('max');
    let low = 1;
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(25);
      low = Math.min(low, await mouth());
    }
    expect(low).toBeGreaterThanOrEqual(0.29);

    // Add: a tracked (overridden) base plus the microphone never goes below the base.
    await setMode('add');
    await page.evaluate(() => ((window as any).mochiStudio.overrides = { ParamMouthOpenY: 0.3 }));
    let min = 1;
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(25);
      min = Math.min(min, await mouth());
    }
    expect(min).toBeGreaterThanOrEqual(0.29);
    await page.locator('#mic-toggle').click();
    await expect.poll(() => page.locator('#mic-indicator').getAttribute('data-on')).toBe('false');
    await page.close();
  });

  it('adds items, shows and hides them, pins them, keeps them, and shows them in the output', async () => {
    const page = await openStudio();
    await openSection(page, 'Items');
    const before = await shot(page);
    await page.locator('#item-zip').setInputFiles(file('Hat.zip', syntheticItemZip()));
    await expect.poll(() => page.locator('.items .item').count()).toBe(1);
    const id = await page.evaluate(() => (window as any).mochiStudio.items[0].id);
    const items = () => page.evaluate(() => (window as any).mochiStudio.runtime.items());
    expect((await items())[0]).toMatchObject({ id, visible: true, pinned: false });
    // Move it off the model's centre and draw it: more opaque pixels.
    await page.evaluate((id) => {
      (window as any).mochiStudio.placeItem(id, { x: 0.3, y: 0.3, scale: 0.5 });
    }, id);
    await page.waitForTimeout(200);
    expect((await shot(page)).count).toBeGreaterThan(before.count);

    // A hotkey shows and hides it.
    await page.evaluate((id) => {
      const st = (window as any).mochiStudio;
      st.updateSettings({
        hotkeys: [
          { id: 'hi', label: '', keys: 'KeyH', button: true, action: { type: 'item', item: id } },
        ],
      });
    }, id);
    await page.locator('#stage').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('KeyH');
    expect((await items())[0].visible).toBe(false);
    expect(await page.locator('.hotkey-buttons [data-hotkey=hi]').textContent()).toContain('Hat');
    await page.keyboard.press('KeyH');
    expect((await items())[0].visible).toBe(true);

    // Pin it to the model where it now is: back over the body.
    await page.evaluate((id) => (window as any).mochiStudio.placeItem(id, { x: 0, y: 0 }), id);
    expect(await page.evaluate((id) => (window as any).mochiStudio.pinItem(id, true), id)).toBe(
      true,
    );
    expect((await items())[0].pinned).toBe(true);

    // The output view gets the item.
    const out = await H.context.newPage();
    await out.goto(new URL('output.html', H.url).href);
    await out.waitForFunction(() => document.body.dataset.items === '1');
    await expect
      .poll(() => out.evaluate(() => (window as any).mochiOutput.runtime.items()[0]?.pinned))
      .toBe(true);
    await out.close();

    // Saved: after a reload the item comes back from IndexedDB, still pinned.
    await page.evaluate(() => (window as any).mochiStudio.flushSave());
    await page.reload();
    await page.waitForFunction(() => 'mochiStudio' in window);
    await page.locator('#model-zip').setInputFiles(file('Test.zip', syntheticModelZip()));
    await page.waitForFunction(() => (window as any).mochiStudio.runtime.items().length === 1);
    expect((await items())[0]).toMatchObject({ id, visible: true, pinned: true });

    // Removing it removes its hotkey too.
    await page.evaluate((id) => (window as any).mochiStudio.removeItem(id), id);
    expect(await items()).toEqual([]);
    expect(await page.evaluate(() => (window as any).mochiStudio.settings.hotkeys)).toEqual([]);
    expect((page as any).errors).toEqual([]);
    await page.close();
  });

  it('keeps two copies of one item in their own places', async () => {
    const page = await openStudio();
    await page.evaluate(() => {
      const st = (window as any).mochiStudio;
      for (const i of [...st.items]) st.removeItem(i.id);
    });
    await openSection(page, 'Items');
    for (let n = 1; n <= 2; n++) {
      await page.locator('#item-zip').setInputFiles(file('Hat.zip', syntheticItemZip()));
      await expect.poll(() => page.locator('.items .item').count()).toBe(n);
    }
    const ids: string[] = await page.evaluate(() =>
      (window as any).mochiStudio.items.map((i: any) => i.id),
    );
    // Mochi2D knows each copy by Mochi Studio's id.
    expect(
      await page.evaluate(() =>
        (window as any).mochiStudio.runtime.view.items.map((i: any) => i.id),
      ),
    ).toEqual(ids);
    await page.evaluate(([a, b]) => {
      const st = (window as any).mochiStudio;
      st.placeItem(a, { x: -0.3, y: 0.1 });
      st.placeItem(b, { x: 0.3, y: -0.1 });
    }, ids);
    const layout = await page.evaluate(() => (window as any).mochiStudio.settings.itemLayout);
    expect(layout.items.map((e: any) => e.id)).toEqual(ids);
    const places = () =>
      page.evaluate(() =>
        (window as any).mochiStudio.runtime
          .items()
          .map((i: any) => [i.id, +i.placement.x.toFixed(3), +i.placement.y.toFixed(3)]),
      );
    const before = await places();
    // After a reload, each copy comes back to its own place.
    await page.evaluate(() => (window as any).mochiStudio.flushSave());
    await page.reload();
    await page.waitForFunction(() => 'mochiStudio' in window);
    await page.locator('#model-zip').setInputFiles(file('Test.zip', syntheticModelZip()));
    await page.waitForFunction(() => (window as any).mochiStudio.runtime.items().length === 2);
    expect(await places()).toEqual(before);
    for (const id of ids)
      await page.evaluate((id) => (window as any).mochiStudio.removeItem(id), id);
    expect((page as any).errors).toEqual([]);
    await page.close();
  });

  it('keeps background and frame cap app-wide unless a model overrides them', async () => {
    const page = await openStudio();
    const st = (fn: string) => page.evaluate(`(() => { const s = window.mochiStudio; ${fn} })()`);
    await st(`s.setStage({ background: { kind: 'color', color: '#112233' }, fpsCap: 30 })`);
    expect(await st('return s.settings.stageOverride')).toBe(false);
    expect(await st('return s.app.fpsCap')).toBe(30);
    await st('s.setStageOverride(true)');
    await st(`s.setStage({ background: { kind: 'chroma', color: '#00ff00' } })`);
    expect(await st('return s.app.background.kind')).toBe('color');
    expect(await st('return s.stage.background.kind')).toBe('chroma');
    await st('s.setStageOverride(false)');
    expect(await st('return s.stage.background.kind')).toBe('color');
    await st(`s.setStage({ background: { kind: 'transparent' }, fpsCap: 60 })`);
    await page.close();
  });
});
