import type { Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, syntheticItemZip, syntheticModelZip, type Harness } from './harness';

/**
 * The items reach output views however and whenever the views open, while
 * their files go over the channel only when a view is there to take them,
 * and once.
 */
let H: Harness;
let control: Page;

/** Every 'items' message on the views' channel, as item ids and how many carried files. */
async function listen(p: Page): Promise<void> {
  await p.evaluate(() => {
    const seen: Array<{ ids: string[]; withFiles: string[] }> = [];
    (window as any).itemMessages = seen;
    new BroadcastChannel('mochi-studio-output').addEventListener('message', (e) => {
      const m = e.data as {
        type: string;
        key?: string;
        files?: unknown[];
        items?: Array<{ id: string; files: unknown[] }>;
      };
      if (m.type === 'model' || m.type === 'modelAvailable')
        ((window as any).modelMessages ??= []).push({
          type: m.type,
          key: m.key,
          files: m.files?.length ?? 0,
        });
      if (m.type === 'items')
        seen.push({
          ids: m.items!.map((i) => i.id),
          withFiles: m.items!.filter((i) => i.files.length).map((i) => i.id),
        });
    });
  });
}
const messages = (p: Page) =>
  p.evaluate(() => (window as any).itemMessages as Array<{ ids: string[]; withFiles: string[] }>);
const addItem = async (n: number) => {
  await control.locator('#item-zip').setInputFiles({
    name: `Hat${n}.zip`,
    mimeType: 'application/zip',
    buffer: Buffer.from(syntheticItemZip()),
  });
  await control.waitForFunction((n) => (window as any).mochiStudio.items.length === n, n);
};
const openView = async () => {
  const v = await H.context.newPage();
  await v.goto(new URL('output.html', H.url).href);
  return v;
};
const viewItems = (v: Page, n: number) =>
  v.waitForFunction((n) => document.body.dataset.items === String(n), n, { timeout: 30_000 });

beforeAll(async () => {
  H = await startHarness();
  control = await H.context.newPage();
  await control.goto(H.url);
  await control.waitForFunction(() => 'mochiStudio' in window);
  await control.locator('#model-zip').setInputFiles({
    name: 'Test.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(syntheticModelZip()),
  });
  await control.waitForFunction(() => (window as any).mochiStudio.settings !== undefined);
}, 60_000);
afterAll(async () => {
  await H?.close();
});

describe('items in output views', () => {
  it('sends no items over the channel while no view is open; a view that opens gets them all', async () => {
    // Something on the channel that isn't a view (it never says hello).
    const spy = await H.context.newPage();
    await spy.goto(new URL('manifest.json', H.url).href);
    await listen(spy);
    await addItem(1);
    await addItem(2);
    expect(await messages(spy)).toEqual([]);
    const v = await openView();
    await viewItems(v, 2);
    const ms = await messages(spy);
    expect(ms.at(-1)!.withFiles).toHaveLength(2);
    await spy.close();
    await v.close();
  });

  it('with a view open, sends each item’s files once', async () => {
    const v = await openView();
    await viewItems(v, 2);
    await listen(v);
    await addItem(3);
    await viewItems(v, 3);
    await addItem(4);
    await viewItems(v, 4);
    const ms = await messages(v);
    // Each message lists every item, but carries only the new one's files.
    expect(ms.map((m) => m.ids.length)).toEqual([3, 4]);
    expect(ms.map((m) => m.withFiles.length)).toEqual([1, 1]);
    await v.close();
  });

  it('gives a view open before the control window reloaded the items added after', async () => {
    const v = await openView();
    await viewItems(v, 4);
    await control.reload();
    await control.waitForFunction(() => 'mochiStudio' in window);
    // The view was never greeted by this window: it says it is there when the model comes.
    await control.locator('#model-zip').setInputFiles({
      name: 'Test.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(syntheticModelZip()),
    });
    await control.waitForFunction(() => (window as any).mochiStudio.items.length === 4, undefined, {
      timeout: 30_000,
    });
    await control.waitForFunction(() => (window as any).mochiStudio.views.size === 1, undefined, {
      timeout: 15_000,
    });
    await addItem(5);
    await viewItems(v, 5);
    await v.close();
  });

  it('sends a model to no one when no view is open, and a view open before a reload gets the new one', async () => {
    const spy = await H.context.newPage();
    await spy.goto(new URL('manifest.json', H.url).href);
    await listen(spy);
    // No view: loading a model sends only that it is there.
    await control.reload();
    await control.waitForFunction(() => 'mochiStudio' in window);
    await control.locator('#model-zip').setInputFiles({
      name: 'Test.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(syntheticModelZip()),
    });
    await control.waitForFunction(() => (window as any).mochiStudio.settings !== undefined);
    await expect
      .poll(() => spy.evaluate(() => (window as any).modelMessages ?? []))
      .toEqual([{ type: 'modelAvailable', key: expect.any(String), files: 0 }]);
    // A view opens: it gets the model.
    const v = await openView();
    const key = await control.evaluate(() => (window as any).mochiStudio.model.key as string);
    await v.waitForFunction((k) => document.body.dataset.model === k, key, { timeout: 30_000 });
    // The control window reloads and loads another model: the view, never greeted by it,
    // answers that a model is there, and gets it.
    await control.reload();
    await control.waitForFunction(() => 'mochiStudio' in window);
    await control.locator('#model-zip').setInputFiles({
      name: 'Hat.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(syntheticItemZip()),
    });
    await control.waitForFunction(() => (window as any).mochiStudio.settings !== undefined);
    const hat = await control.evaluate(() => (window as any).mochiStudio.model.key as string);
    expect(hat).not.toBe(key);
    await v.waitForFunction((k) => document.body.dataset.model === k, hat, { timeout: 30_000 });
    const ms = await spy.evaluate(() => (window as any).modelMessages);
    expect(ms.filter((m: { type: string }) => m.type === 'model').length).toBeGreaterThan(0);
    await v.close();
    await spy.close();
  });
});
