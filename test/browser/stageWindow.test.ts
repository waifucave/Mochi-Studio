import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { openSection, startHarness, syntheticModelZip, type Harness } from './harness';

/**
 * The stage-first window: the main menu, locks, the log, the
 * model bar, image items with their mouse conventions, mouse hotkeys, the
 * eight-button limit, the camera preview, and what drives each parameter.
 */
let H: Harness;
beforeAll(async () => {
  H = await startHarness();
});
afterAll(async () => {
  await H?.close();
});

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

/** Drops a made-up PNG on the stage (as dragging a file from the desktop does). */
async function dropImage(page: Page, name: string): Promise<string> {
  const before = await page.evaluate(() => (window as any).mochiStudio.items.length as number);
  await page.evaluate(async (name) => {
    const c = new OffscreenCanvas(120, 80);
    const g = c.getContext('2d')!;
    g.fillStyle = '#3a8';
    g.fillRect(0, 0, 60, 80);
    g.fillStyle = '#e53';
    g.fillRect(60, 0, 60, 80);
    const blob = await c.convertToBlob({ type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(new File([blob], name, { type: 'image/png' }));
    document
      .getElementById('stage')!
      .closest('.stage-wrap')!
      .dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, name);
  await page.waitForFunction((n) => (window as any).mochiStudio.items.length > n, before);
  return page.evaluate(() => {
    const items = (window as any).mochiStudio.items;
    return items[items.length - 1].id as string;
  });
}

/** A point on the stage where the item is under the pointer. */
async function pointOn(page: Page, id: string): Promise<{ x: number; y: number }> {
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
  if (!p) throw new Error('item not found on the stage');
  return p;
}

const log = (page: Page): Promise<string> =>
  page.evaluate(async () => {
    document.getElementById('menu-button')!.click();
    document.getElementById('menu-log')!.click();
    const text = document.getElementById('log-list')!.textContent ?? '';
    document.getElementById('log-close')!.click();
    return text;
  });

describe('the stage-first window', () => {
  it('opens the main menu by double-click and ☰, and locks the model position', async () => {
    const page = await openStudio();
    expect(await page.locator('#main-menu').isVisible()).toBe(false);
    await page.locator('#stage').dblclick({ position: { x: 40, y: 400 } });
    expect(await page.locator('#main-menu').isVisible()).toBe(true);
    expect(
      await page.locator('#main-menu [role=menuitem], #main-menu button').allTextContents(),
    ).toEqual([
      'Change model',
      'Screenshot',
      'Background',
      'Items',
      'Item scenes',
      'Lock model position',
      'Lock items',
      'Settings',
      'Log',
    ]);
    await page.keyboard.press('Escape');
    expect(await page.locator('#main-menu').isVisible()).toBe(false);

    // Locked, dragging the stage does not move the model.
    await page.locator('#menu-button').click();
    await page.locator('#menu-lock-model').click();
    const transform = () => page.evaluate(() => (window as any).mochiStudio.settings.transform);
    const before = await transform();
    await page.mouse.move(640, 400);
    await page.mouse.down();
    await page.mouse.move(700, 450, { steps: 5 });
    await page.mouse.up();
    expect(await transform()).toEqual(before);
    await page.locator('#menu-button').click();
    expect(await page.locator('#menu-lock-model').getAttribute('aria-pressed')).toBe('true');

    // The model bar and the settings tabs, in their order.
    await page.locator('#menu-model').click();
    expect(await page.locator('#model-bar').textContent()).toContain('Test.zip');
    await page.keyboard.press('Escape');
    await openSection(page, 'Model');
    expect(await page.getByRole('tab').allTextContents()).toEqual([
      'General',
      'Camera',
      'Model',
      'Hotkeys',
      // Collaboration.
      'Collab',
    ]);
    expect(page.errors).toEqual([]);
    await page.close();
  });

  it('logs toasts, and a model that fails to load points to the log', async () => {
    const page = await openStudio();
    await page.locator('#model-zip').setInputFiles({
      name: 'Broken.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from('not a zip'),
    });
    await expect
      .poll(() => page.locator('.toast').textContent())
      .toContain('The log has the details');
    expect(await log(page)).toContain('Could not load');
    await page.close();
  });

  it('turns dropped images into items: pin, lock, flip and trash with the mouse', async () => {
    const page = await openStudio();
    const id = await dropImage(page, 'sticker.png');
    expect(await page.evaluate(() => (window as any).mochiStudio.items.at(-1).label)).toBe(
      'sticker',
    );

    // Dropped on the model: pinned, and the log names the art mesh.
    let p = await pointOn(page, id);
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    expect(await page.locator('#item-trash').isVisible()).toBe(true);
    await page.mouse.move(p.x + 10, p.y + 10, { steps: 3 });
    await page.mouse.up();
    expect(await page.locator('#item-trash').isVisible()).toBe(false);
    await expect
      .poll(() => page.evaluate((id) => (window as any).mochiStudio.isItemPinned(id), id))
      .toBe(true);
    expect(await log(page)).toMatch(/Pinned “sticker” to the art mesh \S+/);

    // Ctrl+click flips an item (Mochi2D's mirror), and it stays pinned.
    p = await pointOn(page, id);
    await page.keyboard.down('Control');
    await page.mouse.click(p.x, p.y);
    await page.keyboard.up('Control');
    const flipped = () => page.evaluate((id) => (window as any).mochiStudio.isItemMirrored(id), id);
    await expect.poll(flipped).toBe(true);
    expect(await page.evaluate((id) => (window as any).mochiStudio.isItemPinned(id), id)).toBe(
      true,
    );

    // Double-click locks it: it no longer drags.
    p = await pointOn(page, id);
    await page.mouse.dblclick(p.x, p.y);
    await expect
      .poll(() =>
        page.evaluate(
          (id) => (window as any).mochiStudio.items.find((i: any) => i.id === id).locked,
          id,
        ),
      )
      .toBe(true);
    expect(await page.locator('#main-menu').isVisible()).toBe(false);
    const where = () =>
      page.evaluate(
        (id) => (window as any).mochiStudio.items.find((i: any) => i.id === id).placement,
        id,
      );
    const before = await where();
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.mouse.move(p.x + 80, p.y + 40, { steps: 5 });
    await page.mouse.up();
    expect(await where()).toEqual(before);

    // Unlocked again, dragged to the trash: removed.
    await page.mouse.dblclick(p.x, p.y);
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    const box = (await page.locator('#item-trash').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
    expect(await page.locator('#item-trash').getAttribute('data-over')).toBe('true');
    await page.mouse.up();
    await expect.poll(() => page.evaluate(() => (window as any).mochiStudio.items.length)).toBe(0);
    expect(page.errors).toEqual([]);
    await page.close();
  });

  it('fires mouse-button hotkeys and shows at most eight buttons', async () => {
    const page = await openStudio();
    await page.evaluate(() =>
      (window as any).mochiStudio.updateSettings({
        hotkeys: Array.from({ length: 10 }, (_, i) => ({
          id: `b${i}`,
          label: `B${i}`,
          keys: i === 0 ? 'MouseMiddle' : '',
          button: true,
          action: { type: 'expression', expression: 'Blush' },
          release: 'toggle',
        })),
      }),
    );
    // The buttons are drawn after the settings change, not within the call.
    await expect.poll(() => page.locator('.hotkey-buttons button').count()).toBe(8);
    await page.mouse.click(300, 300, { button: 'middle' });
    await expect
      .poll(() => page.evaluate(() => [...(window as any).mochiStudio.activeExpressions]))
      .toEqual(['Blush']);
    await page.close();
  });

  it('keeps the camera picture off screen unless asked, and says so', async () => {
    const page = await openStudio();
    await openSection(page, 'Tracking');
    expect(await page.locator('#camera-privacy').textContent()).toContain('never sent');
    expect(await page.locator('#camera-preview').isChecked()).toBe(false);
    await page.close();
  });

  it('shows which source drives each parameter', async () => {
    const page = await openStudio();
    await openSection(page, 'Mapping');
    const source = (output: string) => page.locator(`.rule[data-output="${output}"] .source`);
    await expect.poll(() => source('ParamAngleX').getAttribute('data-source')).toBe('tracking');
    await page.evaluate(() =>
      (window as any).mochiStudio.run('set_expression', { expression: 'Blush', on: true }),
    );
    await expect
      .poll(() => source('ParamMouthForm').textContent())
      .toContain('adjusted by the expression Blush');
    await page.close();
  });
});
