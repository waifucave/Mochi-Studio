import { describe, expect, it } from 'vitest';
import {
  easeTransform,
  expressionNameFromFile,
  fromProtocolPosition,
  hotkeyType,
  isModelId,
  matchArtMeshes,
  modelIdFor,
  moveTarget,
  sizeToZoom,
  tagsFromUserData,
  tintColor,
  toProtocolPosition,
  zoomToSize,
} from './helpers';
import { InjectionState, KEEP_ALIVE_MS, type ResolvedParameter } from './injection';
import { DEFAULT_PARAMETERS, defaultParameter } from './inputs';
import { envelope, errorEnvelope, validCustomName, validRequestId } from './protocol';

const caller = (id: string, session = `${id}-s`) => ({
  id,
  name: id,
  trackingData: false,
  permissions: [] as string[],
  session,
});
const glow: ResolvedParameter = { input: 'plugin.Glow', scale: 1, offset: 0, rest: 0 };
const resolve = (n: string) => (n === 'Glow' ? glow : undefined);

describe('the plugin protocol', () => {
  it('builds envelopes', () => {
    expect(envelope('FaceFoundResponse', 'r1', { found: true }, 5)).toEqual({
      apiName: 'VTubeStudioPublicAPI',
      apiVersion: '1.0',
      timestamp: 5,
      requestID: 'r1',
      messageType: 'FaceFoundResponse',
      data: { found: true },
    });
    expect(errorEnvelope('r2', 7, 'no').data).toEqual({ errorID: 7, message: 'no' });
  });

  it('checks request IDs and custom names', () => {
    expect(validRequestId('a')).toBe(true);
    expect(validRequestId('x'.repeat(64))).toBe(true);
    expect(validRequestId('x'.repeat(65))).toBe(false);
    expect(validRequestId('')).toBe(false);
    expect(validRequestId('é')).toBe(false);
    expect(validCustomName('Glow')).toBe(true);
    expect(validCustomName('Gl0w2')).toBe(true);
    expect(validCustomName('abc')).toBe(false);
    expect(validCustomName('has_underscore')).toBe(false);
  });

  it('maps the default inputs to Mochi Studio’s, with their units', () => {
    const yaw = defaultParameter('faceanglex')!;
    expect(yaw).toMatchObject({
      name: 'FaceAngleX',
      input: 'HeadYaw',
      min: -30,
      max: 30,
      defaultValue: 0,
      tracked: true,
    });
    // 0…1 with 0.5 at rest, Mochi Studio's −1…1.
    const smile = defaultParameter('MouthSmile')!;
    expect(smile).toMatchObject({
      input: 'MouthForm',
      scale: 2,
      offset: -1,
      min: 0,
      max: 1,
      defaultValue: 0.5,
    });
    expect(defaultParameter('EyeOpenLeft')!.defaultValue).toBe(1);
    // Names Mochi Studio has no tracker for become plugin inputs.
    expect(defaultParameter('TongueOut')).toMatchObject({
      input: 'plugin.TongueOut',
      tracked: false,
    });
    // The advanced lipsync's voice inputs are tracked, and the combined ones.
    expect(defaultParameter('VoiceA')).toMatchObject({
      input: 'VoiceA',
      tracked: true,
      min: 0,
      max: 1,
    });
    expect(defaultParameter('VoiceSilence')).toMatchObject({
      input: 'VoiceSilence',
      defaultValue: 1,
    });
    expect(defaultParameter('VoiceFrequency')).toMatchObject({
      input: 'VoiceFrequency',
      tracked: true,
      min: 0,
      max: 1,
      defaultValue: 0.5,
    });
    expect(defaultParameter('VoiceVolumePlusMouthOpen')).toMatchObject({
      input: 'VoiceVolumePlusMouthOpen',
      defaultValue: 0,
    });
    // The mouse: −1 to 1.
    expect(defaultParameter('MousePositionY')).toMatchObject({
      input: 'MousePositionY',
      tracked: true,
      min: -1,
      max: 1,
      defaultValue: 0,
    });
    // The 33 of the protocol, and the 26 hand inputs.
    expect(DEFAULT_PARAMETERS.length).toBe(59);
    expect(defaultParameter('HandLeftFinger_2_Index')).toMatchObject({
      input: 'HandLeftFinger_2_Index',
      tracked: true,
      min: 0,
      max: 1,
    });
    expect(defaultParameter('HandRightAngleZ')).toMatchObject({ min: -180, max: 180 });
  });
});

