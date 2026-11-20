import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BridgeServer } from '../../bridge/src/server.ts';
import { BridgeStore } from '../../bridge/src/store.ts';
import type { TrackedHand } from '../../src/core/hands';
import { syntheticHand } from '../support/hands';
import { PluginClient, expectEnvelope } from '../support/pluginClient';
import {
  openSection,
  startHarness,
  syntheticItemZip,
  syntheticModelZip,
  type Harness,
} from './harness';

/**
 * Items between the model's layers through
 * `ItemSortRequest` (Mochi2D 0.10.0), with a real bridge and a scripted
 * plugin.
 *
 * The synthetic model has a body and, drawn after it, a mouth; the hat item
 * is the same shape in red. Placed over the model, the hat covers its body
 * and its open mouth, unless it is drawn between them.
 */
let H: Harness;
let bridge: BridgeServer;
let page: Page;
let p1: PluginClient;
let pairingCode: () => string;
let bridgePort = 0;
const home = mkdtempSync(join(tmpdir(), 'mochi-layers-'));
const pluginPort = 24_500 + Math.floor(Math.random() * 800);
const errors: string[] = [];

const SKIN = [240, 180, 150];
const SKIN_MOUTH = SKIN.map((c) => Math.round(c * 0.35));
const RED = [220, 60, 60];
const RED_MOUTH = RED.map((c) => Math.round(c * 0.35));
/** In the model's units (y up): the upper body, the main model's open mouth, the hat's thin mouth. */
const BODY = { x: 0, y: 0.15 };
const OPEN_MOUTH = { x: 0, y: -0.26 };
const HAT_MOUTH = { x: 0, y: -0.2 };

/** The color at a point of the model (its units), in a page's screenshot (the window's or an output view's). */
function colorAt(p: Page, at: { x: number; y: number }, output = false): Promise<number[]> {
  return p.evaluate(
    async ({ at, output }) => {
      const w = window as any;
      const rt = output ? w.mochiOutput.runtime : w.mochiStudio.runtime;
      const pt = rt.modelToPage(at.x, at.y);
      const shot = output ? await rt.screenshot() : await w.mochiStudio.screenshot();
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
    },
    { at, output },
  );
}
const near = (a: number[], b: readonly number[]): boolean =>
  a.every((v, i) => Math.abs(v - b[i]!) <= 14);
/** Waits until a point shows a color. */
const shows = (p: Page, at: { x: number; y: number }, color: readonly number[], output = false) =>
  expect
    .poll(async () => near(await colorAt(p, at, output), color), { timeout: 10_000 })
    .toBe(true);

async function connectPlugin(name: string): Promise<PluginClient> {
  const c = await PluginClient.connect(`ws://localhost:${pluginPort}`);
  const id = c.send('AuthenticationTokenRequest', { pluginName: name, pluginDeveloper: 'Tester' });
  await page.locator('#plugin-approval').waitFor({ state: 'visible' });
  await page.locator('#plugin-allow').click();
  const t = await c.next((m) => m.requestID === id, 10_000);
  await c.request('AuthenticationRequest', {
    pluginName: name,
    pluginDeveloper: 'Tester',
    authenticationToken: t.data.authenticationToken,
  });
  return c;
}

/** Feeds these hands (no face), 30 times a second, until changed (as in handTracking.test.ts). */
const feed = (hands: TrackedHand[]) =>
  page.evaluate((hands) => {
    const w = window as any;
    w.hands = hands;
    w.handFeed ??= setInterval(
      () =>
        w.mochiStudio.feedFrame({
          t: performance.now(),
          face: false,
          blendshapes: {},
          hands: w.hands,
        }),
      33,
    );
  }, hands);
const stopFeed = () =>
  page.evaluate(() => {
    const w = window as any;
    clearInterval(w.handFeed);
    w.handFeed = undefined;
  });

const sortOf = (id: string) => page.evaluate((id) => (window as any).mochiStudio.itemSort(id), id);

