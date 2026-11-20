import { describe, expect, it } from 'vitest';
import {
  MemorySettingsStore,
  SettingsError,
  defaultSettings,
  effectiveStage,
  exportSettings,
  importSettings,
  parseAppSettings,
  parseSettings,
} from './settings';

describe('settings', () => {
  const s = defaultSettings('m.model3.json#1', ['ParamAngleX', 'ParamMouthOpenY']);

  it('round-trips through export and import, re-keyed to the target model', () => {
    s.hotkeys.push({
      id: 'h1',
      label: 'Blush',
      keys: 'Ctrl+KeyB',
      button: true,
      action: { type: 'expression', expression: 'blush' },
    });
    s.background = { kind: 'chroma', color: '#00ff00' };
    const back = importSettings(exportSettings(s), 'other#2');
    expect(back).toEqual({ ...s, modelKey: 'other#2' });
  });

  it('sanitises bad values instead of failing', () => {
    const out = parseSettings({
      version: 1,
      fpsCap: 9999,
      transform: { zoom: -5, x: 'a' },
      background: { kind: 'color', color: 'red; background:url(x)' },
      mapping: [
        { input: 'HeadYaw', output: 'ParamAngleX', smoothing: 7 },
        { nope: true },
        { input: 'VoiceA', output: 'ParamA', smoother: 'exponential' },
        { input: 'VoiceI', output: 'ParamI', smoother: 'wobbly' },
      ],
      hotkeys: [
        { keys: 'shift+KeyA', action: { type: 'motion', motion: { group: 'Idle', index: 1.7 } } },
        { action: { type: '??' } },
      ],
      lipSync: { mode: 'laser', gain: 3 },
      calibration: { HeadYaw: 2, bad: 'x' },
    });
    expect(out.fpsCap).toBe(240);
    expect(out.transform).toEqual({ x: 0, y: 0, zoom: 0.1, rotation: 0 });
    expect(out.background).toEqual({ kind: 'color', color: '#00ff00' });
    expect(out.mapping).toHaveLength(3);
    expect(out.mapping[0]!.smoothing).toBe(1);
    expect(out.mapping[0]!.smoother).toBeUndefined();
    expect(out.mapping[1]!.smoother).toBe('exponential');
    expect(out.mapping[2]!.smoother).toBeUndefined();
    expect(out.hotkeys).toEqual([
      {
        id: 'h0',
        label: '',
        keys: 'Shift+KeyA',
        button: true,
        action: { type: 'motion', motion: { group: 'Idle', index: 1 }, mode: 'once' },
      },
    ]);
    expect(out.lipSync).toEqual({
      type: 'simple',
      voiceProcessing: false,
      mode: 'max',
      weight: 0.5,
      gain: 3,
      gate: -45,
    });
    expect(out.calibration).toEqual({ HeadYaw: 2 });
  });

  it('keeps what the camera tracks, the hand preview and gesture triggers', () => {
    expect(parseAppSettings({})).toMatchObject({ trackingMode: 'face', handPreview: false });
    expect(parseAppSettings({ trackingMode: 'both', handPreview: true })).toMatchObject({
      trackingMode: 'both',
      handPreview: true,
    });
    expect(parseAppSettings({ trackingMode: 'feet', handPreview: 'yes' })).toMatchObject({
      trackingMode: 'face',
      handPreview: false,
    });
    const hotkey = (gesture: unknown) => ({
      id: 'g',
      label: '',
      keys: '',
      button: false,
      action: { type: 'calibrate' },
      gesture,
    });
    const [kept, dropped] = parseSettings({
      version: 2,
      hotkeys: [hotkey({ left: 'fist', combine: 'or', hold: 2 }), hotkey({ left: 'wave' })],
    }).hotkeys;
    expect(kept!.gesture).toEqual({ left: 'fist', combine: 'or', mirrored: false, hold: 2 });
    // A trigger that names no known gesture is dropped; the hotkey stays.
    expect(dropped).toBeDefined();
    expect(dropped!.gesture).toBeUndefined();
  });

  it('moves mappings from the first finger names to the documented ones', () => {
    const rule = (input: string) => ({ id: input, input, output: 'ParamCustom' });
    const s = parseSettings({
      version: 2,
      mapping: [rule('HandLeftFingerThumb'), rule('HandRightFingerPinky'), rule('HandLeftOpen')],
    });
    expect(s.mapping.map((r) => r.input)).toEqual([
      'HandLeftFinger_1_Thumb',
      'HandRightFinger_5_Pinky',
      'HandLeftOpen',
    ]);
  });

  it('keeps the gesture sensitivities and which face source wins', () => {
    // The webcam wins by default.
    expect(parseAppSettings({})).toMatchObject({ gestureSensitivity: {}, facePriority: 'webcam' });
    expect(
      parseAppSettings({
        gestureSensitivity: { pinch: 80, ok: 300, nope: 5 },
        facePriority: 'phone',
      }),
    ).toMatchObject({ gestureSensitivity: { pinch: 80, ok: 100 }, facePriority: 'phone' });
    expect(parseAppSettings({ facePriority: 'tablet' }).facePriority).toBe('webcam');
  });

  it('keeps the mouth-form choice only once it was made', () => {
    const ls = (v: unknown) => parseSettings({ version: 2, lipSync: { vowelForm: v } }).lipSync;
    expect(ls(true).vowelForm).toBe(true);
    expect(ls(false).vowelForm).toBe(false);
    expect('vowelForm' in ls(undefined)).toBe(false);
    expect('vowelForm' in ls('yes')).toBe(false);
  });

  it('rejects non-settings files and newer versions', () => {
    expect(() => importSettings('nope', 'k')).toThrow(SettingsError);
    expect(() => importSettings('{"format":"other","version":1}', 'k')).toThrow(
      /not a Mochi Studio/,
    );
    expect(() => parseSettings({ version: 99 })).toThrow(/newer/);
    expect(() => parseSettings([])).toThrow(SettingsError);
  });

  it('only accepts image backgrounds as data URLs', () => {
    expect(
      parseSettings({ version: 1, background: { kind: 'image', src: 'https://x/y.png' } })
        .background.kind,
    ).toBe('transparent');
    expect(
      parseSettings({
        version: 1,
        background: { kind: 'image', src: 'data:image/png;base64,AAAA' },
      }).background.kind,
    ).toBe('image');
  });

  it('stores per model', async () => {
    const store = new MemorySettingsStore();
    await store.put(s);
    expect(await store.get(s.modelKey)).toEqual(s);
    expect(await store.keys()).toEqual([s.modelKey]);
    await store.delete(s.modelKey);
    expect(await store.get(s.modelKey)).toBeUndefined();
  });
});