describe('injected values', () => {
  it('sets and blends by weight, and keeps them alive for a second', () => {
    const s = new InjectionState();
    expect(
      s.inject(caller('a'), { parameterValues: [{ id: 'Glow', value: 0.8 }] }, resolve, 0),
    ).toEqual({ data: {} });
    expect(s.apply({}, 10).inputs['plugin.Glow']).toBeCloseTo(0.8);
    s.inject(
      caller('a'),
      { parameterValues: [{ id: 'Glow', value: 1, weight: 0.25 }] },
      resolve,
      20,
    );
    expect(s.apply({ 'plugin.Glow': 0.2 }, 30).inputs['plugin.Glow']).toBeCloseTo(
      0.25 + 0.75 * 0.2,
    );
    expect(s.active(20 + KEEP_ALIVE_MS)).toBe(true);
    expect(s.active(21 + KEEP_ALIVE_MS)).toBe(false);
  });

  it('lets one plugin set a parameter at a time, and any number add', () => {
    const s = new InjectionState();
    s.inject(caller('a'), { parameterValues: [{ id: 'Glow', value: 0.5 }] }, resolve, 0);
    expect(
      s.inject(caller('b'), { parameterValues: [{ id: 'Glow', value: 0.1 }] }, resolve, 0),
    ).toMatchObject({ errorID: 454 });
    s.inject(
      caller('b'),
      { mode: 'add', parameterValues: [{ id: 'Glow', value: 0.25, weight: 0 }] },
      resolve,
      0,
    );
    s.inject(
      caller('c'),
      { mode: 'add', parameterValues: [{ id: 'Glow', value: 0.1 }] },
      resolve,
      0,
    );
    expect(s.apply({}, 1).inputs['plugin.Glow']).toBeCloseTo(0.85);
    // Each plugin's latest add counts (not a running sum).
    s.inject(
      caller('c'),
      { mode: 'add', parameterValues: [{ id: 'Glow', value: 0.2 }] },
      resolve,
      2,
    );
    expect(s.apply({}, 3).inputs['plugin.Glow']).toBeCloseTo(0.95);
    // A session's values end with it, and release the lock.
    s.endSession('a-s');
    expect(
      s.inject(caller('b'), { parameterValues: [{ id: 'Glow', value: 0.1 }] }, resolve, 4),
    ).toEqual({ data: {} });
    s.endPlugin('b');
    expect(s.apply({}, 5).inputs['plugin.Glow']).toBeCloseTo(0.2);
  });

  it('converts default parameters to Mochi Studio units, and reports its own value back', () => {
    const s = new InjectionState();
    const smile: ResolvedParameter = { input: 'MouthForm', scale: 2, offset: -1, rest: 0 };
    s.inject(caller('a'), { parameterValues: [{ id: 'MouthSmile', value: 0.75 }] }, () => smile, 0);
    expect(s.apply({ MouthForm: -1 }, 1).inputs.MouthForm).toBeCloseTo(0.5);
    expect(s.ownValue('a', 'MouthForm', 1)).toBe(0.75);
    expect(s.ownValue('b', 'MouthForm', 1)).toBeUndefined();
  });

  it('answers bad data with the documented errors, changing nothing', () => {
    const s = new InjectionState();
    const err = (d: Record<string, unknown>) =>
      (s.inject(caller('a'), d, resolve, 0) as { errorID: number }).errorID;
    expect(err({})).toBe(450);
    expect(err({ mode: 'blend', parameterValues: [{ id: 'Glow', value: 1 }] })).toBe(455);
    expect(err({ parameterValues: [{ id: 'Nope', value: 1 }] })).toBe(453);
    expect(err({ parameterValues: [{ id: 'Glow', value: Infinity }] })).toBe(451);
    expect(err({ parameterValues: [{ id: 'Glow', value: 1, weight: -0.1 }] })).toBe(452);
    // All or nothing: a bad entry after a good one leaves nothing set.
    expect(
      err({
        parameterValues: [
          { id: 'Glow', value: 1 },
          { id: 'Nope', value: 1 },
        ],
      }),
    ).toBe(453);
    expect(s.active(0)).toBe(false);
  });

  it('counts the face as found for a second when a plugin says so', () => {
    const s = new InjectionState();
    s.inject(
      caller('a'),
      { faceFound: true, parameterValues: [{ id: 'Glow', value: 1 }] },
      resolve,
      100,
    );
    expect(s.faceFound(500)).toBe(true);
    expect(s.faceFound(100 + KEEP_ALIVE_MS)).toBe(false);
  });
});

