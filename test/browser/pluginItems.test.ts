import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BridgeServer } from '../../bridge/src/server.ts';
import { BridgeStore } from '../../bridge/src/store.ts';
import { PluginClient, expectEnvelope, type Message } from '../support/pluginClient';
import { encodePng } from '../support/syntheticModel';
import {
  openSection,
  startHarness,
  syntheticItemZip,
  syntheticModelZip,
  type Harness,
} from './harness';

/**
 * The plugin API's priority 2 end to end: items, custom images
 * and their approval, art-mesh selection, the geometry events and the small
 * extras, with a real bridge, the page and scripted plugins.
 */
let H: Harness;
let bridge: BridgeServer;
let page: Page;
let url: string;
let p1: PluginClient;
const home = mkdtempSync(join(tmpdir(), 'mochi-plugins-items-'));
const pluginPort = 20_100 + Math.floor(Math.random() * 800);
const errors: string[] = [];
const ev = (name: string) => (m: Message) => m.messageType === name;

/** A PNG of w × h, half green and half red. */
function pngBase64(w: number, h: number): string {
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++)
    px.set(i % w < w / 2 ? [40, 180, 90, 255] : [220, 60, 50, 255], i * 4);
  return Buffer.from(encodePng(w, h, px)).toString('base64');
}

async function connectPlugin(name: string): Promise<PluginClient> {
  const c = await PluginClient.connect(url);
  const id = c.send('AuthenticationTokenRequest', { pluginName: name, pluginDeveloper: 'Tester' });
  await page.locator('#plugin-approval').waitFor({ state: 'visible' });
  await page.locator('#plugin-allow').click();
  const t = await c.next((m) => m.requestID === id, 10_000);
  const a = await c.request('AuthenticationRequest', {
    pluginName: name,
    pluginDeveloper: 'Tester',
    authenticationToken: t.data.authenticationToken,
  });
  expect(a.data.authenticated).toBe(true);
  return c;
}

/** Sends a request that waits for the person, and returns its answer later. */
function ask(c: PluginClient, type: string, data: Record<string, unknown>): Promise<Message> {
  const id = c.send(type, data);
  return c.next((m) => m.requestID === id, 20_000);
}

const items = () =>
  page.evaluate(() =>
    (window as any).mochiStudio.items.map((i: any) => ({
      id: i.id,
      file: i.file,
      temporary: !!i.temporary,
      locked: !!i.locked,
    })),
  );

beforeAll(async () => {
  H = await startHarness();
  const store = new BridgeStore(home);
  bridge = new BridgeServer({
    port: 0,
    store,
    log: () => undefined,
    plugins: { port: pluginPort, broadcastAddress: '127.0.0.1', broadcastPort: 9 },
  });
  const port = await bridge.listen();
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
  await openSection(page, 'Agents');
  await page.locator('#bridge-url').fill(`ws://127.0.0.1:${port}`);
  await page.locator('#plugins-toggle').check();
  await page.locator('#plugins-pair-code').waitFor({ state: 'visible' });
  await page.locator('#plugins-pair-code').fill(store.pairingCode());
  await page.locator('#plugins-pair-code ~ button').click();
  await page.waitForFunction(
    (p) => document.querySelector('#plugins-status')?.textContent?.includes(p),
    `ws://localhost:${pluginPort}`,
  );
  await page.keyboard.press('Escape');
  url = `ws://localhost:${pluginPort}`;
  p1 = await connectPlugin('Prop Plugin');
}, 60_000);
afterAll(async () => {
  p1?.close();
  await bridge?.close();
  await H?.close();
});

