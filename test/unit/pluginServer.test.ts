import { createSocket } from 'node:dgram';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { BridgeServer } from '../../bridge/src/server.ts';
import { validIcon } from '../../bridge/src/plugins.ts';
import { BridgeStore } from '../../bridge/src/store.ts';
import { PROTOCOL_VERSION } from '../../src/core/bridgeProtocol';
import {
  BRIDGE_REQUESTS,
  DEFAULT_PARAMETER_NAMES,
  PAGE_REQUESTS,
  REQUEST_TYPES,
} from '../../src/core/plugins/protocol';
import { DEFAULT_PARAMETERS } from '../../src/core/plugins/inputs';
import { encodePng } from '../support/syntheticModel';
import { PluginClient, expectEnvelope } from '../support/pluginClient';

/**
 * The plugin server in the bridge, with a scripted plugin and a fake page
 * (which allows or denies plugins and answers forwarded requests). The page's
 * own answers are tested in the browser (test/browser/plugins.test.ts).
 */
const home = mkdtempSync(join(tmpdir(), 'mochi-plugins-'));
const pluginPort = 18_100 + Math.floor(Math.random() * 800);
let bridge: BridgeServer;
let host: WebSocket;
const fromBridge: Array<Record<string, any>> = [];
/** What the fake page answers to token requests. */
let allow = true;
const udp = createSocket('udp4');
const broadcasts: Array<Record<string, any>> = [];
let url: string;

async function waitFor<T>(fn: () => T | undefined, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeAll(async () => {
  await new Promise<void>((r) => udp.bind(0, '127.0.0.1', () => r()));
  udp.on('message', (b) => broadcasts.push(JSON.parse(String(b))));
  const store = new BridgeStore(home);
  bridge = new BridgeServer({
    port: 0,
    store,
    log: () => undefined,
    plugins: {
      port: pluginPort,
      broadcastAddress: '127.0.0.1',
      broadcastPort: udp.address().port,
    },
  });
  const port = await bridge.listen();
  const token = store.pair(store.pairingCode())!;
  host = new WebSocket(`ws://127.0.0.1:${port}/host`, { origin: `http://127.0.0.1:${port}` });
  host.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    fromBridge.push(m);
    if (m.type === 'plugin_approval_request')
      host.send(JSON.stringify({ type: 'plugin_approval', requestId: m.requestId, allow }));
    if (m.type === 'plugin_request')
      host.send(
        JSON.stringify(
          m.messageType === 'FaceFoundRequest'
            ? { type: 'plugin_result', id: m.id, data: { found: false } }
            : { type: 'plugin_result', id: m.id, errorID: 202, message: 'No such hotkey.' },
        ),
      );
  });
  await new Promise<void>((r) =>
    host.on('open', () => {
      host.send(
        JSON.stringify({
          type: 'host_hello',
          protocol: PROTOCOL_VERSION,
          app: 'test',
          version: '0',
          hostToken: token,
        }),
      );
      r();
    }),
  );
  await waitFor(() => fromBridge.find((m) => m.type === 'host_welcome'));
  host.send(JSON.stringify({ type: 'plugins_options', on: true }));
  const state = await waitFor(() => fromBridge.find((m) => m.type === 'plugins' && m.on));
  url = `ws://localhost:${state.port}`;
});
afterAll(async () => {
  host?.close();
  udp.close();
  await bridge?.close();
});