async function addHat(): Promise<string> {
  const ids = () =>
    page.evaluate(() => (window as any).mochiStudio.items.map((i: any) => i.id) as string[]);
  const before = await ids();
  await page.locator('#item-zip').setInputFiles({
    name: 'Hat.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(syntheticItemZip()),
  });
  // Drawn and listed in the settings (in the same step).
  await page.waitForFunction((n) => {
    const s = (window as any).mochiStudio;
    return s.runtime.items().length === n + 1 && s.items.length === n + 1;
  }, before.length);
  const id = (await ids()).find((i) => !before.includes(i))!;
  expect(id).toBeTruthy();
  // Over the model, as large as it (the hat's canvas has half its pixels): the hat covers the body.
  await page.evaluate(
    (id) => (window as any).mochiStudio.placeItem(id, { x: 0, y: 0, scale: 2, rotation: 0 }),
    id,
  );
  return id;
}

beforeAll(async () => {
  H = await startHarness();
  const store = new BridgeStore(home);
  pairingCode = () => store.pairingCode();
  bridge = new BridgeServer({
    port: 0,
    store,
    log: () => undefined,
    plugins: { port: pluginPort, broadcastAddress: '127.0.0.1', broadcastPort: 9 },
  });
  bridgePort = await bridge.listen();
  page = await H.context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(H.url);
  await page.waitForFunction(() => 'mochiStudio' in window);
  await page.locator('#model-zip').setInputFiles({
    name: 'Test.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(syntheticModelZip()),
  });
  await page.waitForFunction(() => (window as any).mochiStudio.settings !== undefined);
  // Still, with the mouth open: no breath, no idle animation, no blinking in the way.
  await page.evaluate(() => {
    const s = (window as any).mochiStudio;
    s.runtime.setEffect?.('breath', false);
    s.setOverrides({ ParamMouthOpenY: 1, ParamAngleX: 0 });
  });
  await openSection(page, 'Agents');
  await page.locator('#bridge-url').fill(`ws://127.0.0.1:${bridgePort}`);
  await page.locator('#plugins-toggle').check();
  await page.locator('#plugins-pair-code').waitFor({ state: 'visible' });
  await page.locator('#plugins-pair-code').fill(pairingCode());
  await page.locator('#plugins-pair-code ~ button').click();
  await page.waitForFunction(
    (p) => document.querySelector('#plugins-status')?.textContent?.includes(p),
    `ws://localhost:${pluginPort}`,
  );
  await page.keyboard.press('Escape');
  p1 = await connectPlugin('Layer Sorter');
  await page.bringToFront();
}, 60_000);
afterAll(async () => {
  p1?.close();
  await bridge?.close();
  await H?.close();
});

