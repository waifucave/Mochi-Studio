import type { ItemEntry } from '../items';
import { describe, expect, it } from 'vitest';
import { discoverUnlisted, parseManifest, type LoadedModelFiles } from '../modelFiles';
import {
  DEFAULT_APP_SETTINGS,
  defaultSettings,
  type AppSettings,
  type ModelSettings,
} from '../settings';
import { CommandError, CommandRegistry } from './registry';
import { s, SchemaError } from './schema';
import { studioCommands, type Snapshot, type StudioApi } from './studioCommands';

/** A fake app with just enough state for the commands. */
function fakeStudio() {
  const manifest = discoverUnlisted(
    parseManifest(
      JSON.stringify({
        FileReferences: {
          Moc: 'm.moc3',
          Expressions: [{ Name: 'Smile', File: 'smile.exp3.json' }],
          Motions: { Wave: [{ File: 'wave.motion3.json' }] },
        },
      }),
      'm.model3.json',
    ),
    [],
  );
  const model = {
    manifest,
    files: { label: 'm' },
    key: 'm#1',
    missing: [],
  } as unknown as LoadedModelFiles;
  const calls: string[] = [];
  const st = {
    model,
    parameters: [
      { id: 'ParamAngleX', name: 'Angle X', min: -30, max: 30, default: 0 },
      { id: 'AngleX', name: 'Angle X (physics input)', min: -30, max: 30, default: 0 },
    ],
    physicsDrivers: { ParamAngleX: { from: 'AngleX', reflect: false } },
    settings: defaultSettings('m#1', ['ParamAngleX']) as ModelSettings | undefined,
    app: { ...DEFAULT_APP_SETTINGS } as AppSettings,
    get stage() {
      return { background: st.app.background, fpsCap: st.app.fpsCap };
    },
    activeExpressions: new Set<string>(),
    scenesOn: new Set<string>(),
    overrides: {} as Record<string, number>,
    cameraOn: false,
    trackingOn: false,
    faceVisible: false,
    microphoneOn: false,
    items: [{ id: 'lamp' }, { id: 'mug' }] as unknown as ItemEntry[],
    agents: [],
    isItemVisible: (id: string) => id === 'lamp',
    isItemPinned: () => false,
    itemPlacement: () => undefined,
    loadModelFromUrl: async (url: string) => void calls.push(`load ${url}`),
    unloadModel: () => void calls.push('unload'),
    updateSettings(p: Partial<ModelSettings>) {
      st.settings = { ...st.settings!, ...p };
    },
    setStage(p: Partial<AppSettings>) {
      st.app = { ...st.app, ...p };
    },
    setExpression(n: string, on: boolean) {
      if (on) st.activeExpressions.add(n);
      else st.activeExpressions.delete(n);
    },
    playMotion: (r: { group: string; index: number }, m: string) =>
      void calls.push(`motion ${r.group}/${r.index} ${m}`),
    stopMotions: () => void calls.push('stop'),
    setItemVisible: () => undefined,
    isItemSceneOn: (id: string) => st.scenesOn.has(id),
    setItemScene(id: string, on: boolean, fade?: number) {
      calls.push(`scene ${id} ${on} ${fade}`);
      if (on) st.scenesOn.add(id);
      else st.scenesOn.delete(id);
    },
    createItemScene(name: string, group: string, itemIds: readonly string[]) {
      const scene = {
        id: `scene${st.settings!.itemScenes.length + 1}`,
        name,
        ...(group ? { group } : {}),
        items: itemIds.map((id) => ({ id })),
      };
      st.settings = { ...st.settings!, itemScenes: [...st.settings!.itemScenes, scene] };
      return scene;
    },
    removeItemScene(id: string) {
      st.settings = {
        ...st.settings!,
        itemScenes: st.settings!.itemScenes.filter((x) => x.id !== id),
      };
    },
    placeItem: () => undefined,
    pinItem: () => true,
    fireHotkey: (id: string) => void calls.push(`fire ${id}`),
    releaseHotkey: () => undefined,
    calibrate: async () => true,
    setOverrides(v: Record<string, number>) {
      Object.assign(st.overrides, v);
    },
    clearOverrides(ids?: string[]) {
      for (const k of ids ?? Object.keys(st.overrides)) delete st.overrides[k];
    },
    speak: async () => undefined,
    screenshot: async () => new Uint8Array([137, 80, 78, 71]),
    spoutAvailable: false,
    spoutStatus() {
      return st.spoutAvailable
        ? { available: true, settings: st.app.spout, outputs: [] }
        : {
            available: false,
            problem: 'Spout2 is for Windows.',
            settings: st.app.spout,
            outputs: [],
          };
    },
    setSpout(settings: AppSettings['spout']) {
      st.app = { ...st.app, spout: settings };
      calls.push('setSpout');
    },
    virtualCameraStatus() {
      const base = { active: false, width: 0, height: 0, fps: 0, frames: 0 };
      return st.spoutAvailable
        ? { available: true, settings: st.app.virtualCamera, ...base }
        : {
            available: false,
            problem: 'The virtual camera is for the desktop app.',
            settings: st.app.virtualCamera,
            ...base,
          };
    },
    setVirtualCamera(settings: AppSettings['virtualCamera']) {
      st.app = { ...st.app, virtualCamera: settings };
      calls.push('setVirtualCamera');
    },
    restore(snap: Snapshot) {
      st.app = snap.app;
      if (snap.settings) st.settings = snap.settings;
      st.overrides = { ...snap.overrides };
    },
    commands: undefined as unknown as CommandRegistry<StudioApi>,
  };
  st.commands = new CommandRegistry<StudioApi>(st as unknown as StudioApi, studioCommands());
  return { st, calls, reg: st.commands };
}

