import type { Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  openSection,
  startHarness,
  syntheticItemZip,
  syntheticReorderingModelZip,
  type Harness,
} from './harness';

/**
 * The art-mesh order's rules that itemLayers.test.ts
 * does not cover, on a synthetic model whose open mouth is drawn behind its
 * body, and the item order in layouts (Mochi2D 0.12.0).
 */
let H: Harness;
let page: Page;
const errors: string[] = [];

const SKIN = [240, 180, 150];
const RED = [220, 60, 60];
const BODY = { x: 0, y: 0.15 };

/** The color at a point of the model (its units), in the window's screenshot. */
function colorAt(at: { x: number; y: number }): Promise<number[]> {
  return page.evaluate(async (at) => {
    const w = window as any;
    const pt = w.mochiStudio.runtime.modelToPage(at.x, at.y);
    const shot = await w.mochiStudio.screenshot();
    const blob = shot instanceof Blob ? shot : new Blob([shot], { type: 'image/png' });
    const bmp = await createImageBitmap(blob);
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext('2d')!;
    g.drawImage(bmp, 0, 0);
    const canvas = document.querySelector('canvas')!.getBoundingClientRect();
    const k = bmp.width / canvas.width;
    const d = g.getImageData(
      Math.round((pt.x - canvas.left) * k),
      Math.round((pt.y - canvas.top) * k),
      1,
      1,
    ).data;
    return [d[0]!, d[1]!, d[2]!];
  }, at);
}
const near = (a: number[], b: readonly number[]): boolean =>
  a.every((v, i) => Math.abs(v - b[i]!) <= 14);
const shows = (at: { x: number; y: number }, color: readonly number[]) =>
  expect.poll(async () => near(await colorAt(at), color), { timeout: 10_000 }).toBe(true);

const ids = () =>
  page.evaluate(() => (window as any).mochiStudio.items.map((i: any) => i.id) as string[]);
async function addHat(): Promise<string> {
  const before = await ids();
  await page.locator('#item-zip').setInputFiles({
    name: 'Hat.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(syntheticItemZip()),
  });
  await page.waitForFunction(
    (n) => (window as any).mochiStudio.runtime.items().length === n + 1,
    before.length,
  );
  const id = (await ids()).find((i) => !before.includes(i))!;
  await page.evaluate(
    (id) => (window as any).mochiStudio.placeItem(id, { x: 0, y: 0, scale: 2, rotation: 0 }),
    id,
  );
  return id;
}
const order = () =>
  page.evaluate(() => (window as any).mochiStudio.runtime.itemOrder() as string[]);

beforeAll(async () => {
  H = await startHarness();
  page = await H.context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(H.url);
  await page.waitForFunction(() => 'mochiStudio' in window);
  await page.locator('#model-zip').setInputFiles({
    name: 'Test.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(syntheticReorderingModelZip()),
  });
  await page.waitForFunction(() => (window as any).mochiStudio.settings !== undefined);
  await page.evaluate(() => {
    const s = (window as any).mochiStudio;
    s.runtime.setEffect?.('breath', false);
    s.setOverrides({ ParamMouthOpenY: 0, ParamAngleX: 0 });
  });
  await page.bringToFront();
}, 60_000);
afterAll(async () => {
  await H?.close();
});

describe('the art-mesh order', () => {
  let hat = '';

  it('follows the art mesh when the model’s drawing order changes', async () => {
    hat = await addHat();
    // Just in front of the mouth, which is drawn over the body while closed: the hat is on top.
    await page.evaluate(
      (id) => (window as any).mochiStudio.runtime.setItemSort(id, { above: 'ArtMeshMouth' }, null),
      hat,
    );
    await shows(BODY, RED);
    // Open, the mouth goes behind the body, and the hat with it.
    await page.evaluate(() => (window as any).mochiStudio.setOverrides({ ParamMouthOpenY: 1 }));
    await shows(BODY, SKIN);
    await page.evaluate(() => (window as any).mochiStudio.setOverrides({ ParamMouthOpenY: 0 }));
    await shows(BODY, RED);
  });

  it('keeps the order among items in the layout, and reads older layouts', async () => {
    const second = await addHat();
    expect(await order()).toEqual([hat, second]);
    await page.evaluate((id) => (window as any).mochiStudio.runtime.stackItems([id]), hat);
    expect(await order()).toEqual([second, hat]);
    // Mochi2D's layout lists the items in drawing order; applying it restores the order.
    const layout = await page.evaluate(() =>
      (window as any).mochiStudio.runtime.exportItemLayout(),
    );
    expect(layout.mochiStudioOrder).toBeUndefined();
    await page.evaluate((id) => (window as any).mochiStudio.runtime.stackItems([id]), second);
    expect(await order()).toEqual([hat, second]);
    await page.evaluate((l) => (window as any).mochiStudio.runtime.applyItemLayout(l), layout);
    expect(await order()).toEqual([second, hat]);
    // A layout saved before (entries as added, the order beside them) is still read.
    const old = {
      ...layout,
      items: [...layout.items].reverse(),
      mochiStudioOrder: [hat, second],
    };
    await page.evaluate((l) => (window as any).mochiStudio.runtime.applyItemLayout(l), old);
    expect(await order()).toEqual([hat, second]);
    expect(errors).toEqual([]);
  });
});