describe('model placement in the protocol’s terms', () => {
  it('converts both ways', () => {
    const t = { x: 0.2, y: -0.1, zoom: 10 ** 0.5, rotation: -30 };
    const p = toProtocolPosition(t, 1600, 800);
    expect(p).toEqual({ positionX: 0.2, positionY: 0.2, rotation: 330, size: 50 });
    const back = fromProtocolPosition(p, 1600, 800);
    expect(back.x).toBeCloseTo(0.2);
    expect(back.y).toBeCloseTo(-0.1);
    expect(back.zoom).toBeCloseTo(t.zoom);
    expect(zoomToSize(1)).toBe(0);
    expect(sizeToZoom(-100)).toBeCloseTo(0.1);
    expect(sizeToZoom(100)).toBeCloseTo(10);
  });

  it('works out move targets, absolute or relative, and their errors', () => {
    const cur = { positionX: 0.1, positionY: 0, rotation: 10, size: 0 };
    expect(
      moveTarget({ timeInSeconds: 1, valuesAreRelativeToModel: false, positionX: 0.5 }, cur),
    ).toEqual({
      target: { ...cur, positionX: 0.5 },
      seconds: 1,
    });
    expect(
      moveTarget({ timeInSeconds: 0, valuesAreRelativeToModel: true, rotation: 20, size: 5 }, cur),
    ).toEqual({
      target: { ...cur, rotation: 30, size: 5 },
      seconds: 0,
    });
    expect(moveTarget({ valuesAreRelativeToModel: true }, cur)).toMatchObject({ errorID: 301 });
    expect(moveTarget({ timeInSeconds: 2.5, valuesAreRelativeToModel: true }, cur)).toMatchObject({
      errorID: 302,
    });
    expect(
      moveTarget({ timeInSeconds: 0, valuesAreRelativeToModel: true, rotation: 400 }, cur),
    ).toMatchObject({ errorID: 302 });
  });

  it('eases between placements', () => {
    const a = { x: 0, y: 0, zoom: 1, rotation: 0 };
    const b = { x: 1, y: 1, zoom: 4, rotation: 90 };
    expect(easeTransform(a, b, 0)).toEqual(a);
    expect(easeTransform(a, b, 1)).toEqual(b);
    const mid = easeTransform(a, b, 0.5);
    expect(mid.x).toBeCloseTo(0.5);
    expect(mid.zoom).toBeCloseTo(2);
  });
});

describe('ids, hotkeys, expressions and tints', () => {
  it('makes stable 32-hex model IDs', () => {
    expect(modelIdFor('key:a')).toMatch(/^[0-9a-f]{32}$/);
    expect(modelIdFor('key:a')).toBe(modelIdFor('key:a'));
    expect(modelIdFor('key:a')).not.toBe(modelIdFor('key:b'));
    expect(isModelId('F'.repeat(32))).toBe(true);
    expect(isModelId('abc')).toBe(false);
  });

  it('names hotkey types', () => {
    const hk = (action: any) => ({ id: 'h', label: '', keys: '', button: false, action });
    expect(hotkeyType(hk({ type: 'expression', expression: 'Smile' })).type).toBe(
      'ToggleExpression',
    );
    expect(
      hotkeyType(hk({ type: 'motion', motion: { group: 'A', index: 0 }, mode: 'once' })).type,
    ).toBe('TriggerAnimation');
    expect(hotkeyType(hk({ type: 'clearExpressions' })).type).toBe('RemoveAllExpressions');
    expect(hotkeyType(hk({ type: 'calibrate' })).type).toBe('CalibrateCam');
    expect(hotkeyType(hk({ type: 'item', item: 'x' })).type).toBe('Unset');
    expect(expressionNameFromFile('exp/Smile.exp3.json')).toBe('Smile');
  });

  it('matches art meshes by any criterion, ignoring case', () => {
    const meshes = [
      { id: 'HairFront', tags: ['hair', 'front'] },
      { id: 'Face', tags: ['skin'] },
      { id: 'HairBack', tags: ['hair'] },
    ];
    expect(matchArtMeshes(meshes, { tintAll: true })).toEqual([0, 1, 2]);
    expect(matchArtMeshes(meshes, { nameContains: ['HAIR'] })).toEqual([0, 2]);
    expect(matchArtMeshes(meshes, { nameExact: ['face'] })).toEqual([1]);
    expect(matchArtMeshes(meshes, { tagExact: ['front'], artMeshNumber: [1] })).toEqual([0, 1]);
    expect(matchArtMeshes(meshes, { tagContains: ['ski'] })).toEqual([1]);
    expect(matchArtMeshes(meshes, {})).toEqual([]);
    expect(tagsFromUserData([{ id: 'A', value: 'one two\nthree' }]).get('A')).toEqual([
      'one',
      'two',
      'three',
    ]);
  });

  it('checks tint colors', () => {
    const m = { artMeshMatcher: { tintAll: true } };
    expect(tintColor({ ...m, colorTint: { colorR: 1, colorG: 2, colorB: 3, colorA: 4 } })).toEqual({
      tint: { r: 1, g: 2, b: 3, a: 4 },
    });
    expect(tintColor({ colorTint: { colorR: 1, colorG: 2, colorB: 3, colorA: 4 } })).toMatchObject({
      errorID: 251,
    });
    expect(
      tintColor({ ...m, colorTint: { colorR: -1, colorG: 2, colorB: 3, colorA: 4 } }),
    ).toMatchObject({ errorID: 252 });
  });
});

describe('ExpressionActivationRequest’s fadeTime', () => {
  it('is 0 to 2 seconds, 0.25 by default', async () => {
    const { expressionFadeTime } = await import('./protocol');
    expect(expressionFadeTime(undefined)).toBe(0.25);
    expect(expressionFadeTime(1.5)).toBe(1.5);
    expect(expressionFadeTime(9)).toBe(2);
    expect(expressionFadeTime(-1)).toBe(0);
    expect(expressionFadeTime('1')).toBe(0.25);
  });
});