describe('plugin items, images and geometry', () => {
  it('lists items, loads copies, and checks the load request', async () => {
    const empty = await p1.request('ItemListRequest', {
      includeAvailableSpots: true,
      includeItemInstancesInScene: true,
      includeAvailableItemFiles: true,
    });
    expectEnvelope(empty, 'ItemListResponse');
    expect(empty.data).toMatchObject({
      itemsInSceneCount: 0,
      totalItemsAllowedCount: 32,
      canLoadItemsRightNow: true,
      itemInstancesInScene: [],
      availableItemFiles: [],
    });
    expect(empty.data.availableSpots).toHaveLength(60);
    // An item added by hand (a model item from a zip).
    await page.locator('#item-zip').setInputFiles({
      name: 'Hat.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(syntheticItemZip()),
    });
    await expect.poll(async () => (await items()).length).toBe(1);
    const load = (d: Record<string, unknown>) => p1.request('ItemLoadRequest', d);
    expect((await load({})).data.errorID).toBe(750);
    expect((await load({ fileName: 'Nothing' })).data.errorID).toBe(751);
    expect((await load({ fileName: 'Hat', size: 5 })).data.errorID).toBe(757);
    expect((await load({ fileName: 'Hat', order: 0 })).data.errorID).toBe(755);
    const list = await p1.request('ItemListRequest', {
      includeItemInstancesInScene: true,
      includeAvailableItemFiles: true,
    });
    expect(list.data.availableItemFiles).toEqual([
      { fileName: 'Hat', type: 'Live2D', loadedCount: 1 },
    ]);
    const handOrder = list.data.itemInstancesInScene[0].order;
    expect(handOrder).toBe(1);
    expect(
      (await load({ fileName: 'Hat', order: handOrder, failIfOrderTaken: true })).data.errorID,
    ).toBe(756);
    const copy = await load({
      fileName: 'Hat',
      positionX: 0.5,
      positionY: 0.2,
      size: 0.32,
      order: 1,
      locked: true,
    });
    expectEnvelope(copy, 'ItemLoadResponse');
    expect(copy.data.fileName).toBe('Hat');
    const all = await p1.request('ItemListRequest', { includeItemInstancesInScene: true });
    const inst = all.data.itemInstancesInScene.find(
      (i: any) => i.instanceID === copy.data.instanceID,
    );
    expect(Object.keys(inst).sort()).toEqual(
      [
        'censored',
        'currentFrame',
        'fileName',
        'flipped',
        'frameCount',
        'framerate',
        'fromWorkshop',
        'groupName',
        'instanceID',
        'locked',
        'order',
        'pinnedArtMeshID',
        'pinnedModelID',
        'pinnedToModel',
        'sceneName',
        'smoothing',
        'type',
      ].sort(),
    );
    // Slot 1 was taken: the next higher one.
    expect(inst).toMatchObject({ order: 2, type: 'Live2D', locked: true, pinnedToModel: false });
    // Loaded by a plugin: for this session only, until the person keeps it.
    expect((await items()).find((i: any) => i.id === copy.data.instanceID)).toMatchObject({
      temporary: true,
      file: 'Hat',
    });
    // Its position is where the plugin asked (window coordinates).
    const where = await page.evaluate(
      (id) => (window as any).mochiPlugins.items.itemPosition(id),
      copy.data.instanceID,
    );
    expect(where.x).toBeCloseTo(0.5, 2);
    expect(where.y).toBeCloseTo(0.2, 2);
    // Model items have no frames: 851. Their brightness is a gray tint.
    expect(
      (
        await p1.request('ItemAnimationControlRequest', {
          itemInstanceID: copy.data.instanceID,
          frame: 2,
        })
      ).data.errorID,
    ).toBe(851);
    const dim = await p1.request('ItemAnimationControlRequest', {
      itemInstanceID: copy.data.instanceID,
      brightness: 0.5,
    });
    expectEnvelope(dim, 'ItemAnimationControlResponse');
    const itemTints = () =>
      page.evaluate((id) => {
        const item = (window as any).mochiStudio.runtime.itemMap.get(id);
        return [...item.tints.values()];
      }, copy.data.instanceID);
    // Every art mesh of the item, the same gray.
    const dimmed = await itemTints();
    expect(dimmed.length).toBeGreaterThan(0);
    expect(new Set(dimmed.map((t: number[]) => t.join(',')))).toEqual(new Set(['0.5,0.5,0.5,1']));
    await p1.request('ItemAnimationControlRequest', {
      itemInstanceID: copy.data.instanceID,
      brightness: 1,
    });
    expect(await itemTints()).toEqual([]);
    expect(
      (await p1.request('ItemAnimationControlRequest', { itemInstanceID: 'nope' })).data.errorID,
    ).toBe(850);
  });

  it('flips model items for plugins with Mochi2D’s mirror', async () => {
    const f = await p1.request('ItemLoadRequest', { fileName: 'Hat', flipped: true, order: 10 });
    expectEnvelope(f, 'ItemLoadResponse');
    const id = f.data.instanceID;
    const listed = async () =>
      (
        await p1.request('ItemListRequest', {
          includeItemInstancesInScene: true,
          onlyItemsWithInstanceID: id,
        })
      ).data.itemInstancesInScene[0];
    const mirrored = () =>
      page.evaluate((id) => (window as any).mochiStudio.isItemMirrored(id), id);
    expect((await listed()).flipped).toBe(true);
    expect(await mirrored()).toBe(true);
    const flip = (on: boolean) =>
      p1.request('ItemMoveRequest', {
        itemsToMove: [{ itemInstanceID: id, setFlip: true, flip: on }],
      });
    expect((await flip(false)).data.movedItems).toEqual([
      { itemInstanceID: id, success: true, errorID: -1 },
    ]);
    expect((await listed()).flipped).toBe(false);
    // Pinned, it flips and stays pinned.
    await p1.request('ItemPinRequest', {
      itemInstanceID: id,
      pin: true,
      vertexPinType: 'Center',
      pinInfo: { artMeshID: 'ArtMeshBody' },
    });
    await flip(true);
    expect(await listed()).toMatchObject({ flipped: true, pinnedToModel: true });
    await p1.request('ItemUnloadRequest', { instanceIDs: [id] });
  });

  it('moves, pins and unloads items, with per-item results', async () => {
    const list = await p1.request('ItemListRequest', { includeItemInstancesInScene: true });
    const [hand, mine] = list.data.itemInstancesInScene;
    const mv = await p1.request('ItemMoveRequest', {
      itemsToMove: [
        {
          itemInstanceID: mine.instanceID,
          timeInSeconds: 0,
          positionX: -0.4,
          positionY: -1000,
          size: -1000,
        },
        { itemInstanceID: 'missing', positionX: 0 },
        { itemInstanceID: hand.instanceID, timeInSeconds: 1, fadeMode: 'wobble', positionX: 0 },
        { itemInstanceID: hand.instanceID, order: mine.order },
      ],
    });
    expectEnvelope(mv, 'ItemMoveResponse');
    expect(mv.data.movedItems).toEqual([
      { itemInstanceID: mine.instanceID, success: true, errorID: -1 },
      { itemInstanceID: 'missing', success: false, errorID: 900 },
      { itemInstanceID: hand.instanceID, success: false, errorID: 902 },
    ]);
    const pos = await page.evaluate(
      (id) => (window as any).mochiPlugins.items.itemPosition(id),
      mine.instanceID,
    );
    expect(pos.x).toBeCloseTo(-0.4, 2);
    expect(pos.y).toBeCloseTo(0.2, 2);
    // A move over time, eased.
    await p1.request('ItemMoveRequest', {
      itemsToMove: [
        { itemInstanceID: mine.instanceID, timeInSeconds: 0.4, fadeMode: 'easeBoth', positionX: 0 },
      ],
    });
    await expect
      .poll(
        async () =>
          (
            await page.evaluate(
              (id) => (window as any).mochiPlugins.items.itemPosition(id),
              mine.instanceID,
            )
          ).x,
      )
      .toBeCloseTo(0, 2);

    // Pins.
    const pin = (d: Record<string, unknown>) =>
      p1.request('ItemPinRequest', { itemInstanceID: mine.instanceID, ...d });
    expect((await pin({ pin: true, angleRelativeTo: 'Sideways' })).data.errorID).toBe(1051);
    expect(
      (await pin({ pin: true, vertexPinType: 'Center', pinInfo: { modelID: 'f'.repeat(32) } })).data
        .errorID,
    ).toBe(1052);
    expect(
      (await pin({ pin: true, vertexPinType: 'Center', pinInfo: { artMeshID: 'NoMesh' } })).data
        .errorID,
    ).toBe(1053);
    expect(
      (
        await pin({
          pin: true,
          pinInfo: {
            artMeshID: 'ArtMeshBody',
            vertexID1: 0,
            vertexID2: 1,
            vertexID3: 2,
            vertexWeight1: 0.9,
            vertexWeight2: 0.9,
            vertexWeight3: 0,
          },
        })
      ).data.errorID,
    ).toBe(1054);
    expect(
      (await p1.request('ItemPinRequest', { itemInstanceID: 'gone', pin: true })).data.errorID,
    ).toBe(1050);
    const ok = await pin({
      pin: true,
      vertexPinType: 'Center',
      pinInfo: { artMeshID: 'ArtMeshBody', size: 0.2 },
    });
    expectEnvelope(ok, 'ItemPinResponse');
    expect(ok.data).toEqual({
      isPinned: true,
      itemInstanceID: mine.instanceID,
      itemFileName: 'Hat',
    });
    const pinned = (
      await p1.request('ItemListRequest', {
        includeItemInstancesInScene: true,
        onlyItemsWithInstanceID: mine.instanceID,
      })
    ).data.itemInstancesInScene[0];
    expect(pinned).toMatchObject({ pinnedToModel: true, pinnedArtMeshID: 'ArtMeshBody' });
    expect(pinned.pinnedModelID).toMatch(/^[0-9a-f]{32}$/);
    expect((await pin({ pin: false })).data.isPinned).toBe(false);

    // Unloading: only this plugin's items unless others are allowed.
    const own = await p1.request('ItemUnloadRequest', {
      fileNames: ['Hat'],
      allowUnloadingItemsLoadedByUserOrOtherPlugins: false,
    });
    expectEnvelope(own, 'ItemUnloadResponse');
    expect(own.data.unloadedItems).toEqual([{ instanceID: mine.instanceID, fileName: 'Hat' }]);
    expect((await items()).map((i: any) => i.id)).toEqual([hand.instanceID]);
    // Items that go when the plugin disconnects.
    const p2 = await connectPlugin('Short Plugin');
    const gone = await p2.request('ItemLoadRequest', {
      fileName: 'Hat',
      unloadWhenPluginDisconnects: true,
    });
    const stays = await p2.request('ItemLoadRequest', { fileName: 'Hat' });
    expect((await items()).length).toBe(3);
    p2.close();
    await expect
      .poll(async () => (await items()).map((i: any) => i.id))
      .toEqual([hand.instanceID, stays.data.instanceID]);
    expect(gone.data.instanceID).not.toBe(stays.data.instanceID);
    expect(
      (await p1.request('ItemUnloadRequest', { unloadAllInScene: true })).data.unloadedItems,
    ).toHaveLength(2);
    expect(await items()).toEqual([]);
  });

  it('loads a plugin’s own image only with the permission and the person’s yes', async () => {
    const image = pngBase64(96, 96);
    const load = (d: Record<string, unknown>) =>
      ask(p1, 'ItemLoadRequest', { fileName: 'my-sticker.png', customDataBase64: image, ...d });
    // Without the permission: error 9.
    expect((await load({})).data.errorID).toBe(9);
    // The permission is asked for the way tokens are: Deny, then Allow.
    let perm = ask(p1, 'PermissionRequest', { requestedPermission: 'LoadCustomImagesAsItems' });
    await page
      .locator('#plugin-approval[data-permission=LoadCustomImagesAsItems]')
      .waitFor({ state: 'visible' });
    expect(await page.locator('#plugin-approval').textContent()).toContain('Prop Plugin');
    await page.locator('#plugin-deny').click();
    expect((await perm).data.grantSuccess).toBe(false);
    perm = ask(p1, 'PermissionRequest', { requestedPermission: 'LoadCustomImagesAsItems' });
    await page
      .locator('#plugin-approval[data-permission=LoadCustomImagesAsItems]')
      .waitFor({ state: 'visible' });
    await page.locator('#plugin-allow').click();
    expect((await perm).data.grantSuccess).toBe(true);
    await expect.poll(() => page.locator('#plugins-list .plugin-permission').count()).toBe(1);

    // Bad data: 757 (name) and 758 (not an image, too small).
    expect((await load({ fileName: 'x.png' })).data.errorID).toBe(757);
    expect(
      (await load({ customDataBase64: Buffer.from('<svg/>').toString('base64') })).data.errorID,
    ).toBe(758);
    expect((await load({ customDataBase64: pngBase64(32, 32) })).data.errorID).toBe(758);

    // The person sees the picture: Don't show, then Show it.
    let r = load({ customDataAskUserFirst: true });
    await page.locator('#plugin-image').waitFor({ state: 'visible' });
    expect(await page.locator('#plugin-image').textContent()).toContain('Prop Plugin');
    expect(await page.locator('#plugin-image img').getAttribute('src')).toMatch(/^blob:/);
    await page.locator('#plugin-image-deny').click();
    expect((await r).data.errorID).toBe(760);
    r = load({ customDataAskUserFirst: true, positionX: -0.5 });
    await page.locator('#plugin-image').waitFor({ state: 'visible' });
    await page.locator('#plugin-image-allow').click();
    const shown = await r;
    expectEnvelope(shown, 'ItemLoadResponse');
    expect(shown.data.fileName).toMatch(/^plugin-[0-9a-f]{16}\.png$/);
    // Accepted once: not asked again (unless the plugin says so).
    const again = await load({ customDataAskUserFirst: true });
    expectEnvelope(again, 'ItemLoadResponse');
    expect(await page.locator('#plugin-image').isVisible()).toBe(false);
    // Its made-up name loads it again, without the data.
    const byName = await p1.request('ItemLoadRequest', { fileName: shown.data.fileName });
    expectEnvelope(byName, 'ItemLoadResponse');
    // A timer that runs out counts as no.
    const timed = load({
      customDataBase64: pngBase64(80, 80),
      customDataAskUserFirst: true,
      customDataAskTimer: 0.5,
    });
    expect((await timed).data.errorID).toBe(760);
    await expect.poll(() => page.locator('#plugin-image').isVisible()).toBe(false);

    // Image items: still, but opacity and brightness work.
    const id = shown.data.instanceID;
    expect(
      (await p1.request('ItemAnimationControlRequest', { itemInstanceID: id, frame: 3 })).data
        .errorID,
    ).toBe(854);
    // The picture as it is stored (brightness redraws it, a moment after the answer).
    const picture = (id: string) =>
      page.evaluate(async (id) => {
        const files = (await (window as any).mochiStudio.itemFilesOf(id)) as [string, Uint8Array][];
        const tex = files.find(([p]) => p.endsWith('.png'))![1];
        let h = 0;
        for (const b of tex) h = (h * 31 + b) | 0;
        return h;
      }, id);
    const before = await picture(id);
    const anim = await p1.request('ItemAnimationControlRequest', {
      itemInstanceID: id,
      opacity: 0.5,
      brightness: 0.5,
    });
    expectEnvelope(anim, 'ItemAnimationControlResponse');
    expect(anim.data).toEqual({ frame: 0, animationPlaying: false });
    expect(
      await page.evaluate((id) => (window as any).mochiStudio.runtime.itemOpacity(id), id),
    ).toBeCloseTo(0.5);
    // Once redrawn darker, the picture keeps the opacity the same request set.
    await expect.poll(() => picture(id)).not.toBe(before);
    expect(
      await page.evaluate((id) => (window as any).mochiStudio.runtime.itemOpacity(id), id),
    ).toBeCloseTo(0.5);
    const type = (
      await p1.request('ItemListRequest', {
        includeItemInstancesInScene: true,
        onlyItemsWithInstanceID: id,
      })
    ).data.itemInstancesInScene[0];
    expect(type).toMatchObject({ type: 'PNG', frameCount: 1 });
    // Session only, until kept in the Items sheet.
    await page.locator('#menu-button').click();
    await page.locator('#menu-items').click();
    const row = page.locator(`[data-item="${id}"]`);
    expect(await row.locator('.item-temporary').isVisible()).toBe(true);
    await row.locator('.item-keep').click();
    await expect
      .poll(async () => (await items()).find((i: any) => i.id === id)?.temporary)
      .toBe(false);
    await page.keyboard.press('Escape');
    await p1.request('ItemUnloadRequest', { unloadAllInScene: true });
  });

  it('lets the person choose art meshes, or cancel', async () => {
    expect(
      (await p1.request('ArtMeshSelectionRequest', { activeArtMeshes: ['NoMesh'] })).data.errorID,
    ).toBe(1002);
    let r = ask(p1, 'ArtMeshSelectionRequest', {
      requestedArtMeshCount: 1,
      textOverride: 'Pick the part to light up.',
    });
    const sheet = page.locator('#plugin-selection');
    await sheet.waitFor({ state: 'visible' });
    expect(await sheet.textContent()).toContain('Pick the part to light up.');
    expect(await sheet.textContent()).toContain('Prop Plugin');
    expect(await page.locator('#plugin-selection-ok').isDisabled()).toBe(true);
    // A second request while the person chooses: 1001.
    expect((await p1.request('ArtMeshSelectionRequest', {})).data.errorID).toBe(1001);
    // Clicking the model lists only the art meshes under the pointer.
    const box = (await page.locator('#stage').boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect.poll(() => sheet.locator('input[type=checkbox]').count()).toBeLessThan(2);
    await sheet.getByRole('button', { name: 'Show all' }).click();
    await sheet.locator('input[data-mesh=ArtMeshMouth]').check();
    await page.locator('#plugin-selection-ok').click();
    const okAnswer = await r;
    expectEnvelope(okAnswer, 'ArtMeshSelectionResponse');
    expect(okAnswer.data).toEqual({
      success: true,
      activeArtMeshes: ['ArtMeshMouth'],
      inactiveArtMeshes: ['ArtMeshBody'],
    });
    expect(await sheet.isVisible()).toBe(false);
    // Cancel: no success, and the preselection comes back unchanged.
    r = ask(p1, 'ArtMeshSelectionRequest', { activeArtMeshes: ['ArtMeshBody'] });
    await sheet.waitFor({ state: 'visible' });
    expect(await sheet.locator('input[data-mesh=ArtMeshBody]').isChecked()).toBe(true);
    await page.locator('#plugin-selection-cancel').click();
    expect((await r).data).toEqual({
      success: false,
      activeArtMeshes: ['ArtMeshBody'],
      inactiveArtMeshes: ['ArtMeshMouth'],
    });
  });

  it('answers the small extras honestly', async () => {
    const overlay = await p1.request('SceneColorOverlayInfoRequest');
    expectEnvelope(overlay, 'SceneColorOverlayInfoResponse');
    expect(overlay.data).toMatchObject({ active: false, colorOverlayR: 255, colorAvgB: 255 });
    expect(overlay.data.leftCapturePart).toEqual({
      active: false,
      colorR: 255,
      colorG: 255,
      colorB: 255,
    });
    const folders = await p1.request('VTSFolderInfoRequest');
    expectEnvelope(folders, 'VTSFolderInfoResponse');
    expect(folders.data.models).toBe('Models');
    const phys = await p1.request('GetCurrentModelPhysicsRequest');
    expectEnvelope(phys, 'GetCurrentModelPhysicsResponse');
    expect(phys.data).toMatchObject({
      modelLoaded: true,
      modelName: 'Test',
      physicsFPSSetting: -1,
      baseStrength: 50,
      baseWind: 0,
      apiPhysicsOverrideActive: false,
      physicsGroups: [],
    });
    const set = (d: Record<string, unknown>) => p1.request('SetCurrentModelPhysicsRequest', d);
    // The synthetic model has no physics file.
    expect((await set({ strengthOverrides: [{ id: 'G', value: 1 }] })).data.errorID).toBe(
      phys.data.modelHasPhysics ? 704 : 701,
    );
  });

  it('sends ModelMovedEvent and ModelOutlineEvent, and draws the outline when asked', async () => {
    await p1.request('EventSubscriptionRequest', { eventName: 'ModelMovedEvent', subscribe: true });
    // Right after subscribing: the current position.
    const first = await p1.next(ev('ModelMovedEvent'));
    expect(first.data.modelName).toBe('Test');
    await p1.request('MoveModelRequest', {
      timeInSeconds: 0,
      valuesAreRelativeToModel: false,
      positionX: 0.3,
    });
    const moved = await p1.next(
      (m) =>
        m.messageType === 'ModelMovedEvent' &&
        Math.abs(m.data.modelPosition.positionX - 0.3) < 0.01,
    );
    expect(Object.keys(moved.data.modelPosition).sort()).toEqual([
      'positionX',
      'positionY',
      'rotation',
      'size',
    ]);
    await p1.request('EventSubscriptionRequest', {
      eventName: 'ModelOutlineEvent',
      subscribe: true,
      config: { draw: true },
    });
    const outline = await p1.next(ev('ModelOutlineEvent'));
    expect(outline.data.convexHull.length).toBeGreaterThanOrEqual(3);
    expect(Object.keys(outline.data.convexHullCenter)).toEqual(['x', 'y']);
    expect(outline.data.windowSize.x).toBeGreaterThan(100);
    await expect.poll(() => page.locator('.model-outline').isVisible()).toBe(true);
    await p1.request('EventSubscriptionRequest', {
      eventName: 'ModelOutlineEvent',
      subscribe: false,
    });
    await expect.poll(() => page.locator('.model-outline').isVisible()).toBe(false);
    await p1.request('EventSubscriptionRequest', { subscribe: false });
  });

  it('gives plugins the model’s display name, and keeps the guide clear of the menu', async () => {
    await openSection(page, 'Model');
    await page.locator('#model-display-name').fill('Mochi Test');
    await page.locator('#model-display-name').dispatchEvent('change');
    await expect
      .poll(async () => (await p1.request('CurrentModelRequest')).data.modelName)
      .toBe('Mochi Test');
    await page.keyboard.press('Escape');
    await page.locator('#menu-button').click();
    expect(await page.locator('#hud-guide').evaluate((e) => getComputedStyle(e).visibility)).toBe(
      'hidden',
    );
    await page.locator('#menu-model').click();
    expect(await page.locator('#model-bar').textContent()).toContain('Mochi Test');
    await page.keyboard.press('Escape');
    expect(await page.locator('#hud-guide').evaluate((e) => getComputedStyle(e).visibility)).toBe(
      'visible',
    );
    expect(errors).toEqual([]);
  });
});