describe('item scenes', () => {
  const run = (name: string, args: Record<string, unknown> = {}) =>
    page.evaluate(([n, a]) => (window as any).mochiStudio.run(n, a), [name, args] as const);
  const visible = (p: Page, id: string, global = 'mochiStudio') =>
    p.evaluate(([id, g]) => (window as any)[g].runtime.isItemVisible(id) as boolean, [
      id,
      global,
    ] as const);

  it('opens from the main menu, and agents make, list and switch scenes, in output views too', async () => {
    const [a, b] = (await ids()) as [string, string];
    // The main menu's «Item scenes»: the Items sheet, at its scenes.
    await page.locator('#menu-button').click();
    await page.locator('#menu-scenes').click();
    await expect.poll(() => page.locator('#item-scenes').isVisible()).toBe(true);
    // An agent makes two scenes of a group, from the items shown now and from one item.
    const first = (await run('create_item_scene', { name: 'Both', group: 'hats' })) as any;
    expect(first.scene).toMatchObject({ name: 'Both', group: 'hats', items: [a, b], on: false });
    await run('create_item_scene', { name: 'One', group: 'hats', items: [b] });
    await expect.poll(() => page.locator('#item-scenes .scene').count()).toBe(2);
    const listed = (await run('list_item_scenes')) as any;
    expect(listed.scenes.map((x: any) => x.name)).toEqual(['Both', 'One']);
    // An output view follows.
    const out = await H.context.newPage();
    await out.goto(new URL('output.html', H.url).href);
    await out.waitForFunction(() => document.body.dataset.items === '2');
    await page.bringToFront();
    await run('set_item_scene', { scene: 'Both', on: true });
    await run('set_item_scene', { scene: 'One', on: true, fade: 0.3 });
    // One scene of the group at a time: the first goes off, and the item only it has hides.
    await expect.poll(() => visible(page, a)).toBe(false);
    expect(await visible(page, b)).toBe(true);
    await expect.poll(() => visible(out, a, 'mochiOutput')).toBe(false);
    expect(await visible(out, b, 'mochiOutput')).toBe(true);
    const now = (await run('list_item_scenes')) as any;
    expect(now.scenes.map((x: any) => [x.name, x.on])).toEqual([
      ['Both', false],
      ['One', true],
    ]);
    // Off again (by toggling), and removed; the items stay as they are.
    await run('set_item_scene', { scene: 'one' });
    await expect.poll(() => visible(page, b)).toBe(false);
    await run('remove_item_scene', { scene: 'One' });
    expect(((await run('list_item_scenes')) as any).scenes).toHaveLength(1);
    await out.close();
    await page.bringToFront();
    await page.keyboard.press('Escape');
    expect(errors).toEqual([]);
  });
});

describe('the left mouse button with a modifier', () => {
  const blush = () =>
    page.evaluate(() => (window as any).mochiStudio.activeExpressions.has('Blush') as boolean);
  it('fires on Alt+click, never on a plain click or a drag', async () => {
    await page.evaluate(() =>
      (window as any).mochiStudio.updateSettings({
        hotkeys: [
          {
            id: 'alt',
            label: 'Blush on Alt+click',
            keys: 'Alt+MouseLeft',
            button: false,
            action: { type: 'expression', expression: 'Blush' },
          },
          {
            id: 'set',
            label: 'Set by clicking',
            keys: '',
            button: false,
            action: { type: 'calibrate' },
          },
        ],
      }),
    );
    const box = (await page.locator('#stage').boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    // A plain click: nothing.
    await page.mouse.click(cx, cy);
    await page.waitForTimeout(200);
    expect(await blush()).toBe(false);
    // Alt and a drag of the model: nothing.
    await page.keyboard.down('Alt');
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 60, cy + 30, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    expect(await blush()).toBe(false);
    // Alt+click: the hotkey.
    await page.mouse.click(cx, cy);
    await expect.poll(blush).toBe(true);
    await page.keyboard.up('Alt');
    // Recorded in the Hotkeys tab by Alt+clicking.
    await openSection(page, 'Hotkeys');
    const keycap = page.locator('[data-hotkey="set"] .keycap');
    await keycap.click();
    await page.keyboard.down('Alt');
    await page.locator('#panel-hotkeys h2').first().click();
    await page.keyboard.up('Alt');
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as any).mochiStudio.settings.hotkeys.find((h: any) => h.id === 'set').keys,
        ),
      )
      .toBe('Alt+MouseLeft');
    await expect.poll(() => keycap.textContent()).toBe('Alt+Left click');
    await page.keyboard.press('Escape');
    expect(errors).toEqual([]);
  });
});