const agent = (scopes: Array<'read' | 'control' | 'screenshot'>) => ({
  kind: 'agent' as const,
  name: 'bot',
  scopes,
});

describe('schema', () => {
  const sch = s.object({
    a: s.number({ min: 0 }),
    b: s.optional(s.array(s.string({ enum: ['x', 'y'] }))),
  });
  it('validates with paths', () => {
    expect(sch.parse({ a: 1, b: ['x'] })).toEqual({ a: 1, b: ['x'] });
    expect(() => sch.parse({ a: -1 })).toThrow('a: must be at least 0');
    expect(() => sch.parse({ a: 1, b: ['z'] })).toThrow('b[0]: must be one of x, y');
    expect(() => sch.parse({ a: 1, c: 2 })).toThrow(SchemaError);
    expect(() => sch.parse({})).toThrow('a: is required');
  });
  it('produces JSON Schema', () => {
    expect(sch.json).toMatchObject({
      type: 'object',
      required: ['a'],
      additionalProperties: false,
      properties: { a: { type: 'number', minimum: 0 }, b: { type: 'array' } },
    });
  });
});

describe('the command layer', () => {
  it('validates arguments, checks scopes and names unknown commands', async () => {
    const { reg } = fakeStudio();
    await expect(reg.dispatch('nope', {})).rejects.toMatchObject({ code: 'unknown_command' });
    await expect(reg.dispatch('set_frame_cap', { fps: 'x' })).rejects.toMatchObject({
      code: 'invalid_arguments',
      message: 'Invalid arguments for set_frame_cap: fps: must be a number.',
    });
    await expect(reg.dispatch('set_frame_cap', { fps: 30 }, agent(['read']))).rejects.toMatchObject(
      {
        code: 'forbidden',
      },
    );
    await expect(reg.dispatch('screenshot', {}, agent(['read', 'control']))).rejects.toBeInstanceOf(
      CommandError,
    );
    const shot = (await reg.dispatch('screenshot', {}, agent(['screenshot']))) as {
      mimeType: string;
      data: string;
    };
    expect(shot).toEqual({ mimeType: 'image/png', data: 'iVBORw==' });
  });

  it('runs commands on the app, with helpful errors', async () => {
    const { reg, st, calls } = fakeStudio();
    await reg.dispatch('set_expression', { expression: 'Smile' });
    expect([...st.activeExpressions]).toEqual(['Smile']);
    await expect(reg.dispatch('set_expression', { expression: 'Frown' })).rejects.toThrow(
      'Unknown expression "Frown". describe_model lists them: Smile.',
    );
    await reg.dispatch('play_motion', { group: 'Wave', mode: 'hold' });
    await reg.dispatch('play_motion', { name: 'wave' });
    expect(calls).toEqual(['motion Wave/0 hold', 'motion Wave/0 once']);
    const r = (await reg.dispatch('set_parameters', { values: { ParamAngleX: 10, Nope: 1 } })) as {
      unknown: string[];
    };
    expect(r.unknown).toEqual(['Nope']);
    expect(st.overrides).toEqual({ ParamAngleX: 10 });
    await expect(reg.dispatch('load_model', { url: 'file:///etc/passwd' })).rejects.toMatchObject({
      code: 'invalid_arguments',
    });
    st.model = undefined as never;
    await expect(reg.dispatch('describe_model')).rejects.toMatchObject({ code: 'no_model' });
  });

  it('sets the Spout2 outputs, and says when Spout2 cannot run', async () => {
    const { reg, st } = fakeStudio();
    await expect(reg.dispatch('set_spout', { outputs: [{ enabled: true }] })).rejects.toMatchObject(
      {
        code: 'unavailable',
        message: 'Spout2 is for Windows.',
      },
    );
    st.spoutAvailable = true;
    const r = await reg.dispatch('set_spout', {
      outputs: [{ enabled: true }, { enabled: true, mirror: true, width: 1280, height: 720 }],
    });
    expect(r).toEqual({
      outputs: [
        { name: 'MochiStudio', enabled: true, mirror: false },
        { name: 'MochiStudio2', enabled: true, mirror: true, size: { width: 1280, height: 720 } },
      ],
    });
    expect(st.app.spout.outputs).toHaveLength(2);
    expect(((await reg.dispatch('get_state')) as { spout: unknown }).spout).toMatchObject({
      available: true,
      settings: { outputs: [{ enabled: true }, { mirror: true }] },
    });
    await expect(
      reg.dispatch('set_spout', { outputs: [{ enabled: true, width: 640 }] }),
    ).rejects.toMatchObject({ code: 'invalid_arguments' });
    // Undone like other settings.
    await reg.undo();
    expect(st.app.spout.outputs).toHaveLength(1);
  });

  it('sets the virtual camera, keeping what is left out, and says when it cannot run', async () => {
    const { reg, st } = fakeStudio();
    await expect(reg.dispatch('set_virtual_camera', { enabled: true })).rejects.toMatchObject({
      code: 'unavailable',
      message: 'The virtual camera is for the desktop app.',
    });
    st.spoutAvailable = true;
    expect(
      await reg.dispatch('set_virtual_camera', { enabled: true, background: '#00b140' }),
    ).toEqual({
      enabled: true,
      width: 1280,
      height: 720,
      fps: 30,
      mirror: false,
      background: { kind: 'color', color: '#00B140' },
    });
    await reg.dispatch('set_virtual_camera', { width: 1920, height: 1080, fps: 60, mirror: true });
    expect(st.app.virtualCamera).toMatchObject({
      enabled: true,
      width: 1920,
      fps: 60,
      mirror: true,
      background: { kind: 'color' },
    });
    await reg.dispatch('set_virtual_camera', { background: 'stage' });
    expect(st.app.virtualCamera.background).toEqual({ kind: 'stage' });
    expect(
      ((await reg.dispatch('get_state')) as { virtualCamera: unknown }).virtualCamera,
    ).toMatchObject({ available: true, settings: { width: 1920, height: 1080 } });
    for (const bad of [
      { width: 1280 },
      { width: 1600, height: 900 },
      { fps: 45 },
      { background: 'green' },
    ])
      await expect(reg.dispatch('set_virtual_camera', bad)).rejects.toMatchObject({
        code: 'invalid_arguments',
      });
    // Undone like other settings.
    await reg.undo();
    expect(st.app.virtualCamera.background).toMatchObject({ kind: 'color' });
  });

  it('runs a collaboration for agents, and keeps the invitation out of the state', async () => {
    const { reg, st } = fakeStudio();
    const calls: string[] = [];
    let state: any = {
      status: 'off',
      isHost: false,
      locked: false,
      reconnecting: false,
      people: [],
      knocks: [],
      wrongPasswords: 0,
      chat: [],
      order: [],
      localOrder: false,
    };
    (st as any).collab = {
      state: () => state,
      host: async () => {
        state = {
          ...state,
          status: 'hosting',
          isHost: true,
          people: [
            {
              id: 'me',
              name: 'Hana',
              host: true,
              me: true,
              connection: 'connected',
              model: 'shared',
              hidden: false,
              blocked: false,
            },
          ],
        };
        return { invitation: 'https://x/join/abc#secret', code: 'MOCHI-SECRET' };
      },
      newLink: () => ({ invitation: 'https://x/join/abc#secret2', code: 'MOCHI-SECRET2' }),
      chat: (t: string) => {
        calls.push(`chat ${t}`);
        return t.length > 0;
      },
      join: (l: string) => l.includes('/join/'),
      leave: () => calls.push('leave'),
      admit: (p: string) => calls.push(`admit ${p}`),
      decline: (p: string) => calls.push(`decline ${p}`),
      remove: (p: string) => calls.push(`remove ${p}`),
      lock: (l: boolean) => calls.push(`lock ${l}`),
      hide: (p: string, h: boolean) => calls.push(`hide ${p} ${h}`),
      block: (p: string, b: boolean) => calls.push(`block ${p} ${b}`),
      placeHere: (p: string, on: boolean, pinned?: boolean) =>
        calls.push(`place ${p} ${on} ${pinned}`),
      setLocalOrder: (o: string[] | undefined) => calls.push(`order ${o?.join(',') ?? 'shared'}`),
    };
    await expect(reg.dispatch('collab_leave', {})).rejects.toMatchObject({ code: 'no_session' });
    expect(await reg.dispatch('collab_host', {})).toEqual({
      invitation: 'https://x/join/abc#secret',
      code: 'MOCHI-SECRET',
    });
    expect(JSON.stringify(await reg.dispatch('get_state'))).not.toContain('secret');
    state.knocks = [
      { id: 'k1', name: 'Kiri', valid: true },
      { id: 'k2', name: 'Unknown', valid: false },
    ];
    await reg.dispatch('collab_answer', { peer: 'Kiri', admit: true });
    await expect(reg.dispatch('collab_answer', { peer: 'k2', admit: true })).rejects.toMatchObject({
      code: 'invalid_arguments',
    });
    await reg.dispatch('collab_answer', { peer: 'k2', admit: false });
    state.people.push({
      id: 'k1',
      name: 'Kiri',
      host: false,
      me: false,
      connection: 'connected',
      model: 'video',
      hidden: false,
      blocked: false,
    });
    await reg.dispatch('collab_hide', { peer: 'Kiri', hidden: true });
    await reg.dispatch('collab_block', { peer: 'k1', blocked: true });
    await reg.dispatch('collab_place', { peer: 'Kiri', here: true, pinned: true });
    await reg.dispatch('collab_order', { order: ['Kiri', 'me'] });
    await reg.dispatch('collab_order', {});
    await reg.dispatch('collab_lock', { locked: true });
    expect(await reg.dispatch('collab_new_link', {})).toMatchObject({ code: 'MOCHI-SECRET2' });
    await reg.dispatch('collab_chat', { text: 'hi' });
    await reg.dispatch('collab_remove', { peer: 'k1' });
    await expect(reg.dispatch('collab_remove', { peer: 'me' })).rejects.toMatchObject({
      code: 'unknown_participant',
    });
    await reg.dispatch('collab_leave', {});
    expect(calls).toEqual([
      'admit k1',
      'decline k2',
      'hide k1 true',
      'block k1 true',
      'place k1 true true',
      'order k1,me',
      'order shared',
      'lock true',
      'chat hi',
      'remove k1',
      'leave',
    ]);
    // A guest can't use the host's door.
    state = { ...state, isHost: false };
    await expect(reg.dispatch('collab_lock', { locked: false })).rejects.toMatchObject({
      code: 'not_host',
    });
    await expect(reg.dispatch('collab_join', { link: 'nope' })).rejects.toMatchObject({
      code: 'invalid_arguments',
    });
  });

  it('makes, lists, turns on and off, and removes item scenes', async () => {
    const { reg, st, calls } = fakeStudio();
    // By default from the items shown now.
    const made = (await reg.dispatch('create_item_scene', { name: 'Desk', group: 'room' })) as any;
    expect(made.scene).toEqual({
      id: 'scene1',
      name: 'Desk',
      group: 'room',
      items: ['lamp'],
      on: false,
    });
    await reg.dispatch('create_item_scene', { name: 'Bed', items: ['mug'] });
    await expect(
      reg.dispatch('create_item_scene', { name: 'X', items: ['sofa'] }),
    ).rejects.toMatchObject({ code: 'unknown_item' });
    // By id or name; without `on`, the opposite of now.
    await reg.dispatch('set_item_scene', { scene: 'desk', fade: 1.5 });
    await reg.dispatch('set_item_scene', { scene: 'scene1' });
    await reg.dispatch('set_item_scene', { scene: 'Bed', on: true });
    expect(calls).toEqual(['scene scene1 true 1.5', 'scene scene1 false 0', 'scene scene2 true 0']);
    const listed = (await reg.dispatch('list_item_scenes')) as any;
    expect(listed.scenes.map((x: any) => [x.id, x.on])).toEqual([
      ['scene1', false],
      ['scene2', true],
    ]);
    await expect(reg.dispatch('set_item_scene', { scene: 'Attic' })).rejects.toMatchObject({
      code: 'unknown_scene',
    });
    await reg.dispatch('remove_item_scene', { scene: 'Bed' });
    expect(st.settings!.itemScenes.map((x) => x.name)).toEqual(['Desk']);
    // Undo brings it back.
    await reg.undo();
    expect(st.settings!.itemScenes.map((x) => x.name)).toEqual(['Desk', 'Bed']);
  });

  it('tells agents about parameters physics overwrites', async () => {
    const { reg } = fakeStudio();
    const d = (await reg.dispatch('describe_model')) as {
      parameters: Array<Record<string, unknown>>;
    };
    expect(d.parameters[0]).toMatchObject({ id: 'ParamAngleX', drivenByPhysicsFrom: 'AngleX' });
    expect(d.parameters[1]!.drivenByPhysicsFrom).toBeUndefined();
    const r = (await reg.dispatch('set_parameters', { values: { ParamAngleX: 10 } })) as {
      drivenByPhysics: Record<string, string>;
      note: string;
    };
    expect(r.drivenByPhysics).toEqual({ ParamAngleX: 'AngleX' });
    expect(r.note).toContain('Set AngleX (for ParamAngleX) instead');
  });

  it('never exposes tracked values', async () => {
    const { reg } = fakeStudio();
    const p = (await reg.dispatch('get_parameters', {})) as {
      parameters: Array<Record<string, unknown>>;
    };
    expect(Object.keys(p.parameters[1]!).sort()).toEqual([
      'default',
      'id',
      'max',
      'min',
      'name',
      'override',
    ]);
    const state = JSON.stringify(await reg.dispatch('get_state', {}));
    expect(state).not.toMatch(/blendshape|inputs|landmark/i);
  });

  it('undoes and redoes settings, toggles and parameter values', async () => {
    const { reg, st } = fakeStudio();
    await reg.dispatch('set_lip_sync', { mode: 'add', gate: -30 });
    await reg.dispatch('set_expression', { expression: 'Smile' });
    await reg.dispatch('set_parameters', { values: { ParamAngleX: 5 } });
    expect(reg.canUndo).toBe(true);
    expect(reg.undo()).toBe('set_parameters');
    expect(st.overrides).toEqual({});
    expect(reg.undo()).toBe('set_expression');
    expect(st.activeExpressions.size).toBe(0);
    expect(reg.undo()).toBe('set_lip_sync');
    expect(st.settings!.lipSync).toMatchObject({ mode: 'max', gate: -45 });
    expect(await reg.redo()).toBe('set_lip_sync');
    expect(st.settings!.lipSync.mode).toBe('add');
    expect(reg.canRedo).toBe(true);
    // A new command clears the redo stack.
    await reg.dispatch('set_frame_cap', { fps: 30 });
    expect(reg.canRedo).toBe(false);
    await reg.dispatch('undo');
    expect(st.app.fpsCap).toBe(60);
  });

  it('logs commands (not reads) and replays them', async () => {
    const a = fakeStudio();
    await a.reg.dispatch('get_state');
    await a.reg.dispatch('set_expression', { expression: 'Smile' }, agent(['control']));
    await a.reg.dispatch('set_frame_cap', { fps: 24 });
    await a.reg.dispatch('set_frame_cap', { fps: -1 }).catch(() => undefined);
    const log = a.reg.entries();
    expect(log.map((e) => [e.name, e.ok, e.origin.kind])).toEqual([
      ['set_expression', true, 'agent'],
      ['set_frame_cap', true, 'ui'],
      ['set_frame_cap', false, 'ui'],
    ]);
    const b = fakeStudio();
    const r = await b.reg.dispatch('replay_log', { entries: JSON.parse(JSON.stringify(log)) });
    expect(r).toEqual({ replayed: 2, failed: [] });
    expect([...b.st.activeExpressions]).toEqual(['Smile']);
    expect(b.st.app.fpsCap).toBe(24);
    expect(b.reg.entries().map((e) => e.origin.kind)).toEqual(['replay', 'replay', 'ui']);
  });

  it('publishes a catalog with scopes and JSON Schemas', () => {
    const { reg } = fakeStudio();
    const cat = reg.catalog();
    const names = cat.map((c) => c.name);
    expect(names).toContain('screenshot');
    expect(new Set(names).size).toBe(names.length);
    for (const c of cat) {
      expect(c.name).toMatch(/^[a-z_]+$/);
      expect(c.inputSchema.type).toBe('object');
      expect(c.summary.length).toBeGreaterThan(10);
    }
    expect(cat.find((c) => c.name === 'screenshot')!.scope).toBe('screenshot');
    expect(cat.find((c) => c.name === 'get_state')!.readOnly).toBe(true);
  });
});

describe('the log', () => {
  it('leaves long strings out', async () => {
    const { reg } = fakeStudio();
    await reg.dispatch('speak', { audio: 'A'.repeat(5000) });
    expect(reg.entries()[0]!.args).toEqual({ audio: { omitted: 'a string of 5000 characters' } });
  });
});
