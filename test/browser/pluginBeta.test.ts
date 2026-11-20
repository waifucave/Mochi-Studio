import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BridgeServer } from '../../bridge/src/server.ts';
import { BridgeStore } from '../../bridge/src/store.ts';
import { encodeGif } from '../support/gif';
import { PluginClient, expectEnvelope, type Message } from '../support/pluginClient';
import { encodePng } from '../support/syntheticModel';
import { openSection, startHarness, syntheticModelZip, type Harness } from './harness';

/**
 * The plugin API's later requests, end to end: animated items' frame
 * controls, priority 3 (post-processing, NDI, the editor event, item
 * sorting) and the beta requests and events (art meshes at a position,
 * expression toggles, tracked points, mesh outlines).
 */
let H: Harness;
let bridge: BridgeServer;
let page: Page;
let url: string;
let p1: PluginClient;
const home = mkdtempSync(join(tmpdir(), 'mochi-plugins-beta-'));
const pluginPort = 21_100 + Math.floor(Math.random() * 800);
const errors: string[] = [];
const ev = (name: string) => (m: Message) => m.messageType === name;

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
  p1 = await connectPlugin('Beta Plugin');
}, 60_000);
afterAll(async () => {
  p1?.close();
  await bridge?.close();
  await H?.close();
});

