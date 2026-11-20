import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BridgeServer } from '../../bridge/src/server.ts';
import { BridgeStore } from '../../bridge/src/store.ts';
import { PluginClient, expectEnvelope, type Message } from '../support/pluginClient';
import {
  startHarness,
  syntheticItemZip,
  syntheticModelZip,
  type Harness,
  openSection,
} from './harness';

/**
 * The plugin API end to end: a real bridge, the Mochi Studio page (which
 * answers the requests and sends the events), and scripted plugins that
 * speak the protocol of plugins made for VTube Studio. Every implemented
 * request and error, with the exact message shapes.
 */
let H: Harness;
let bridge: BridgeServer;
let page: Page;
let url: string;
let p1: PluginClient;
const home = mkdtempSync(join(tmpdir(), 'mochi-plugins-page-'));
const pluginPort = 19_100 + Math.floor(Math.random() * 800);
const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/synthetic-session.json', import.meta.url), 'utf8'),
);
const ev = (name: string) => (m: Message) => m.messageType === name;
const zip = (name: string, data: Uint8Array) => ({
  name,
  mimeType: 'application/zip',
  buffer: Buffer.from(data),
});

/** Asks for a token; the person clicks Allow (or Deny) in the page. */
async function connectPlugin(name: string, allow = true): Promise<PluginClient> {
  const c = await PluginClient.connect(url);
  const id = c.send('AuthenticationTokenRequest', { pluginName: name, pluginDeveloper: 'Tester' });
  await page.locator('#plugin-approval').waitFor({ state: 'visible' });
  expect(await page.locator('#plugin-approval').textContent()).toContain(name);
  await page.locator(allow ? '#plugin-allow' : '#plugin-deny').click();
  const t = await c.next((m) => m.requestID === id, 10_000);
  if (!allow) {
    expect(t.data.errorID).toBe(50);
    return c;
  }
  expectEnvelope(t, 'AuthenticationTokenResponse');
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
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.goto(H.url);
  await page.waitForFunction(() => 'mochiStudio' in window);
  await page.locator('#model-zip').setInputFiles(zip('Test.zip', syntheticModelZip()));
  await page.waitForFunction(() => (window as any).mochiStudio.settings !== undefined);
  // Switch the plugin server on in the Agents tab, and pair with the bridge.
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
  url = `ws://localhost:${pluginPort}`;
  p1 = await connectPlugin('Lantern Bridge');
}, 60_000);
afterAll(async () => {
  p1?.close();
  await bridge?.close();
  await H?.close();
});