describe('items between the model’s layers', () => {
  let hat = '';

  it('draws an item just in front of an art mesh, in the window and in an output view', async () => {
    hat = await addHat();
    // In front of the whole model: the hat covers the open mouth.
    await shows(page, OPEN_MOUTH, RED);
    const sort = (d: Record<string, unknown>) =>
      p1.request('ItemSortRequest', { itemInstanceID: hat, ...d });
    const r = await sort({
      frontOn: true,
      setFrontOrder: 'UseArtMeshID',
      withinModelOrderFront: 'ArtMeshBody',
    });
    expectEnvelope(r, 'ItemSortResponse');
    expect(r.data).toMatchObject({
      itemInstanceID: hat,
      modelLoaded: true,
      loadedModelHadRequestedFrontLayer: true,
      loadedModelHadRequestedBackLayer: false,
    });
    expect(await sortOf(hat)).toEqual({ layer: { above: 'ArtMeshBody' }, split: null });
    // Over the body, under the mouth.
    await shows(page, BODY, RED);
    await shows(page, OPEN_MOUTH, SKIN_MOUTH);
    // An output view draws it the same way.
    const out = await H.context.newPage();
    await out.goto(new URL('output.html', H.url).href);
    await out.waitForFunction(() => document.body.dataset.items === '1');
    await shows(out, BODY, RED, true);
    await shows(out, OPEN_MOUTH, SKIN_MOUTH, true);
    await out.close();
    await page.bringToFront();
    // The Items sheet says so, and can draw it whole again.
    await openSection(page, 'Items');
    await expect
      .poll(() => page.locator('.item-layer').textContent())
      .toContain('just in front of the model’s “ArtMeshBody”');
    await page.keyboard.press('Escape');
  });

  it('splits a model item into a front and a back part', async () => {
    const sort = (d: Record<string, unknown>) =>
      p1.request('ItemSortRequest', { itemInstanceID: hat, ...d });
    // The hat's mouth and what follows in front of everything, its body behind the model.
    const r = await sort({
      frontOn: true,
      backOn: true,
      setSplitPoint: 'UseArtMeshID',
      splitAt: 'ArtMeshMouth',
      setFrontOrder: 'UseSpecialID',
      withinModelOrderFront: 'FullyInFront',
      setBackOrder: 'UseSpecialID',
      withinModelOrderBack: 'FullyInBack',
    });
    expect(r.data).toMatchObject({
      loadedModelHadRequestedFrontLayer: true,
      loadedModelHadRequestedBackLayer: true,
    });
    expect(await sortOf(hat)).toEqual({
      layer: null,
      split: { mesh: 'ArtMeshMouth', back: 'behind' },
    });
    await shows(page, BODY, SKIN);
    await shows(page, HAT_MOUTH, RED_MOUTH);
    // The back part off: drawn whole again, in front.
    await sort({ frontOn: true, backOn: false });
    await shows(page, BODY, RED);
    // An art mesh this model lacks is kept, for another model; the hat stays on its side.
    const other = await sort({
      frontOn: true,
      setFrontOrder: 'UseArtMeshID',
      withinModelOrderFront: 'ArtMeshHatBrim',
    });
    expect(other.data.loadedModelHadRequestedFrontLayer).toBe(false);
    expect(await sortOf(hat)).toEqual({ layer: { above: 'ArtMeshHatBrim' }, split: null });
    await shows(page, OPEN_MOUTH, RED);
    // Errors.
    expect((await sort({ setSplitPoint: 'UseArtMeshID', splitAt: 'Nope' })).data.errorID).toBe(
      1254,
    );
    expect(
      (await sort({ setBackOrder: 'UseSpecialID', withinModelOrderBack: 'FullyInFront' })).data
        .errorID,
    ).toBe(1253);
  });

  it('never draws the back part in front of the front part', async () => {
    const sort = (d: Record<string, unknown>) =>
      p1.request('ItemSortRequest', { itemInstanceID: hat, ...d });
    // The back part asked to go over the model's mouth, the front part only over its body.
    const r = await sort({
      frontOn: true,
      backOn: true,
      setSplitPoint: 'UseArtMeshID',
      splitAt: 'ArtMeshMouth',
      setFrontOrder: 'UseArtMeshID',
      withinModelOrderFront: 'ArtMeshBody',
      setBackOrder: 'UseArtMeshID',
      withinModelOrderBack: 'ArtMeshMouth',
    });
    expect(r.data).toMatchObject({
      loadedModelHadRequestedFrontLayer: true,
      loadedModelHadRequestedBackLayer: true,
    });
    // The back part (the hat's body) stands just below the front part: over the body,
    // under the model's mouth, which it would cover at its own place.
    await shows(page, BODY, RED);
    await shows(page, OPEN_MOUTH, SKIN_MOUTH);
  });

  it('keeps the places and the order of items across a reload', async () => {
    const sort = (id: string, d: Record<string, unknown>) =>
      p1.request('ItemSortRequest', { itemInstanceID: id, ...d });
    await sort(hat, {
      frontOn: true,
      backOn: true,
      setSplitPoint: 'UseArtMeshID',
      splitAt: 'ArtMeshMouth',
      setFrontOrder: 'UseArtMeshID',
      withinModelOrderFront: 'ArtMeshBody',
      setBackOrder: 'UseSpecialID',
      withinModelOrderBack: 'FullyInBack',
    });
    // A second hat at the same place, drawn under the first (a lower order).
    const second = await addHat();
    await sort(second, {
      frontOn: true,
      setFrontOrder: 'UseArtMeshID',
      withinModelOrderFront: 'ArtMeshBody',
    });
    // The two hats hold slots 1 and 2, in drawing order when the plugin layer first sees both:
    // either may hold 2. The moves run in the request's order, so the first hat leaves its
    // slot before the second takes 2 (moving into a taken slot fails, rightly).
    const move = await p1.request('ItemMoveRequest', {
      itemsToMove: [
        { itemInstanceID: hat, order: 7, timeInSeconds: 0 },
        { itemInstanceID: second, order: 2, timeInSeconds: 0 },
      ],
    });
    expect(move.data.movedItems).toEqual([
      { itemInstanceID: hat, success: true, errorID: -1 },
      { itemInstanceID: second, success: true, errorID: -1 },
    ]);
    const listed = await p1.request('ItemListRequest', { includeItemInstancesInScene: true });
    expect(
      Object.fromEntries(
        listed.data.itemInstancesInScene.map((i: any) => [i.instanceID, i.order] as const),
      ),
    ).toEqual({ [hat]: 7, [second]: 2 });
    const order = () =>
      page.evaluate(() => (window as any).mochiStudio.runtime.itemOrder() as string[]);
    expect(await order()).toEqual([second, hat]);
    const before = { hat: await sortOf(hat), second: await sortOf(second) };
    expect(before.hat).toEqual({
      layer: { above: 'ArtMeshBody' },
      split: { mesh: 'ArtMeshMouth', back: 'behind' },
    });

    await page.evaluate(() => (window as any).mochiStudio.flushSave());
    await page.reload();
    await page.waitForFunction(() => 'mochiStudio' in window);
    await page.locator('#model-zip').setInputFiles({
      name: 'Test.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(syntheticModelZip()),
    });
    await page.waitForFunction(() => (window as any).mochiStudio.runtime.items().length === 2);
    expect({ hat: await sortOf(hat), second: await sortOf(second) }).toEqual(before);
    expect(await order()).toEqual([second, hat]);
    expect(errors).toEqual([]);
  });
});