describe('the plugin server (bridge)', () => {
  it('is off until switched on, then listens on the first free port from the default', async () => {
    const state = fromBridge.find((m) => m.type === 'plugins' && m.on);
    expect(state!.port).toBe(pluginPort);
    expect(fromBridge.find((m) => m.type === 'plugins')).toMatchObject({ on: false, port: null });
  });

  it('broadcasts its state for discovery', async () => {
    const b = await waitFor(() => broadcasts[0]);
    expect(b).toMatchObject({
      apiName: 'VTubeStudioPublicAPI',
      apiVersion: '1.0',
      requestID: 'VTubeStudioAPIStateBroadcast',
      messageType: 'VTubeStudioAPIStateBroadcast',
      data: { active: true, port: pluginPort, windowTitle: 'Mochi Studio' },
    });
    expect(b.data.instanceID).toMatch(/^[0-9a-f]{32}$/);
    expect(typeof b.timestamp).toBe('number');
  });

  it('answers envelope errors with the documented IDs', async () => {
    const c = await PluginClient.connect(url);
    const err = async (send: () => void) => {
      send();
      const m = await c.next();
      expectEnvelope(m, 'APIError');
      return m;
    };
    expect((await err(() => c.raw('not json'))).data.errorID).toBe(2);
    expect(
      (
        await err(() =>
          c.raw({ apiName: 'Other', apiVersion: '1.0', messageType: 'APIStateRequest' }),
        )
      ).data.errorID,
    ).toBe(3);
    expect(
      (
        await err(() =>
          c.raw({
            apiName: 'VTubeStudioPublicAPI',
            apiVersion: '2.0',
            messageType: 'APIStateRequest',
          }),
        )
      ).data.errorID,
    ).toBe(4);
    expect(
      (
        await err(() =>
          c.raw({
            apiName: 'VTubeStudioPublicAPI',
            apiVersion: '1.0',
            requestID: 'x'.repeat(65),
            messageType: 'APIStateRequest',
          }),
        )
      ).data.errorID,
    ).toBe(5);
    expect((await err(() => c.send(''))).data.errorID).toBe(6);
    const unknown = await err(() => c.send('NoSuchRequest', undefined, 'mine'));
    expect(unknown.data.errorID).toBe(7);
    expect(unknown.requestID).toBe('mine');
    expect(typeof unknown.data.message).toBe('string');
    // Before authentication only the state and authentication requests work.
    expect((await err(() => c.send('FaceFoundRequest'))).data.errorID).toBe(8);
    c.close();
  });

  it('reports its state, and makes up a requestID when there is none', async () => {
    const c = await PluginClient.connect(url);
    c.raw({ apiName: 'VTubeStudioPublicAPI', apiVersion: '1.0', messageType: 'APIStateRequest' });
    const m = await c.next();
    expectEnvelope(m, 'APIStateResponse');
    expect(m.requestID.length).toBeGreaterThan(0);
    expect(m.data).toEqual({
      active: true,
      vTubeStudioVersion: '0.1.0',
      currentSessionAuthenticated: false,
    });
    // Binary frames holding UTF-8 text are accepted; answers are text.
    c.ws.send(
      Buffer.from(
        JSON.stringify({
          apiName: 'VTubeStudioPublicAPI',
          apiVersion: '1.0',
          requestID: 'bin',
          messageType: 'APIStateRequest',
        }),
      ),
      { binary: true },
    );
    expect((await c.next((x) => x.requestID === 'bin')).messageType).toBe('APIStateResponse');
    c.close();
  });

  it('asks the person before giving a token, and checks the plugin’s identity', async () => {
    const c = await PluginClient.connect(url);
    const bad = async (data: Record<string, unknown>) =>
      (await c.request('AuthenticationTokenRequest', data)).data.errorID;
    expect(await bad({ pluginName: 'ab', pluginDeveloper: 'Dev Name' })).toBe(52);
    expect(await bad({ pluginName: 'Plugin', pluginDeveloper: 'x'.repeat(33) })).toBe(53);
    expect(
      await bad({ pluginName: 'Plugin', pluginDeveloper: 'Dev', pluginIcon: 'bm90IGFuIGltYWdl' }),
    ).toBe(54);
    // Denied: error 50.
    allow = false;
    expect(await bad({ pluginName: 'Denied One', pluginDeveloper: 'Dev' })).toBe(50);
    allow = true;
    const ask = fromBridge.filter((m) => m.type === 'plugin_approval_request').at(-1);
    expect(ask).toMatchObject({ name: 'Denied One', developer: 'Dev', icon: '' });
    // Allowed, with an icon of the right size: a token, then authentication.
    const icon = Buffer.from(encodePng(128, 128, new Uint8Array(128 * 128 * 4))).toString('base64');
    expect(validIcon(icon)).toBe(true);
    const t = await c.request('AuthenticationTokenRequest', {
      pluginName: 'Lantern',
      pluginDeveloper: 'Mira',
      pluginIcon: icon,
    });
    expectEnvelope(t, 'AuthenticationTokenResponse');
    const token = t.data.authenticationToken as string;
    expect(token.length).toBeLessThanOrEqual(64);
    expect(/^[\x20-\x7e]+$/.test(token)).toBe(true);
    // Missing fields: 100, 101, 102. A wrong token is not an error.
    const auth = (d: Record<string, unknown>) => c.request('AuthenticationRequest', d);
    expect((await auth({ pluginName: 'Lantern', pluginDeveloper: 'Mira' })).data.errorID).toBe(100);
    expect((await auth({ authenticationToken: token, pluginDeveloper: 'Mira' })).data.errorID).toBe(
      101,
    );
    expect((await auth({ authenticationToken: token, pluginName: 'Lantern' })).data.errorID).toBe(
      102,
    );
    const wrong = await auth({
      pluginName: 'Lantern',
      pluginDeveloper: 'Mira',
      authenticationToken: 'nope',
    });
    expectEnvelope(wrong, 'AuthenticationResponse');
    expect(wrong.data.authenticated).toBe(false);
    expect(typeof wrong.data.reason).toBe('string');
    const ok = await auth({
      pluginName: 'Lantern',
      pluginDeveloper: 'Mira',
      authenticationToken: token,
    });
    expect(ok.data).toMatchObject({ authenticated: true });
    expect((await c.request('APIStateRequest')).data.currentSessionAuthenticated).toBe(true);
    // The page sees the plugin, connected, with its icon.
    const listed = await waitFor(() =>
      fromBridge
        .filter((m) => m.type === 'plugins')
        .at(-1)
        ?.plugins.find((p: any) => p.name === 'Lantern' && p.sessions === 1),
    );
    expect(listed).toMatchObject({ developer: 'Mira', icon, trackingData: false });
    // A second session reuses the token without asking again.
    const c2 = await PluginClient.connect(url);
    const asks = fromBridge.filter((m) => m.type === 'plugin_approval_request').length;
    expect(
      (
        await c2.request('AuthenticationRequest', {
          pluginName: 'Lantern',
          pluginDeveloper: 'Mira',
          authenticationToken: token,
        })
      ).data.authenticated,
    ).toBe(true);
    expect(fromBridge.filter((m) => m.type === 'plugin_approval_request').length).toBe(asks);
    // Requests for the page are forwarded; its errors come back as APIError.
    const face = await c.request('FaceFoundRequest');
    expectEnvelope(face, 'FaceFoundResponse');
    expect(face.data).toEqual({ found: false });
    const forwarded = fromBridge.filter((m) => m.type === 'plugin_request').at(-1);
    expect(forwarded!.plugin).toMatchObject({ name: 'Lantern', trackingData: false });
    expect((await c.request('HotkeyTriggerRequest', { hotkeyID: 'x' })).data.errorID).toBe(202);
    // Every documented request is answered now, by the bridge or by the page.
    expect(REQUEST_TYPES.filter((t) => !BRIDGE_REQUESTS.has(t) && !PAGE_REQUESTS.has(t))).toEqual(
      [],
    );
    expect((await c.request('ItemSortRequest')).data.errorID).toBe(202);
    // Revoked: every request gets 50; a new token can be asked for.
    host.send(JSON.stringify({ type: 'plugin_revoke', pluginId: listed.id }));
    await waitFor(() => fromBridge.find((m) => m.type === 'plugin_session_end'));
    expect((await c.request('FaceFoundRequest')).data.errorID).toBe(50);
    expect(
      (
        await c2.request('AuthenticationRequest', {
          pluginName: 'Lantern',
          pluginDeveloper: 'Mira',
          authenticationToken: token,
        })
      ).data.errorID,
    ).toBe(50);
    c.close();
    c2.close();
  });

  it('creates and deletes custom parameters, with their rules', async () => {
    const a = await PluginClient.connect(url);
    await a.authenticate('Alpha Plugin', 'Dev');
    const b = await PluginClient.connect(url);
    await b.authenticate('Beta Plugin', 'Dev');
    const create = (c: PluginClient, d: Record<string, unknown>) =>
      c.request('ParameterCreationRequest', { min: 0, max: 1, defaultValue: 0, ...d });
    const made = await create(a, { parameterName: 'GlowLevel', explanation: 'How bright' });
    expectEnvelope(made, 'ParameterCreationResponse');
    expect(made.data).toEqual({ parameterName: 'GlowLevel' });
    expect((await create(a, { parameterName: 'abc' })).data.errorID).toBe(350);
    expect((await create(a, { parameterName: 'Has Space' })).data.errorID).toBe(350);
    expect((await create(a, { parameterName: 'ValidName', min: 'x' })).data.errorID).toBe(351);
    expect((await create(a, { parameterName: 'ValidName', max: 2_000_000 })).data.errorID).toBe(
      351,
    );
    expect(
      (await create(a, { parameterName: 'GlowLevel2', explanation: 'x'.repeat(256) })).data.errorID,
    ).toBe(353);
    expect((await create(a, { parameterName: 'FaceAngleX' })).data.errorID).toBe(354);
    expect((await create(b, { parameterName: 'GlowLevel' })).data.errorID).toBe(352);
    // The same plugin again: allowed, and it changes the range.
    expect((await create(a, { parameterName: 'GlowLevel', max: 10 })).messageType).toBe(
      'ParameterCreationResponse',
    );
    const params = await waitFor(() =>
      fromBridge
        .filter((m) => m.type === 'plugins')
        .at(-1)
        ?.parameters.find((p: any) => p.name === 'GlowLevel' && p.max === 10),
    );
    expect(params).toMatchObject({ pluginName: 'Alpha Plugin', explanation: '' });
    const del = (c: PluginClient, name: string) =>
      c.request('ParameterDeletionRequest', { parameterName: name });
    expect((await del(a, 'FaceAngleX')).data.errorID).toBe(403);
    expect((await del(a, 'NotThere')).data.errorID).toBe(401);
    expect((await del(b, 'GlowLevel')).data.errorID).toBe(402);
    expect((await del(a, '')).data.errorID).toBe(400);
    const gone = await del(a, 'GlowLevel');
    expectEnvelope(gone, 'ParameterDeletionResponse');
    expect(gone.data).toEqual({ parameterName: 'GlowLevel' });
    a.close();
    b.close();
  });

  it('subscribes to events, with their configs, and sends the test event', async () => {
    const c = await PluginClient.connect(url);
    await c.authenticate('Events Plugin', 'Dev');
    const sub = (d: Record<string, unknown>) => c.request('EventSubscriptionRequest', d);
    expect((await sub({ eventName: 'NoSuchEvent', subscribe: true })).data.errorID).toBe(950);
    expect(
      (
        await sub({
          eventName: 'TestEvent',
          subscribe: true,
          config: { testMessageForEvent: 'x'.repeat(33) },
        })
      ).data.errorID,
    ).toBe(100000);
    expect(
      (
        await sub({
          eventName: 'ModelLoadedEvent',
          subscribe: true,
          config: { modelID: ['nothex'] },
        })
      ).data.errorID,
    ).toBe(100050);
    expect(
      (
        await sub({
          eventName: 'HotkeyTriggeredEvent',
          subscribe: true,
          config: { onlyForAction: 'Fly' },
        })
      ).data.errorID,
    ).toBe(100100);
    const r = await sub({
      eventName: 'TestEvent',
      subscribe: true,
      config: { testMessageForEvent: 'hello' },
    });
    expectEnvelope(r, 'EventSubscriptionResponse');
    expect(r.data).toEqual({ subscribedEventCount: 1, subscribedEvents: ['TestEvent'] });
    const ev = await c.next((m) => m.messageType === 'TestEvent', 3000);
    expectEnvelope(ev, 'TestEvent');
    expect(ev.data.yourTestMessage).toBe('hello');
    expect(Number.isInteger(ev.data.counter)).toBe(true);
    await sub({
      eventName: 'HotkeyTriggeredEvent',
      subscribe: true,
      config: { onlyForAction: 'ToggleExpression', ignoreHotkeysTriggeredByAPI: true },
    });
    // Events from the page pass each subscription's config.
    const fire = (data: Record<string, unknown>) =>
      host.send(JSON.stringify({ type: 'plugin_event', name: 'HotkeyTriggeredEvent', data }));
    fire({ hotkeyID: 'a', hotkeyAction: 'TriggerAnimation', hotkeyTriggeredByAPI: false });
    fire({ hotkeyID: 'b', hotkeyAction: 'ToggleExpression', hotkeyTriggeredByAPI: true });
    fire({ hotkeyID: 'c', hotkeyAction: 'ToggleExpression', hotkeyTriggeredByAPI: false });
    const hk = await c.next((m) => m.messageType === 'HotkeyTriggeredEvent');
    expect(hk.data.hotkeyID).toBe('c');
    // Unsubscribing from all.
    const none = await sub({ subscribe: false });
    expect(none.data).toEqual({ subscribedEventCount: 0, subscribedEvents: [] });
    c.close();
  });

  it('keeps the default parameter names in step with the input table', () => {
    expect([...DEFAULT_PARAMETER_NAMES]).toEqual(DEFAULT_PARAMETERS.map((p) => p.name));
  });

  it('answers the permission request honestly', async () => {
    const c = await PluginClient.connect(url);
    await c.authenticate('Perm Plugin', 'Dev');
    const list = await c.request('PermissionRequest', { requestedPermission: '' });
    expectEnvelope(list, 'PermissionResponse');
    expect(list.data).toEqual({
      grantSuccess: false,
      requestedPermission: '',
      permissions: [
        { name: 'LoadCustomImagesAsItems', granted: false },
        { name: 'ControlNDISettings', granted: false },
      ],
    });
    expect(
      (await c.request('PermissionRequest', { requestedPermission: 'Fly' })).data.errorID,
    ).toBe(1100);
    // NDI: Mochi Studio has none, so it is not granted and nobody is asked.
    const asks = () => fromBridge.filter((m) => m.type === 'plugin_approval_request');
    const before = asks().length;
    const ndi = await c.request('PermissionRequest', { requestedPermission: 'ControlNDISettings' });
    expect(ndi.data.grantSuccess).toBe(false);
    expect(asks().length).toBe(before);
    // Custom images: the person is asked. Denied, then allowed.
    allow = false;
    const no = await c.request('PermissionRequest', {
      requestedPermission: 'LoadCustomImagesAsItems',
    });
    expectEnvelope(no, 'PermissionResponse');
    expect(no.data.grantSuccess).toBe(false);
    expect(asks().at(-1)).toMatchObject({
      name: 'Perm Plugin',
      permission: 'LoadCustomImagesAsItems',
    });
    allow = true;
    const yes = await c.request('PermissionRequest', {
      requestedPermission: 'LoadCustomImagesAsItems',
    });
    expect(yes.data).toEqual({
      grantSuccess: true,
      requestedPermission: 'LoadCustomImagesAsItems',
      permissions: [
        { name: 'LoadCustomImagesAsItems', granted: true },
        { name: 'ControlNDISettings', granted: false },
      ],
    });
    // Granted already: answered at once, without asking again.
    const n = asks().length;
    expect(
      (await c.request('PermissionRequest', { requestedPermission: 'LoadCustomImagesAsItems' }))
        .data.grantSuccess,
    ).toBe(true);
    expect(asks().length).toBe(n);
    // The page learns the permission with each forwarded request, and in the plugin list.
    await c.request('FaceFoundRequest');
    expect(
      fromBridge.filter((m) => m.type === 'plugin_request').at(-1)!.plugin.permissions,
    ).toEqual(['LoadCustomImagesAsItems']);
    const listed = fromBridge
      .filter((m) => m.type === 'plugins')
      .at(-1)!
      .plugins.find((p: any) => p.name === 'Perm Plugin');
    expect(listed.permissions).toEqual(['LoadCustomImagesAsItems']);
    // The person takes it back.
    host.send(
      JSON.stringify({
        type: 'plugin_permission',
        pluginId: listed.id,
        permission: 'LoadCustomImagesAsItems',
        granted: false,
      }),
    );
    await waitFor(() =>
      fromBridge
        .filter((m) => m.type === 'plugins')
        .at(-1)!
        .plugins.find((p: any) => p.name === 'Perm Plugin').permissions.length === 0
        ? true
        : undefined,
    );
    c.close();
  });

  it('names its folders, and tells the page which events are wanted', async () => {
    const c = await PluginClient.connect(url);
    await c.authenticate('Geometry Plugin', 'Dev');
    const f = await c.request('VTSFolderInfoRequest');
    expectEnvelope(f, 'VTSFolderInfoResponse');
    expect(Object.keys(f.data).sort()).toEqual(
      ['backgrounds', 'backup', 'config', 'items', 'logs', 'models'].sort(),
    );
    // The page sends ModelMovedEvent on every change; a new subscriber gets the last one at once.
    const pos = { positionX: 0.1, positionY: 0, rotation: 0, size: 0 };
    host.send(
      JSON.stringify({
        type: 'plugin_event',
        name: 'ModelMovedEvent',
        data: { modelID: 'a'.repeat(32), modelName: 'Test', modelPosition: pos },
      }),
    );
    await new Promise((r) => setTimeout(r, 50));
    await c.request('EventSubscriptionRequest', { eventName: 'ModelMovedEvent', subscribe: true });
    const moved = await c.next((m) => m.messageType === 'ModelMovedEvent');
    expect(moved.data.modelPosition).toEqual(pos);
    await c.request('EventSubscriptionRequest', {
      eventName: 'ModelOutlineEvent',
      subscribe: true,
      config: { draw: true },
    });
    const state = await waitFor(() => {
      const st = fromBridge.filter((m) => m.type === 'plugins').at(-1);
      return st?.subscribed.includes('ModelOutlineEvent') ? st : undefined;
    });
    expect(state.drawOutline).toBe(true);
    expect(state.subscribed).toContain('ModelMovedEvent');
    c.close();
    await waitFor(() =>
      fromBridge.filter((m) => m.type === 'plugins').at(-1)?.drawOutline === false
        ? true
        : undefined,
    );
  });

  it('sends the beta and editor events: snapshots, per-session events and counters', async () => {
    const a = await PluginClient.connect(url);
    await a.authenticate('Mesh Plugin A', 'Dev');
    const b = await PluginClient.connect(url);
    await b.authenticate('Mesh Plugin B', 'Dev');
    const sub = (c: PluginClient, eventName: string, config: Record<string, unknown> = {}) =>
      c.request('EventSubscriptionRequest', { eventName, subscribe: true, config });
    // The editor connection: one event on subscribing, never connected.
    await sub(a, 'Live2DCubismEditorConnectedEvent');
    expect(
      (await a.next((m) => m.messageType === 'Live2DCubismEditorConnectedEvent')).data,
    ).toEqual({
      tryingToConnect: false,
      connected: false,
      shouldSendParameters: false,
    });
    // Expressions: the page's list, sent to a subscriber that asks for the full state.
    host.send(
      JSON.stringify({
        type: 'plugin_expressions',
        modelID: 'c'.repeat(32),
        modelName: 'Test',
        expressions: [
          { expressionFile: 'smile.exp3.json', expressionName: 'smile', active: true },
          { expressionFile: 'sad.exp3.json', expressionName: 'sad', active: false },
        ],
      }),
    );
    await new Promise((r) => setTimeout(r, 50));
    await sub(a, 'ExpressionToggledEvent', { sendAllActiveStatesOnSubscription: true });
    const snap = [
      await a.next((m) => m.messageType === 'ExpressionToggledEvent'),
      await a.next((m) => m.messageType === 'ExpressionToggledEvent'),
    ];
    expect(snap.map((m) => [m.data.expressionFile, m.data.active, m.data.justLoaded])).toEqual([
      ['smile.exp3.json', true, false],
      ['sad.exp3.json', false, false],
    ]);
    // The beta configs' errors.
    expect(
      (await sub(a, 'ArtMeshTrackingEvent', { frequency: 61, trackingPoints: [] })).data.errorID,
    ).toBe(100151);
    expect((await sub(a, 'ArtMeshTrackingEvent', { trackingPoints: [] })).data.errorID).toBe(
      100150,
    );
    expect((await sub(a, 'ArtMeshOutlineEvent', { artMeshes: [] })).data.errorID).toBe(100200);
    // Accepted: the page learns each session's config, and gets events per session.
    const point = {
      trackingPointID: 'p1',
      artMeshCoords: {
        artMeshID: 'Face',
        vertexID1: 0,
        vertexID2: 1,
        vertexID3: 2,
        vertexWeight1: 1,
        vertexWeight2: 0,
        vertexWeight3: 0,
        size: 1,
      },
    };
    await sub(a, 'ArtMeshTrackingEvent', { frequency: 5, trackingPoints: [point] });
    await sub(b, 'ArtMeshOutlineEvent', { artMeshes: [{ artMeshID: 'Face' }] });
    const state = await waitFor(() => {
      const st = fromBridge.filter((m) => m.type === 'plugins').at(-1);
      return st?.sessionEvents.length === 2 ? st : undefined;
    });
    const aSession = state.sessionEvents.find(
      (e: any) => e.name === 'ArtMeshTrackingEvent',
    ).session;
    expect(
      state.sessionEvents.find((e: any) => e.name === 'ArtMeshTrackingEvent').config,
    ).toMatchObject({ frequency: 5 });
    const send = () =>
      host.send(
        JSON.stringify({
          type: 'plugin_event',
          name: 'ArtMeshTrackingEvent',
          session: aSession,
          data: { modelLoaded: true, trackingPoints: [] },
        }),
      );
    send();
    send();
    const e1 = await a.next((m) => m.messageType === 'ArtMeshTrackingEvent');
    const e2 = await a.next((m) => m.messageType === 'ArtMeshTrackingEvent');
    expect([e1.data.eventCounter, e2.data.eventCounter]).toEqual([0, 1]);
    // Only that session got them.
    await expect(b.next((m) => m.messageType === 'ArtMeshTrackingEvent', 200)).rejects.toThrow(
      'No matching message',
    );
    // A new subscription counts from 0 again.
    await sub(a, 'ArtMeshTrackingEvent', { frequency: 5, trackingPoints: [point] });
    send();
    expect((await a.next((m) => m.messageType === 'ArtMeshTrackingEvent')).data.eventCounter).toBe(
      0,
    );
    a.close();
    b.close();
  });

  it('stops when switched off', async () => {
    host.send(JSON.stringify({ type: 'plugins_options', on: false }));
    await waitFor(() =>
      fromBridge.filter((m) => m.type === 'plugins').at(-1)?.on === false ? true : undefined,
    );
    await expect(PluginClient.connect(url)).rejects.toBeTruthy();
    host.send(JSON.stringify({ type: 'plugins_options', on: true }));
    await waitFor(() =>
      fromBridge.filter((m) => m.type === 'plugins').at(-1)?.on ? true : undefined,
    );
  });
});