describe('settings version 2', () => {
  it('migrates version 1: a non-default background becomes a per-model override', () => {
    const v1 = { version: 1, background: { kind: 'chroma', color: '#00ff00' }, fpsCap: 60 };
    expect(parseSettings(v1, 'k').stageOverride).toBe(true);
    expect(parseSettings({ version: 1 }, 'k').stageOverride).toBe(false);
    expect(parseSettings({ version: 2, stageOverride: false, fpsCap: 30 }, 'k').stageOverride).toBe(
      false,
    );
  });
  it('keeps valid items and the item layout, and drops broken ones', () => {
    const s = parseSettings(
      {
        version: 2,
        items: [
          { id: 'a', label: 'Hat', visible: false, pinned: true, placement: { x: 1, y: 2 } },
          { id: 'a', label: 'duplicate' },
          { label: 'no id' },
        ],
        itemLayout: { format: 'mochi2d-item-layout/1', items: [] },
      },
      'k',
    );
    expect(s.items).toEqual([
      {
        id: 'a',
        label: 'Hat',
        visible: false,
        pinned: true,
        placement: { x: 1, y: 2, scale: 1, rotation: 0, front: true },
      },
    ]);
    expect(s.itemLayout).toEqual({ format: 'mochi2d-item-layout/1', items: [] });
    expect(parseSettings({ version: 2, itemLayout: 'x' }, 'k').itemLayout).toBeUndefined();
  });
  it('uses the app-wide stage unless the model overrides it', () => {
    const app = parseAppSettings({ background: { kind: 'color', color: '#123456' }, fpsCap: 30 });
    const m = { ...defaultSettings('k', []), background: { kind: 'transparent' as const } };
    expect(effectiveStage(app, m).fpsCap).toBe(30);
    expect(effectiveStage(app, { ...m, stageOverride: true }).background.kind).toBe('transparent');
    expect(effectiveStage(app, undefined).background.kind).toBe('color');
  });
});