describe('a pinch, an OK sign, and each gesture’s sensitivity', () => {
  it('recognizes the new gestures, follows the sensitivity sliders, and fires a pinch hotkey', async () => {
    const right = (fingers: Record<string, number>, touch = false) =>
      syntheticHand({ side: 'right', fingers, touch });
    const seen = () => page.evaluate(() => (window as any).mochiStudio.handGestures?.right);
    await openSection(page, 'Tracking');
    await page.locator('#tracking-mode').selectOption('hands');
    await page.locator('#hand-preview-toggle').check();
    await feed([right({ Index: 0.6 }, true)]);
    await expect
      .poll(() => page.locator('#hand-readouts [data-side=right]').textContent())
      .toContain('OK sign');
    await feed([right({ Index: 0.6, Middle: 0, Ring: 0, Pinky: 0 }, true)]);
    await expect
      .poll(() => page.locator('#hand-readouts [data-side=right]').textContent())
      .toContain('Pinch');
    // A loosely open hand: no gesture at the default sensitivity, an open hand at the highest.
    await feed([right({ Thumb: 0.6, Index: 0.6, Middle: 0.6, Ring: 0.6, Pinky: 0.6 })]);
    await expect.poll(seen).toBeUndefined();
    await page.locator('#gesture-sensitivity summary').click();
    const slider = page.locator('#gesture-sensitivity input[data-gesture=open]');
    expect(await slider.inputValue()).toBe('50');
    await slider.evaluate((el) => {
      (el as HTMLInputElement).value = '100';
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect.poll(seen).toBe('open');
    // Kept app-wide; the section stays open as the tab re-renders.
    await expect
      .poll(() =>
        page.evaluate(
          async () => (await (window as any).mochiStudio.store.getApp()).gestureSensitivity,
        ),
      )
      .toEqual({ open: 100 });
    expect(await page.locator('#gesture-sensitivity').getAttribute('open')).not.toBeNull();
    // A pinch on the right hand turns an expression on while it is held.
    await page.evaluate(() =>
      (window as any).mochiStudio.updateSettings({
        hotkeys: [
          {
            id: 'pinch',
            label: 'Blush on a pinch',
            keys: '',
            button: false,
            action: { type: 'expression', expression: 'Blush' },
            release: 'hold',
            gesture: { right: 'pinch', combine: 'and', mirrored: false, hold: 0.2 },
          },
        ],
      }),
    );
    const on = () =>
      page.evaluate(() => (window as any).mochiStudio.activeExpressions.has('Blush'));
    await feed([right({ Index: 0.6, Middle: 0, Ring: 0, Pinky: 0 }, true)]);
    await expect.poll(on, { timeout: 3000 }).toBe(true);
    await feed([right({})]);
    await expect.poll(on, { timeout: 3000 }).toBe(false);
    await stopFeed();
    await page.evaluate(() => (window as any).mochiStudio.updateSettings({ hotkeys: [] }));
    await page.locator('#tracking-mode').selectOption('face');
    await page.keyboard.press('Escape');
    expect(errors).toEqual([]);
  });
});