describe('plugins in the running app', () => {
  it('asks the person, lists the plugin, and shows it in the header', async () => {
    await expect
      .poll(() => page.locator('#plugins-indicator').textContent())
      .toContain('Lantern Bridge');
    expect(await page.locator('#plugins-list').textContent()).toContain('Lantern Bridge');
    // Readable: its text against its own background, by WCAG's contrast ratio.
    const ratio = await page.locator('#plugins-indicator').evaluate((el) => {
      const rgb = (c: string) =>
        c
          .match(/[\d.]+/g)!
          .slice(0, 3)
          .map(Number);
      const lum = (c: string) => {
        const [r, g, b] = rgb(c).map((v) => {
          const x = v / 255;
          return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
      };
      const st = getComputedStyle(el);
      const [a, b] = [lum(st.color), lum(st.backgroundColor)].sort((x, y) => y - x);
      return (a! + 0.05) / (b! + 0.05);
    });
    expect(ratio).toBeGreaterThan(4.5);
    const denied = await connectPlugin('Denied Plugin', false);
    denied.close();
  });

  it('reports statistics and the current model', async () => {
    const st = await p1.request('StatisticsRequest');
    expectEnvelope(st, 'StatisticsResponse');
    expect(Object.keys(st.data).sort()).toEqual(
      [
        'allowedPlugins',
        'connectedPlugins',
        'framerate',
        'startedWithSteam',
        'uptime',
        'vTubeStudioVersion',
        'windowHeight',
        'windowIsFullscreen',
        'windowWidth',
      ].sort(),
    );
    expect(st.data).toMatchObject({
      startedWithSteam: false,
      allowedPlugins: 1,
      connectedPlugins: 1,
    });
    expect(st.data.windowWidth).toBeGreaterThan(100);
    const cm = await p1.request('CurrentModelRequest');
    expectEnvelope(cm, 'CurrentModelResponse');
    expect(cm.data).toMatchObject({
      modelLoaded: true,
      modelName: 'Test',
      vtsModelName: '',
      vtsModelIconName: '',
      live2DModelName: 'test.model3.json',
      numberOfLive2DParameters: 9,
      numberOfLive2DArtmeshes: 2,
      numberOfTextures: 1,
      hasPhysicsFile: false,
      modelPosition: { positionX: 0, positionY: 0, rotation: 0, size: 0 },
    });
    expect(cm.data.modelID).toMatch(/^[0-9a-f]{32}$/);
    expect(cm.data.textureResolution).toBeGreaterThan(0);
    expect(typeof cm.data.modelLoadTime).toBe('number');
    const av = await p1.request('AvailableModelsRequest');
    expectEnvelope(av, 'AvailableModelsResponse');
    expect(av.data).toEqual({
      numberOfModels: 1,
      availableModels: [
        {
          modelLoaded: true,
          modelName: 'Test',
          modelID: cm.data.modelID,
          vtsModelName: '',
          vtsModelIconName: '',
        },
      ],
    });
  });

  it('moves the model, absolutely and relatively, and checks the values', async () => {
    const move = (d: Record<string, unknown>) => p1.request('MoveModelRequest', d);
    expect((await move({ positionX: 0.5 })).data.errorID).toBe(301);
    expect((await move({ timeInSeconds: 3, valuesAreRelativeToModel: false })).data.errorID).toBe(
      302,
    );
    expect(
      (await move({ timeInSeconds: 0, valuesAreRelativeToModel: false, size: 101 })).data.errorID,
    ).toBe(302);
    const r = await move({
      timeInSeconds: 0,
      valuesAreRelativeToModel: false,
      positionX: 0.5,
      size: 50,
    });
    expectEnvelope(r, 'MoveModelResponse');
    expect(r.data).toEqual({});
    await move({ timeInSeconds: 0, valuesAreRelativeToModel: true, rotation: 30, positionY: -0.2 });
    await expect
      .poll(async () => (await p1.request('CurrentModelRequest')).data.modelPosition)
      .toEqual({ positionX: 0.5, positionY: -0.2, rotation: 30, size: 50 });
    const t = await page.evaluate(() => (window as any).mochiStudio.settings.transform);
    expect(t.zoom).toBeCloseTo(10 ** 0.5, 3);
    expect(t.y).toBeCloseTo(0.1, 5);
    // An eased move takes its time.
    await move({
      timeInSeconds: 0.5,
      valuesAreRelativeToModel: false,
      positionX: 0,
      positionY: 0,
      rotation: 0,
      size: 0,
    });
    await new Promise((r) => setTimeout(r, 150));
    const mid = (await p1.request('CurrentModelRequest')).data.modelPosition;
    expect(mid.positionX).toBeGreaterThan(0);
    expect(mid.positionX).toBeLessThan(0.5);
    await expect
      .poll(async () => (await p1.request('CurrentModelRequest')).data.modelPosition)
      .toEqual({ positionX: 0, positionY: 0, rotation: 0, size: 0 });
  });

  it('lists and triggers hotkeys by ID or name, through the queue, with events', async () => {
    await page.evaluate(() =>
      (window as any).mochiStudio.updateSettings({
        hotkeys: [
          {
            id: 'hk-blush',
            label: 'Blush Key',
            keys: 'Ctrl+KeyB',
            button: true,
            action: { type: 'expression', expression: 'Blush' },
          },
          {
            id: 'hk-wave',
            label: 'Wave',
            keys: '',
            button: false,
            action: { type: 'motion', motion: { group: 'Wave', index: 0 }, mode: 'once' },
          },
          { id: 'hk-cal', label: '', keys: '', button: false, action: { type: 'calibrate' } },
        ],
      }),
    );
    const list = await p1.request('HotkeysInCurrentModelRequest');
    expectEnvelope(list, 'HotkeysInCurrentModelResponse');
    expect(list.data.modelLoaded).toBe(true);
    expect(list.data.availableHotkeys).toEqual([
      {
        name: 'Blush Key',
        type: 'ToggleExpression',
        description: 'Toggles the expression Blush.',
        file: 'blush.exp3.json',
        hotkeyID: 'hk-blush',
        // Under the API's key names.
        keyCombination: ['LeftControl', 'B'],
        onScreenButtonID: 1,
      },
      {
        name: 'Wave',
        type: 'TriggerAnimation',
        description: 'Plays a motion once.',
        file: 'wave.motion3.json',
        hotkeyID: 'hk-wave',
        keyCombination: [],
        onScreenButtonID: -1,
      },
      {
        name: '',
        type: 'CalibrateCam',
        description: 'Calibrates the neutral pose.',
        file: '',
        hotkeyID: 'hk-cal',
        keyCombination: [],
        onScreenButtonID: -1,
      },
    ]);
    expect(
      (await p1.request('HotkeysInCurrentModelRequest', { modelID: 'f'.repeat(32) })).data.errorID,
    ).toBe(152);
    await p1.request('EventSubscriptionRequest', {
      eventName: 'HotkeyTriggeredEvent',
      subscribe: true,
    });
    await p1.request('EventSubscriptionRequest', {
      eventName: 'ModelAnimationEvent',
      subscribe: true,
    });
    // By name, ignoring case.
    const t = await p1.request('HotkeyTriggerRequest', { hotkeyID: 'blush key' });
    expectEnvelope(t, 'HotkeyTriggerResponse');
    expect(t.data).toEqual({ hotkeyID: 'hk-blush' });
    const fired = await p1.next(ev('HotkeyTriggeredEvent'));
    expectEnvelope(fired, 'HotkeyTriggeredEvent');
    expect(fired.data).toMatchObject({
      hotkeyID: 'hk-blush',
      hotkeyName: 'Blush Key',
      hotkeyAction: 'ToggleExpression',
      hotkeyFile: 'blush.exp3.json',
      hotkeyTriggeredByAPI: true,
      modelName: 'Test',
      isLive2DItem: false,
    });
    expect(await page.evaluate(() => [...(window as any).mochiStudio.activeExpressions])).toEqual([
      'Blush',
    ]);
    // Right after it ran: the cooldown.
    expect((await p1.request('HotkeyTriggerRequest', { hotkeyID: 'hk-blush' })).data.errorID).toBe(
      203,
    );
    expect((await p1.request('HotkeyTriggerRequest', { hotkeyID: 'nothing' })).data.errorID).toBe(
      202,
    );
    // An empty name can only be used by ID.
    expect((await p1.request('HotkeyTriggerRequest', { hotkeyID: '' })).data.errorID).toBe(202);
    expect(
      (await p1.request('HotkeyTriggerRequest', { hotkeyID: 'x', itemInstanceID: 'none' })).data
        .errorID,
    ).toBe(207);
    // The motion: animation start and end events.
    await p1.request('HotkeyTriggerRequest', { hotkeyID: 'hk-wave' });
    const start = await p1.next(
      (m) => m.messageType === 'ModelAnimationEvent' && m.data.animationEventType === 'Start',
    );
    expect(start.data).toMatchObject({
      animationEventData: 'Anim_Start',
      animationName: 'wave.motion3.json',
      animationLength: 0.5,
      isIdleAnimation: false,
      isLive2DItem: false,
    });
    const end = await p1.next(
      (m) => m.messageType === 'ModelAnimationEvent' && m.data.animationEventType === 'End',
    );
    expect(end.data).toMatchObject({ animationEventData: 'Anim_End', animationEventTime: 0.5 });
    // A keyboard press is not by the API.
    await page.locator('#stage').click({ position: { x: 3, y: 3 } });
    await page.keyboard.press('Control+KeyB');
    const byKey = await p1.next(
      (m) =>
        m.messageType === 'HotkeyTriggeredEvent' &&
        m.data.hotkeyID === 'hk-blush' &&
        m.data.hotkeyTriggeredByAPI === false,
    );
    expect(byKey.data.hotkeyTriggeredByAPI).toBe(false);
  });

  it('reads and switches expressions', async () => {
    const st = await p1.request('ExpressionStateRequest', { details: true });
    expectEnvelope(st, 'ExpressionStateResponse');
    expect(st.data.modelLoaded).toBe(true);
    const blush = st.data.expressions.find((e: any) => e.file === 'blush.exp3.json');
    expect(blush).toMatchObject({
      name: 'blush',
      file: 'blush.exp3.json',
      active: false,
      deactivateWhenKeyIsLetGo: false,
      autoDeactivateAfterSeconds: false,
      secondsRemaining: 0,
      usedInHotkeys: [{ name: 'Blush Key', id: 'hk-blush' }],
    });
    expect(blush.parameters.map((p: any) => p.name).sort()).toEqual([
      'ParamCustom',
      'ParamMouthForm',
    ]);
    expect(
      (await p1.request('ExpressionStateRequest', { expressionFile: 'x.json' })).data.errorID,
    ).toBe(600);
    expect(
      (await p1.request('ExpressionStateRequest', { expressionFile: 'no.exp3.json' })).data.errorID,
    ).toBe(601);
    const on = await p1.request('ExpressionActivationRequest', {
      expressionFile: 'blush.exp3.json',
      active: true,
    });
    expectEnvelope(on, 'ExpressionActivationResponse');
    expect(on.data).toEqual({});
    const now = await p1.request('ExpressionStateRequest', { expressionFile: 'blush.exp3.json' });
    expect(now.data.expressions).toHaveLength(1);
    expect(now.data.expressions[0]).toMatchObject({
      active: true,
      usedInHotkeys: [],
      parameters: [],
    });
    await p1.request('ExpressionActivationRequest', {
      expressionFile: 'blush.exp3.json',
      active: false,
    });
    expect(await page.evaluate(() => [...(window as any).mochiStudio.activeExpressions])).toEqual(
      [],
    );
    expect(
      (
        await p1.request('ExpressionActivationRequest', {
          expressionFile: 'blush.json',
          active: true,
        })
      ).data.errorID,
    ).toBe(650);
    expect(
      (
        await p1.request('ExpressionActivationRequest', {
          expressionFile: 'no.exp3.json',
          active: true,
        })
      ).data.errorID,
    ).toBe(651);
  });

  it('lists art meshes and tints them, until the session ends', async () => {
    const list = await p1.request('ArtMeshListRequest');
    expectEnvelope(list, 'ArtMeshListResponse');
    expect(list.data).toEqual({
      modelLoaded: true,
      numberOfArtMeshNames: 2,
      artMeshNames: ['ArtMeshBody', 'ArtMeshMouth'],
      numberOfArtMeshTags: 0,
      artMeshTags: [],
      numberOfArtMeshGroups: 0,
      artMeshGroups: [],
    });
    const tint = (d: Record<string, unknown>) => p1.request('ColorTintRequest', d);
    expect(
      (await tint({ colorTint: { colorR: 1, colorG: 2, colorB: 3, colorA: 4 } })).data.errorID,
    ).toBe(251);
    expect(
      (
        await tint({
          colorTint: { colorR: 300, colorG: 2, colorB: 3, colorA: 4 },
          artMeshMatcher: { tintAll: true },
        })
      ).data.errorID,
    ).toBe(252);
    expect(
      (
        await tint({
          colorTint: { colorR: 1, colorG: 2, colorB: 3 },
          artMeshMatcher: { tintAll: true },
        })
      ).data.errorID,
    ).toBe(252);
    const one = await tint({
      colorTint: { colorR: 255, colorG: 0, colorB: 0, colorA: 255 },
      artMeshMatcher: { nameContains: ['MOUTH'] },
    });
    expectEnvelope(one, 'ColorTintResponse');
    expect(one.data).toEqual({ matchedArtMeshes: 1 });
    const other = await connectPlugin('Tint Plugin');
    expect(
      (
        await other.request('ColorTintRequest', {
          colorTint: { colorR: 0, colorG: 0, colorB: 255, colorA: 255 },
          artMeshMatcher: { artMeshNumber: [0] },
        })
      ).data,
    ).toEqual({ matchedArtMeshes: 1 });
    const tints = () =>
      page.evaluate(() => [...(window as any).mochiStudio.runtime.tints.keys()].sort());
    expect(await tints()).toEqual([0, 1]);
    // The other session ends: its art mesh returns to white.
    other.close();
    await expect.poll(tints).toEqual([1]);
    // White restores the original.
    await tint({
      colorTint: { colorR: 255, colorG: 255, colorB: 255, colorA: 255 },
      artMeshMatcher: { tintAll: true },
    });
    expect(await tints()).toEqual([]);

    // Drawn (Mochi2D 0.7.0's setTint): the model's middle turns blue, then back.
    const middle = () =>
      page.evaluate(async () => {
        const s = (window as any).mochiStudio;
        const png: Uint8Array = await s.screenshot();
        const bmp = await createImageBitmap(new Blob([png as BlobPart], { type: 'image/png' }));
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const g = c.getContext('2d')!;
        g.drawImage(bmp, 0, 0);
        return [...g.getImageData(bmp.width >> 1, bmp.height >> 1, 1, 1).data];
      });
    const before = await middle();
    expect(before[3]).toBeGreaterThan(200);
    await tint({
      colorTint: { colorR: 0, colorG: 0, colorB: 255, colorA: 255 },
      artMeshMatcher: { tintAll: true },
    });
    expect(
      await page.evaluate(() => (window as any).mochiStudio.runtime.model.getTint('ArtMeshBody')),
    ).toEqual([0, 0, 1, 1]);
    const blue = await middle();
    expect(blue[0]).toBeLessThan(20);
    expect(blue[1]).toBeLessThan(20);
    expect(Math.abs(blue[2]! - before[2]!)).toBeLessThan(12);
    await tint({
      colorTint: { colorR: 255, colorG: 255, colorB: 255, colorA: 255 },
      artMeshMatcher: { tintAll: true },
    });
    const after = await middle();
    for (let i = 0; i < 3; i++) expect(Math.abs(after[i]! - before[i]!)).toBeLessThan(6);
    expect(await page.evaluate(() => (window as any).mochiStudio.runtime.model.tints.size)).toBe(0);
  });

  it('keeps tracking data private unless the person allows it', async () => {
    // The recorded session's pose at 3.2 s, held in real time (fed 30 times a second): the
    // head turns about 25°, and stays turned however long the checks take.
    const pose = fixture.frames.filter((f: { t: number }) => f.t <= 3200).at(-1);
    await page.evaluate((pose) => {
      const w = window as any;
      w.poseFeed = setInterval(
        () => w.mochiStudio.feedFrame({ ...pose, t: performance.now() }),
        33,
      );
    }, pose);
    const yaw = () => page.evaluate(() => (window as any).mochiStudio.lastInputs.HeadYaw ?? 0);
    await expect.poll(async () => Math.abs(await yaw())).toBeGreaterThan(5);
    expect((await p1.request('FaceFoundRequest')).data).toEqual({ found: true });
    const value = async () =>
      (await p1.request('ParameterValueRequest', { name: 'FaceAngleX' })).data;
    const hidden = await value();
    expect(hidden).toEqual({
      name: 'FaceAngleX',
      addedBy: 'Mochi Studio',
      value: 0,
      min: -30,
      max: 30,
      defaultValue: 0,
    });
    const l2d = await p1.request('Live2DParameterListRequest');
    expectEnvelope(l2d, 'Live2DParameterListResponse');
    const angle = l2d.data.parameters.find((p: any) => p.name === 'ParamAngleX');
    expect(angle).toEqual({ name: 'ParamAngleX', value: 0, min: -30, max: 30, defaultValue: 0 });
    // Allowed in the Agents tab: the real values (waited for, not sampled).
    await page.locator('#plugins-list .plugin-tracking').first().check();
    await expect
      .poll(async () => {
        const v = (await value()).value;
        return Math.abs(v) > 5 && Math.abs(v - (await yaw())) < 0.5;
      })
      .toBe(true);
    await expect
      .poll(async () =>
        Math.abs(
          (await p1.request('Live2DParameterListRequest')).data.parameters.find(
            (p: any) => p.name === 'ParamAngleX',
          ).value,
        ),
      )
      .toBeGreaterThan(1);
    await page.locator('#plugins-list .plugin-tracking').first().uncheck();
    await page.evaluate(() => clearInterval((window as any).poseFeed));
    const list = await p1.request('InputParameterListRequest');
    expectEnvelope(list, 'InputParameterListResponse');
    expect(list.data.modelLoaded).toBe(true);
    expect(list.data.defaultParameters.map((p: any) => p.name)).toContain('MouthOpen');
    expect(list.data.defaultParameters.every((p: any) => p.addedBy === 'Mochi Studio')).toBe(true);
    expect((await p1.request('ParameterValueRequest', { name: 'NoSuchParam' })).data.errorID).toBe(
      500,
    );
  });

  it('creates custom inputs that drive the model through the mapping, in set and add modes', async () => {
    const made = await p1.request('ParameterCreationRequest', {
      parameterName: 'LanternGlow',
      explanation: 'How brightly the lantern glows',
      min: 0,
      max: 1,
      defaultValue: 0,
    });
    expect(made.data).toEqual({ parameterName: 'LanternGlow' });
    // It appears as an input in the mapping editor, with the plugin's name.
    await expect
      .poll(() =>
        page.evaluate(() =>
          [...document.querySelectorAll('#dl-inputs option')].map((o) => o.textContent),
        ),
      )
      .toContain('LanternGlow (from the plugin Lantern Bridge)');
    await page.evaluate(() => {
      const s = (window as any).mochiStudio;
      s.updateSettings({
        mapping: [
          ...s.settings.mapping,
          {
            id: 'glow',
            enabled: true,
            input: 'plugin.LanternGlow',
            output: 'ParamCustom',
            inMin: 0,
            inMax: 1,
            outMin: 0,
            outMax: 1,
            invert: false,
            clamp: true,
            smoothing: 0,
          },
        ],
      });
    });
    const inject = (c: PluginClient, d: Record<string, unknown>) =>
      c.request('InjectParameterDataRequest', d);
    const custom = () =>
      page.evaluate(() => (window as any).mochiStudio.runtime.parameterValue('ParamCustom'));
    /**
     * Waits for a value, sending the injections again each time it looks: injected values
     * end after a second without renewal, which a busy machine can take to draw a frame.
     * Each look takes a few round trips, which on such a machine add up past a second.
     */
    const renewed = (send: () => Promise<unknown>, read: () => Promise<number>) =>
      expect.poll(
        async () => {
          await send();
          return read();
        },
        { timeout: 10_000 },
      );
    const r = await inject(p1, { parameterValues: [{ id: 'LanternGlow', value: 0.8 }] });
    expectEnvelope(r, 'InjectParameterDataResponse');
    expect(r.data).toEqual({});
    await renewed(
      () => inject(p1, { parameterValues: [{ id: 'LanternGlow', value: 0.8 }] }),
      custom,
    ).toBeCloseTo(0.8, 2);
    // The plugin reads its own value back.
    expect((await p1.request('ParameterValueRequest', { name: 'LanternGlow' })).data).toMatchObject(
      {
        name: 'LanternGlow',
        addedBy: 'Lantern Bridge',
        value: 0.8,
      },
    );
    // Errors.
    expect((await inject(p1, {})).data.errorID).toBe(450);
    expect((await inject(p1, { parameterValues: [] })).data.errorID).toBe(450);
    expect(
      (await inject(p1, { parameterValues: [{ id: 'LanternGlow', value: 'x' }] })).data.errorID,
    ).toBe(451);
    expect(
      (await inject(p1, { parameterValues: [{ id: 'LanternGlow', value: 2e6 }] })).data.errorID,
    ).toBe(451);
    expect(
      (await inject(p1, { parameterValues: [{ id: 'LanternGlow', value: 1, weight: 2 }] })).data
        .errorID,
    ).toBe(452);
    expect((await inject(p1, { parameterValues: [{ id: 'Nope', value: 1 }] })).data.errorID).toBe(
      453,
    );
    expect(
      (await inject(p1, { mode: 'mix', parameterValues: [{ id: 'LanternGlow', value: 1 }] })).data
        .errorID,
    ).toBe(455);
    // Another plugin cannot set it while the first one does; adding works. The first one
    // sets it again just before: connecting can take longer than the second its value lasts.
    const p2 = await connectPlugin('Bonk Plugin');
    expect(
      (await inject(p1, { parameterValues: [{ id: 'LanternGlow', value: 0.8 }] })).data,
    ).toEqual({});
    expect(
      (await inject(p2, { parameterValues: [{ id: 'LanternGlow', value: 0.1 }] })).data.errorID,
    ).toBe(454);
    await renewed(async () => {
      await inject(p1, { parameterValues: [{ id: 'LanternGlow', value: 0.5 }] });
      await inject(p2, { mode: 'add', parameterValues: [{ id: 'LanternGlow', value: 0.25 }] });
    }, custom).toBeCloseTo(0.75, 2);
    // A weight blends toward the tracked (here the default) value.
    await renewed(
      () => inject(p1, { parameterValues: [{ id: 'LanternGlow', value: 0.5, weight: 0.5 }] }),
      custom,
    ).toBeCloseTo(0.5, 2);
    // Default parameters too: FaceAngleX is Mochi Studio's head turn.
    await renewed(
      () => inject(p1, { faceFound: true, parameterValues: [{ id: 'FaceAngleX', value: 12 }] }),
      () => page.evaluate(() => (window as any).mochiStudio.lastInputs.HeadYaw),
    ).toBeCloseTo(12, 3);
    expect((await p1.request('FaceFoundRequest')).data.found).toBe(true);
    // Without renewal, injected values end after a second.
    p2.close();
    await expect.poll(custom, { timeout: 4000 }).toBeCloseTo(0, 2);
    // The custom parameter lists with its plugin.
    const list = await p1.request('InputParameterListRequest');
    expect(list.data.customParameters).toEqual([
      { name: 'LanternGlow', addedBy: 'Lantern Bridge', value: 0, min: 0, max: 1, defaultValue: 0 },
    ]);
  });

  it('sends the subscribed events', async () => {
    const sub = (eventName: string, config?: Record<string, unknown>) =>
      p1.request('EventSubscriptionRequest', {
        eventName,
        subscribe: true,
        ...(config ? { config } : {}),
      });
    await sub('ModelLoadedEvent');
    await sub('BackgroundChangedEvent');
    await sub('ModelConfigChangedEvent');
    await sub('ItemEvent');
    await sub('ModelClickedEvent');
    await sub('TrackingStatusChangedEvent');
    // Background.
    await page.evaluate(() =>
      (window as any).mochiStudio.setStage({ background: { kind: 'chroma', color: '#00ff00' } }),
    );
    expect((await p1.next(ev('BackgroundChangedEvent'))).data).toEqual({
      backgroundName: 'Chroma key #00ff00',
    });
    await page.evaluate(() =>
      (window as any).mochiStudio.setStage({ background: { kind: 'transparent' } }),
    );
    // Model settings changed by hand, hotkeys included.
    await page.evaluate(() => (window as any).mochiStudio.updateSettings({ hotkeys: [] }));
    const cfg = await p1.next(ev('ModelConfigChangedEvent'));
    expect(cfg.data).toMatchObject({ modelName: 'Test', hotkeyConfigChanged: true });
    // A click on the model.
    const box = (await page.locator('#stage').boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    const click = await p1.next(ev('ModelClickedEvent'));
    expect(click.data).toMatchObject({
      modelLoaded: true,
      loadedModelName: 'Test',
      mouseButtonID: 0,
    });
    expect(click.data.clickPosition.x).toBeCloseTo(0, 1);
    expect(click.data.windowSize.x).toBe(Math.round(box.width));
    if (click.data.modelWasClicked) {
      const hit = click.data.artMeshHits[0];
      expect(hit.artMeshOrder).toBe(0);
      const w = hit.hitInfo.vertexWeight1 + hit.hitInfo.vertexWeight2 + hit.hitInfo.vertexWeight3;
      expect(w).toBeCloseTo(1, 4);
    }
    // An item added.
    await openSection(page, 'Items');
    await page.locator('#item-zip').setInputFiles(zip('Hat.zip', syntheticItemZip()));
    const item = await p1.next(ev('ItemEvent'));
    expect(item.data).toMatchObject({ itemEventType: 'Added', itemFileName: 'Hat' });
    expect(Object.keys(item.data.itemPosition)).toEqual(['x', 'y']);
    await page.evaluate(() => {
      const s = (window as any).mochiStudio;
      for (const i of [...s.items]) s.removeItem(i.id);
    });
    expect((await p1.next(ev('ItemEvent'))).data.itemEventType).toBe('Removed');
    // Unload and load: model events, with the ID.
    const id = (await p1.request('CurrentModelRequest')).data.modelID;
    const unload = await p1.request('ModelLoadRequest', { modelID: '' });
    expectEnvelope(unload, 'ModelLoadResponse');
    expect(unload.data).toEqual({ modelID: '' });
    expect((await p1.next(ev('ModelLoadedEvent'))).data).toEqual({
      modelLoaded: false,
      modelName: 'Test',
      modelID: id,
    });
    // The cooldown, and the errors without a model.
    expect((await p1.request('ModelLoadRequest', { modelID: '' })).data.errorID).toBe(153);
    expect((await p1.request('ModelLoadRequest', {})).data.errorID).toBe(150);
    expect((await p1.request('ModelLoadRequest', { modelID: 'xyz' })).data.errorID).toBe(151);
    expect((await p1.request('HotkeyTriggerRequest', { hotkeyID: 'hk-wave' })).data.errorID).toBe(
      201,
    );
    expect(
      (await p1.request('ColorTintRequest', { colorTint: {}, artMeshMatcher: {} })).data.errorID,
    ).toBe(250);
    expect(
      (await p1.request('MoveModelRequest', { timeInSeconds: 0, valuesAreRelativeToModel: true }))
        .data.errorID,
    ).toBe(300);
    expect(
      (
        await p1.request('ExpressionActivationRequest', {
          expressionFile: 'blush.exp3.json',
          active: true,
        })
      ).data.errorID,
    ).toBe(652);
    const empty = await p1.request('CurrentModelRequest');
    expect(empty.data).toMatchObject({
      modelLoaded: false,
      modelName: '',
      modelID: '',
      numberOfLive2DParameters: 0,
    });
    expect((await p1.request('ArtMeshListRequest')).data).toMatchObject({
      modelLoaded: false,
      artMeshNames: [],
    });
    await page.locator('#model-zip').setInputFiles(zip('Test.zip', syntheticModelZip()));
    expect((await p1.next(ev('ModelLoadedEvent'))).data).toEqual({
      modelLoaded: true,
      modelName: 'Test',
      modelID: id,
    });
    await new Promise((r) => setTimeout(r, 2100));
    expect((await p1.request('ModelLoadRequest', { modelID: 'f'.repeat(32) })).data.errorID).toBe(
      152,
    );
  });

  it('answers SceneColorOverlayInfoRequest with the light overlay’s real state', async () => {
    const info = async () => (await p1.request('SceneColorOverlayInfoRequest')).data;
    // Off: white.
    expect(await info()).toMatchObject({
      active: false,
      colorOverlayR: 255,
      colorOverlayG: 255,
      colorOverlayB: 255,
      leftCapturePart: { active: false, colorR: 255 },
    });
    // A screen whose thirds are red, green and blue, through a stand-in for the capture.
    await page.evaluate(async () => {
      const c = document.createElement('canvas');
      c.width = 90;
      c.height = 30;
      const g = c.getContext('2d')!;
      ['#ff0000', '#00ff00', '#0000ff'].forEach((col, i) => {
        g.fillStyle = col;
        g.fillRect(i * 30, 0, 30, 30);
      });
      const w = window as any;
      w.paint = setInterval(() => g.fillRect(0, 0, 0, 0), 50);
      navigator.mediaDevices.getDisplayMedia = async () => c.captureStream(10);
      w.mochiStudio.setLightOverlaySettings({ smoothing: 0, baseBrightness: 50, colorBoost: 50 });
      await w.mochiStudio.startLightOverlay();
    });
    await expect.poll(async () => (await info()).active, { timeout: 5000 }).toBe(true);
    await expect.poll(async () => (await info()).colorAvgR, { timeout: 5000 }).toBe(85);
    expect(await info()).toMatchObject({
      isWindowCapture: false,
      baseBrightness: 50,
      colorBoost: 50,
      smoothing: 0,
      leftCapturePart: { active: true, colorR: 255, colorG: 0, colorB: 0 },
      middleCapturePart: { active: true, colorR: 0, colorG: 255, colorB: 0 },
      rightCapturePart: { active: true, colorR: 0, colorG: 0, colorB: 255 },
      colorAvgG: 85,
      // 85 × 50/50 + 255 × 50/100.
      colorOverlayR: 213,
    });
    await page.evaluate(() => {
      const w = window as any;
      w.mochiStudio.stopLightOverlay();
      clearInterval(w.paint);
    });
    expect((await info()).active).toBe(false);
  });

  it('can be revoked in the Agents tab', async () => {
    await openSection(page, 'Agents');
    await page.locator('#plugins-list .plugin-revoke').first().click();
    await expect.poll(async () => (await p1.request('FaceFoundRequest')).data.errorID).toBe(50);
    await expect.poll(() => page.locator('#plugins-indicator').isVisible()).toBe(false);
    // Its custom parameter is gone with it.
    await expect
      .poll(() => page.evaluate(() => (window as any).mochiPlugins.parameters.length))
      .toBe(0);
  });
});