describe('the plugin API: frame controls, priority 3 and the beta requests', () => {
  it('controls an animated GIF’s frames: rate, frame, auto-stop and play state', async () => {
    const perm = p1.send('PermissionRequest', { requestedPermission: 'LoadCustomImagesAsItems' });
    await page.locator('#plugin-approval[data-permission=LoadCustomImagesAsItems]').waitFor();
    await page.locator('#plugin-allow').click();
    expect((await p1.next((m) => m.requestID === perm, 10_000)).data.grantSuccess).toBe(true);
    const palette: Array<[number, number, number]> = [
      [230, 40, 40],
      [40, 200, 70],
      [40, 90, 230],
      [240, 200, 30],
      [160, 60, 200],
      [20, 20, 20],
    ];
    const gif = encodeGif(
      80,
      80,
      palette,
      palette.map((_, i) => ({ indices: new Uint8Array(80 * 80).fill(i), delay: 5 })),
    );
    const id = p1.send('ItemLoadRequest', {
      fileName: 'six-frames.gif',
      customDataBase64: Buffer.from(gif).toString('base64'),
      customDataAskUserFirst: false,
    });
    const loaded = await p1.next((m) => m.requestID === id, 20_000);
    expectEnvelope(loaded, 'ItemLoadResponse');
    const inst = loaded.data.instanceID as string;
    const listed = async () =>
      (
        await p1.request('ItemListRequest', {
          includeItemInstancesInScene: true,
          includeAvailableItemFiles: true,
          onlyItemsWithInstanceID: inst,
        })
      ).data;
    const l = await listed();
    expect(l.itemInstancesInScene[0]).toMatchObject({ type: 'GIF', frameCount: 6, framerate: 20 });
    expect(l.availableItemFiles).toContainEqual({
      fileName: loaded.data.fileName,
      type: 'GIF',
      loadedCount: 1,
    });
    const control = (d: Record<string, unknown>) =>
      p1.request('ItemAnimationControlRequest', { itemInstanceID: inst, ...d });
    // A jump, paused: the frame is shown and reported.
    const jump = await control({
      setAnimationPlayState: true,
      animationPlayState: false,
      frame: 3,
    });
    expectEnvelope(jump, 'ItemAnimationControlResponse');
    expect(jump.data).toEqual({ frame: 3, animationPlaying: false });
    expect(
      await page.evaluate((id) => (window as any).mochiStudio.runtime.itemFrame(id), inst),
    ).toBe(3);
    expect((await listed()).itemInstancesInScene[0]).toMatchObject({ currentFrame: 3 });
    // Errors: a frame it does not have (852), too many auto-stop frames (853).
    expect((await control({ frame: 6 })).data.errorID).toBe(852);
    expect((await control({ setAutoStopFrames: true, autoStopFrames: [9] })).data.errorID).toBe(
      852,
    );
    expect(
      (
        await control({
          setAutoStopFrames: true,
          autoStopFrames: Array.from({ length: 1025 }, () => 0),
        })
      ).data.errorID,
    ).toBe(853);
    // Playing from frame 3 with an auto-stop at frame 5: it stops there by itself.
    const play = await control({
      framerate: 30,
      setAutoStopFrames: true,
      autoStopFrames: [5],
      setAnimationPlayState: true,
      animationPlayState: true,
    });
    expect(play.data.animationPlaying).toBe(true);
    await expect
      .poll(async () => (await control({})).data)
      .toEqual({ frame: 5, animationPlaying: false });
    expect((await listed()).itemInstancesInScene[0]).toMatchObject({
      framerate: 30,
      currentFrame: 5,
    });
    // A still picture's frames: 854, as before.
    const px = new Uint8Array(64 * 64 * 4).fill(200);
    const still = await p1.request(
      'ItemLoadRequest',
      {
        fileName: 'still-one.png',
        customDataBase64: Buffer.from(encodePng(64, 64, px)).toString('base64'),
        customDataAskUserFirst: false,
      },
      20_000,
    );
    expect(
      (
        await p1.request('ItemAnimationControlRequest', {
          itemInstanceID: still.data.instanceID,
          frame: 0,
        })
      ).data.errorID,
    ).toBe(854);
    await p1.request('ItemUnloadRequest', { unloadAllInScene: true });
  });

  it('sorts items: in front of or behind the whole model, or between its layers', async () => {
    const px = new Uint8Array(64 * 64 * 4).fill(180);
    const item = await p1.request(
      'ItemLoadRequest',
      {
        fileName: 'sorted-one.png',
        customDataBase64: Buffer.from(encodePng(64, 64, px)).toString('base64'),
        customDataAskUserFirst: false,
      },
      20_000,
    );
    const inst = item.data.instanceID as string;
    const sort = (d: Record<string, unknown>) =>
      p1.request('ItemSortRequest', { itemInstanceID: inst, frontOn: true, ...d });
    expect((await p1.request('ItemSortRequest', { itemInstanceID: 'nope' })).data.errorID).toBe(
      1250,
    );
    expect((await sort({ setFrontOrder: 'Sideways' })).data.errorID).toBe(1251);
    expect(
      (await sort({ setFrontOrder: 'UseSpecialID', withinModelOrderFront: 'Middle' })).data.errorID,
    ).toBe(1252);
    const front = () =>
      page.evaluate((id) => (window as any).mochiStudio.itemPlacement(id).front, inst);
    expect(await front()).toBe(true);
    const back = await sort({
      setFrontOrder: 'UseSpecialID',
      withinModelOrderFront: 'FullyInBack',
    });
    expectEnvelope(back, 'ItemSortResponse');
    expect(back.data).toMatchObject({
      itemInstanceID: inst,
      modelLoaded: true,
      modelName: 'Test',
      loadedModelHadRequestedFrontLayer: true,
      loadedModelHadRequestedBackLayer: false,
    });
    expect(await front()).toBe(false);
    // Between the model's layers (Mochi2D 0.10.0): just in front of the body.
    const between = await sort({
      setFrontOrder: 'UseArtMeshID',
      withinModelOrderFront: 'ArtMeshBody',
    });
    expect(between.data.loadedModelHadRequestedFrontLayer).toBe(true);
    expect(
      await page.evaluate((id) => (window as any).mochiStudio.runtime.itemSort(id), inst),
    ).toEqual({ layer: { above: 'ArtMeshBody' }, split: null });
    await p1.request('ItemUnloadRequest', { unloadAllInScene: true });
  });

  it('answers post-processing and NDI honestly: not supported, off', async () => {
    const list = await p1.request('PostProcessingListRequest', {
      fillPostProcessingPresetsArray: true,
      fillPostProcessingEffectsArray: true,
    });
    expectEnvelope(list, 'PostProcessingListResponse');
    expect(list.data).toMatchObject({
      postProcessingSupported: false,
      postProcessingActive: false,
      postProcessingEffects: [],
      postProcessingPresets: [],
    });
    expect(
      (
        await p1.request('PostProcessingListRequest', {
          effectIDFilter: Array.from({ length: 513 }, () => 'x'),
        })
      ).data.errorID,
    ).toBe(1150);
    const update = (d: Record<string, unknown>) => p1.request('PostProcessingUpdateRequest', d);
    expect((await update({ postProcessingFadeTime: 3 })).data.errorID).toBe(1201);
    expect(
      (await update({ setPostProcessingPreset: true, setPostProcessingValues: true })).data.errorID,
    ).toBe(1202);
    expect(
      (await update({ setPostProcessingPreset: true, presetToSet: 'Glow' })).data.errorID,
    ).toBe(1203);
    expect(
      (
        await update({
          setPostProcessingValues: true,
          postProcessingValues: [
            { configID: 'Bloom_Strength', configValue: '1' },
            { configID: 'bloomstrength', configValue: '2' },
          ],
        })
      ).data.errorID,
    ).toBe(1205);
    const off = await update({ postProcessingOn: true });
    expectEnvelope(off, 'PostProcessingUpdateResponse');
    expect(off.data).toEqual({
      postProcessingActive: false,
      presetIsActive: false,
      activePreset: '',
      activeEffectCount: 0,
    });
    const ndi = await p1.request('NDIConfigRequest', { setNewConfig: false });
    expectEnvelope(ndi, 'NDIConfigResponse');
    expect(ndi.data).toMatchObject({
      ndiActive: false,
      useNDI5: false,
      useCustomResolution: false,
    });
    expect(
      (
        await p1.request('NDIConfigRequest', {
          setNewConfig: true,
          ndiActive: true,
          customWidthNDI: 100,
        })
      ).data.errorID,
    ).toBe(551);
    expect(
      (await p1.request('NDIConfigRequest', { setNewConfig: true, ndiActive: true })).data.errorID,
    ).toBe(550);
  });

  it('finds art meshes at a position, and shows the point when asked', async () => {
    const hit = await p1.request('ArtMeshAtPositionRequest', { x: 0, y: 0, visualize: 1 });
    expectEnvelope(hit, 'ArtMeshAtPositionResponse');
    expect(hit.data).toMatchObject({
      modelLoaded: true,
      modelWasHit: true,
      checkedPosition: { x: 0, y: 0 },
    });
    expect(hit.data.artMeshHitCount).toBeGreaterThan(0);
    expect(hit.data.artMeshHits[0]).toMatchObject({
      artMeshOrder: 0,
      hitInfo: { modelID: hit.data.loadedModelID },
    });
    await expect.poll(() => page.locator('.model-outline .model-marker').count()).toBe(1);
    await expect
      .poll(() => page.locator('.model-outline .model-marker').count(), { timeout: 3000 })
      .toBe(0);
    const miss = await p1.request('ArtMeshAtPositionRequest', { x: 0.99, y: 0.99 });
    expect(miss.data).toMatchObject({ modelWasHit: false, artMeshHitCount: 0, artMeshHits: [] });
  });

  it('sends the editor event once (never connected) and expression toggles, with a snapshot', async () => {
    await p1.request('EventSubscriptionRequest', {
      eventName: 'Live2DCubismEditorConnectedEvent',
      subscribe: true,
    });
    const editor = await p1.next(ev('Live2DCubismEditorConnectedEvent'));
    expect(editor.data).toEqual({
      tryingToConnect: false,
      connected: false,
      shouldSendParameters: false,
    });
    await p1.request('EventSubscriptionRequest', {
      eventName: 'ExpressionToggledEvent',
      subscribe: true,
      config: { sendAllActiveStatesOnSubscription: true },
    });
    const snap = await p1.next(ev('ExpressionToggledEvent'));
    expect(snap.data).toMatchObject({
      modelName: 'Test',
      isLive2DItem: false,
      itemInstanceID: '',
      justLoaded: false,
      expressionFile: 'blush.exp3.json',
      active: false,
    });
    await p1.request('ExpressionActivationRequest', {
      expressionFile: 'blush.exp3.json',
      active: true,
    });
    const on = await p1.next(
      (m) => m.messageType === 'ExpressionToggledEvent' && m.data.active === true,
    );
    expect(on.data).toMatchObject({ justLoaded: false, expressionFile: 'blush.exp3.json' });
    await p1.request('ExpressionActivationRequest', {
      expressionFile: 'blush.exp3.json',
      active: false,
    });
    await p1.next((m) => m.messageType === 'ExpressionToggledEvent' && m.data.active === false);
    await p1.request('EventSubscriptionRequest', { subscribe: false });
  });

  it('tracks points on art meshes and outlines meshes (beta events)', async () => {
    const sub = (eventName: string, config: Record<string, unknown>) =>
      p1.request('EventSubscriptionRequest', { eventName, subscribe: true, config });
    expect(
      (await sub('ArtMeshTrackingEvent', { frequency: 0, trackingPoints: [] })).data.errorID,
    ).toBe(100151);
    expect((await sub('ArtMeshOutlineEvent', { frequency: 50, artMeshes: [] })).data.errorID).toBe(
      100201,
    );
    expect(
      (
        await sub('ArtMeshOutlineEvent', {
          artMeshes: [{ artMeshID: 'ArtMeshBody' }, { artMeshID: 'ArtMeshBody' }],
        })
      ).data.errorID,
    ).toBe(100200);
    // A point where the model is hit, from ArtMeshAtPositionRequest's ready-made triangle.
    const hit = (await p1.request('ArtMeshAtPositionRequest', { x: 0, y: 0 })).data.artMeshHits[0]
      .hitInfo;
    expect(
      (
        await sub('ArtMeshTrackingEvent', {
          trackingPoints: [{ trackingPointID: 'p', artMeshCoords: { ...hit, vertexWeight1: 2 } }],
        })
      ).data.errorID,
    ).toBe(100150);
    const ok = await sub('ArtMeshTrackingEvent', {
      frequency: 30,
      trackingPoints: [
        { trackingPointID: 'nose', artMeshCoords: { ...hit, angle: 10, size: 2 } },
        {
          trackingPointID: 'elsewhere',
          artMeshCoords: { ...hit, artMeshID: 'NoSuchMesh', size: 1 },
        },
      ],
    });
    expectEnvelope(ok, 'EventSubscriptionResponse');
    const first = await p1.next(ev('ArtMeshTrackingEvent'));
    expect(first.data).toMatchObject({
      modelLoaded: true,
      subscribedPointsCount: 2,
      foundPointsCount: 1,
      eventCounter: 0,
    });
    const point = first.data.trackingPoints[0];
    expect(point).toMatchObject({
      trackingPointID: 'nose',
      artMeshVisible: true,
      rotation: 10,
      size: 2,
    });
    expect(Math.abs(point.position.x)).toBeLessThan(0.02);
    expect(Math.abs(point.position.y)).toBeLessThan(0.02);
    const second = await p1.next(ev('ArtMeshTrackingEvent'));
    expect(second.data.eventCounter).toBe(1);
    // The model moves: the point follows.
    await p1.request('MoveModelRequest', {
      timeInSeconds: 0,
      valuesAreRelativeToModel: false,
      positionX: 0.4,
    });
    await expect
      .poll(
        async () => (await p1.next(ev('ArtMeshTrackingEvent'))).data.trackingPoints[0].position.x,
        {
          timeout: 5000,
        },
      )
      .toBeGreaterThan(0.35);
    await p1.request('EventSubscriptionRequest', {
      eventName: 'ArtMeshTrackingEvent',
      subscribe: false,
    });
    await sub('ArtMeshOutlineEvent', { frequency: 10, artMeshes: [{ artMeshID: 'ArtMeshBody' }] });
    const outline = await p1.next(ev('ArtMeshOutlineEvent'));
    expect(outline.data).toMatchObject({
      modelLoaded: true,
      subscribedArtMeshCount: 1,
      foundArtMeshCount: 1,
      eventCounter: 0,
    });
    const o = outline.data.artMeshOutlines[0];
    expect(o).toMatchObject({ artMeshID: 'ArtMeshBody', artMeshVisible: true });
    expect(o.outlineCount).toBeGreaterThanOrEqual(1);
    expect(o.outlinePoints[0].points).toHaveLength(40);
    expect(o.outlineArea).toBeGreaterThan(0);
    await p1.request('EventSubscriptionRequest', { subscribe: false });
    await p1.request('MoveModelRequest', {
      timeInSeconds: 0,
      valuesAreRelativeToModel: false,
      positionX: 0,
    });
    expect(errors).toEqual([]);
  });
});
