import { describe, expect, it } from 'vitest';
import { BLENDSHAPE_NAMES } from '../tracking';
import { discoverUnlisted, parseManifest } from '../modelFiles';
import { exportSettings, importSettings, parseSettings } from '../settings';
import {
  ImportError,
  comboFromTriggers,
  guessBlendshape,
  guessBlendshapePair,
  importVtubeStudio,
  keyCode,
} from './vtubeStudio';

/*
 * Synthetic settings files, written from the file format's field tables.
 * Three shapes: the base set (saved by 1.25), a middle version with hotkey
 * Twitch triggers and AutoCreated (1.32), and the newest shape with every
 * optional section (1.35.44). No real file is used.
 */

const PATHS = [
  'm.model3.json',
  'm.moc3',
  'Exp3/smile.exp3.json',
  'Exp3/angry.exp3.json',
  'Animation/wave.motion3.json',
  'Animation/idle.motion3.json',
  'dup.exp3.json',
  'Other/dup.exp3.json',
];
const manifest = discoverUnlisted(
  parseManifest(JSON.stringify({ FileReferences: { Moc: 'm.moc3' } }), 'm.model3.json'),
  PATHS,
);
const PARAMS = ['ParamAngleX', 'ParamEyeBallX', 'ParamMouthOpenY', 'ParamBreath', 'ParamMouthForm'];

const param = (o: Record<string, unknown>) => ({
  Name: '',
  Input: '',
  InputRangeLower: 0.0,
  InputRangeUpper: 1.0,
  OutputRangeLower: 0.0,
  OutputRangeUpper: 1.0,
  ClampInput: false,
  ClampOutput: false,
  UseBlinking: false,
  UseBreathing: false,
  OutputLive2D: '',
  Smoothing: 0,
  Folder: '',
  Minimized: false,
  ...o,
});

const hotkey = (o: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  HotkeyID: '0123456789abcdef0123456789abcdef',
  Name: '',
  Action: 'ToggleExpression',
  File: '',
  Folder: '',
  Position: { X: 0.0, Y: 0.0, Z: 0.0, Rotation: 0.0 },
  ColorOverlay: { On: false, IsStaticColor: false, Display: -1, BaseValue: 0, OverlayValue: 0 },
  ColorScreenMultiplyPreset: { ArtMeshMultiplyAndScreenColors: [] },
  HandGestureSettings: { GestureLeft: '', GestureRight: '', GestureCombinator: 'AND' },
  LoadModelSettings: { LoadAtCurrentPosition: true },
  Triggers: { Trigger1: '', Trigger2: '', Trigger3: '', ScreenButton: -1 },
  IsGlobal: true,
  IsActive: true,
  Minimized: false,
  StopsOnLastFrame: false,
  DeactivateAfterKeyUp: false,
  OnlyLoadOneRandomItem: false,
  DeactivateAfterSeconds: false,
  FadeSecondsAmount: 0.5,
  DeactivateAfterSecondsAmount: 10.0,
  OnScreenHotkeyColor: { r: 1.0, g: 1.0, b: 1.0, a: 1.0 },
  ...extra,
  ...o,
});

function baseFile(version: string, extra: Record<string, unknown> = {}) {
  return {
    Version: 1,
    Name: 'Test model',
    ModelID: 'ffffffffffffffffffffffffffffffff',
    FileReferences: {
      Icon: '',
      Model: 'm.model3.json',
      IdleAnimation: 'idle.motion3.json',
      IdleAnimationWhenTrackingLost: '',
    },
    ModelSaveMetadata: {
      LastSavedVTubeStudioVersion: version,
      LastSavedPlatform: 'Steam',
      LastSavedDateUTC: 'Tuesday, 08 July 2025, 04:56:38',
      LastSavedDateLocalTime: 'Tuesday, 08 July 2025, 06:56:38',
      LastSavedDateUnixMillisecondTimestamp: '1751950598000',
    },
    SavedModelPosition: {
      Position: { x: -3.2, y: -40.5, z: 0.0 },
      Rotation: { x: 0.0, y: 0.0, z: 1e-8, w: 1.0 },
      Scale: { x: 1.2, y: 1.2, z: 1.0 },
    },
    ModelPositionMovement: {
      Use: true,
      X: 6,
      Y: 8,
      Z: 11,
      SmoothingX: 10,
      SmoothingY: 10,
      SmoothingZ: 10,
    },
    ItemSettings: {
      OnlyMoveWhenPinned: false,
      AllowNormalHotkeyTriggers: true,
      Multiplier_HeadAngleX: 1.0,
      Multiplier_HeadAngleY: 1.0,
      Multiplier_HeadAngleZ: 1.0,
      Shift_HeadAngleX: 0.0,
      Shift_HeadAngleY: 0.0,
      Smoothing_HeadAngleX: 15.0,
      Smoothing_HeadAngleY: 15.0,
      Smoothing_HeadAngleZ: 15.0,
    },
    PhysicsSettings: {
      Use: true,
      UseLegacyPhysics: false,
      Live2DPhysicsFPS: 3,
      PhysicsStrength: 50,
      WindStrength: 0,
      DraggingPhysicsStrength: 0,
    },
    GeneralSettings: {
      TimeUntilTrackingLostIdleAnimation: 0.0,
      WorkshopSharingForbidden: true,
      EnableExpressionSaving: false,
    },
    ParameterSettings: [
      param({
        Name: 'Head X',
        Input: 'FaceAngleX',
        InputRangeLower: -30.0,
        InputRangeUpper: 30.0,
        OutputRangeLower: -30.0,
        OutputRangeUpper: 30.0,
        OutputLive2D: 'ParamAngleX',
        Smoothing: 15,
      }),
      param({
        Name: 'Eye X',
        Input: 'EyeRightX',
        InputRangeLower: -1.0,
        InputRangeUpper: 1.0,
        OutputRangeLower: 1.0,
        OutputRangeUpper: -1.0,
        OutputLive2D: 'ParamEyeBallX',
        ClampInput: true,
      }),
      param({ Name: 'Mouth', Input: 'MouthOpen', OutputLive2D: 'ParamMouthOpenY', Smoothing: 78 }),
      param({ Name: 'Breath', UseBreathing: true, OutputLive2D: 'ParamBreath' }),
      param({
        Name: 'Smile',
        Input: 'MouthSmile',
        OutputLive2D: 'ParamMouthForm',
        OutputRangeLower: -1.0,
      }),
      param({ Name: 'Tongue', Input: 'TongueOut', OutputLive2D: 'ParamTongue' }),
      param({ Name: 'Vowel', Input: 'VoiceA', OutputLive2D: 'ParamA' }),
      param({ Name: 'Jaw', Input: 'JawOpen', OutputLive2D: 'ParamJaw' }),
      param({ Name: 'Squint', Input: 'LEyeSquint', OutputLive2D: 'ParamSquintL' }),
      param({ Name: 'Plugin', Input: 'MyPluginValue', OutputLive2D: 'ParamPlugin' }),
      param({ Name: 'Sneer', Input: 'nosesNEER', OutputLive2D: 'ParamSneer' }),
      param({ Name: 'Empty', Input: '', OutputLive2D: 'ParamEmpty' }),
      param({ Name: 'Nowhere', Input: 'FaceAngleY', OutputLive2D: '' }),
    ],
    Hotkeys: [
      hotkey({
        Name: 'Smile',
        File: 'smile.exp3.json',
        Triggers: { Trigger1: 'LeftControl', Trigger2: 'N1', Trigger3: '', ScreenButton: -1 },
      }),
      hotkey({
        Name: '',
        Action: 'TriggerAnimation',
        File: 'wave.motion3.json',
        StopsOnLastFrame: true,
        FadeSecondsAmount: 0.2,
        Triggers: { Trigger1: 'F2', Trigger2: '', Trigger3: '', ScreenButton: 3 },
      }),
      hotkey({
        Name: 'Two keys',
        File: 'angry.exp3.json',
        Triggers: { Trigger1: 'Q', Trigger2: 'W', Trigger3: '', ScreenButton: -1 },
        DeactivateAfterKeyUp: true,
      }),
      hotkey({
        Name: 'Clear',
        Action: 'RemoveAllExpressions',
        Triggers: { Trigger1: 'Alt', Trigger2: 'Delete', Trigger3: '', ScreenButton: -1 },
      }),
      hotkey({ Name: 'Calibrate', Action: 'CalibrateCam', Triggers: { Trigger1: 'Numpad5' } }),
      hotkey({ Name: 'Overlay', Action: 'ScreenColorOverlay' }),
      hotkey({ Name: 'Off', File: 'smile.exp3.json', IsActive: false }),
      hotkey({ Name: 'Missing', File: 'nothere.exp3.json' }),
      hotkey({ Name: 'Dup', File: 'dup.exp3.json' }),
      hotkey({
        Name: 'Timed',
        File: 'angry.exp3.json',
        DeactivateAfterSeconds: true,
        DeactivateAfterSecondsAmount: 3.0,
      }),
    ],
    HotkeySettings: {
      UseKeyboardHotkeys: true,
      UseOnScreenHotkeys: false,
      SendOnScreenHotkeysToPC: true,
      OnScreenHotkeyAlpha: 75,
    },
    ArtMeshDetails: {
      ArtMeshesExcludedFromPinning: [],
      ArtMeshesThatDeleteItemsOnDrop: [],
      ArtMeshSceneLightingMultipliers: [],
      ArtMeshMultiplyAndScreenColors: [],
    },
    ParameterCustomization: { ParametersExcludedFromVNetSmoothing: [] },
    PhysicsCustomizationSettings: {
      PhysicsMultipliersPerPhysicsGroup: [],
      WindMultipliersPerPhysicsGroup: [],
      DraggingPhysicsMultipliersPerPhysicsGroup: [],
    },
    FolderInfo: { HotkeyFolders: [], ConfigItemFolders: [] },
    SavedActiveExpressions: [],
    ...extra,
  };
}

const run = (file: unknown, pinned?: string) =>
  importVtubeStudio({
    vtubeJson: JSON.stringify(file, null, 4),
    pinnedItemsJson: pinned,
    manifest,
    paths: PATHS,
    parameters: PARAMS,
    blendshapes: BLENDSHAPE_NAMES,
  });

describe('VTube Studio settings import', () => {
  it('converts the base set (1.25 shape)', () => {
    const { patch, report } = run(baseFile('1.25.0'));
    expect(report.savedBy).toBe('1.25.0');
    expect(report.unknownFields).toEqual([]);
    expect(patch.idleMotion).toBe('Animation/idle.motion3.json');
    expect(patch.physics).toBe(true);

    const rules = patch.mapping!;
    const by = (o: string) => rules.find((r) => r.output === o)!;
    expect(by('ParamAngleX')).toMatchObject({
      input: 'HeadYaw',
      inMin: -30,
      inMax: 30,
      outMin: -30,
      outMax: 30,
      clamp: false,
    });
    expect(by('ParamAngleX').smoothing).toBeCloseTo(0.15);
    // Reversed output range is kept (it inverts); ClampInput clamps.
    expect(by('ParamEyeBallX')).toMatchObject({
      input: 'GazeX',
      outMin: 1,
      outMax: -1,
      clamp: true,
    });
    expect(by('ParamMouthOpenY').smoothing).toBeCloseTo(0.78);
    // 0…1 smile becomes Mochi Studio's −1…1 mouth form.
    expect(by('ParamMouthForm')).toMatchObject({ input: 'MouthForm', inMin: -1, inMax: 1 });
    // Custom inputs matching a blendshape.
    expect(by('ParamJaw').input).toBe('bs.jawOpen');
    expect(by('ParamSquintL').input).toBe('bs.eyeSquintLeft');
    expect(by('ParamSneer').input).toBe('mean(bs.noseSneerLeft,bs.noseSneerRight)');
    // The advanced lipsync's voice inputs.
    expect(by('ParamA').input).toBe('VoiceA');
    // Breathing, unsupported, custom without a match, empty input or output: no rule.
    for (const o of ['ParamBreath', 'ParamTongue', 'ParamPlugin', 'ParamEmpty'])
      expect(rules.some((r) => r.output === o)).toBe(false);
    expect(rules).toHaveLength(8);
    // Rules on parameters the model lacks are kept and reported.
    expect(
      report.imported.some((l) => l.includes('ParamJaw') && l.includes('not in this model')),
    ).toBe(true);
    const reasons = report.skipped.map((s) => `${s.what}: ${s.reason}`).join('\n');
    expect(reasons).toContain('TongueOut');
    expect(reasons).toContain('MyPluginValue');
    expect(reasons).toContain('Saved model position');
    expect(reasons).toContain('Moving the model with the head');
    expect(report.assumed.join('\n')).toContain('Custom input JawOpen');
  });

  it('converts hotkeys: expressions, held motions, clear-all, calibrate and their keys', () => {
    const { patch, report } = run(baseFile('1.25.0'));
    const hk = patch.hotkeys!;
    expect(hk.map((h) => [h.action.type, h.keys, h.button])).toEqual([
      ['expression', 'Ctrl+Digit1', false],
      ['motion', 'F2', true],
      ['expression', 'KeyQ+KeyW', false],
      ['clearExpressions', 'Alt+Delete', false],
      ['calibrate', 'Numpad5', false],
      // A Screen Overlay hotkey: its ColorOverlay, here "off".
      ['screenOverlay', '', true],
      ['expression', '', true],
      ['expression', '', true],
    ]);
    expect(hk[5]!.action).toMatchObject({ type: 'screenOverlay', overlay: { on: false } });
    expect(hk[7]).toMatchObject({ release: 'timer', seconds: 3 });
    expect(hk[0]!.action).toEqual({ type: 'expression', expression: 'smile' });
    expect(hk[1]!.action).toEqual({
      type: 'motion',
      motion: { group: '', index: 1 },
      mode: 'hold',
    });
    // Duplicate file names: the shallowest wins, as an assumption.
    expect(hk[6]!.action).toEqual({ type: 'expression', expression: 'dup' });
    expect(report.assumed.join('\n')).toContain('Several files are named dup.exp3.json');
    const reasons = report.skipped.map((s) => `${s.what}: ${s.reason}`).join('\n');
    expect(hk[2]).toMatchObject({ release: 'hold' });
    expect(hk[0]!.release).toBeUndefined();
    expect(reasons).toContain('“Off”');
    expect(reasons).toContain('nothere.exp3.json not found');

    expect(reasons).toContain('fade times');
  });

  it('reads the 1.32 shape (Twitch triggers, AutoCreated) without unknown fields', () => {
    const file = baseFile('1.32.27', { ModelArtMeshGroups: [] });
    file.Hotkeys = file.Hotkeys.map((h) =>
      hotkey(h, {
        AutoCreated: false,
        TwitchTriggers: { Active: false, CooldownActive: false, CooldownSeconds: 30.0 },
      }),
    );
    const { report, patch } = run(file);
    // ModelArtMeshGroups sits inside ArtMeshDetails in real files; at the top it is unknown.
    expect(report.unknownFields).toEqual(['ModelArtMeshGroups']);
    expect(patch.hotkeys).toHaveLength(8);
  });

  it('reads the newest shape (1.35.44) and lists fields it does not know', () => {
    const file = baseFile('1.35.44', {
      ModelFolder: '<VTS_MODEL_BASE_PATH_PLACEHOLDER>',
      UserCustomization: {
        PreferredLanguageSetBy: '',
        PreferredLanguage: '',
        AvailableLanguages: [],
      },
      ExpressionGroups: [],
      ArtMeshDetails: {
        ArtMeshesExcludedFromPinning: [],
        ArtMeshesThatDeleteItemsOnDrop: [],
        ArtMeshSceneLightingMultipliers: [{ ID: 'ArtMesh1', Value: 0.0 }],
        ArtMeshMultiplyAndScreenColors: [],
        ModelArtMeshGroups: [],
        DynamicArtMeshEnabled: true,
        DynamicArtMeshData: [],
      },
      ParameterCustomization: { ParametersExcludedFromVNetSmoothing: [], SoundTriggers: [] },
      SomethingNew: { a: 1 },
    });
    file.ModelSaveMetadata = {
      ...file.ModelSaveMetadata,
      TotalSaveCount: 189,
    } as typeof file.ModelSaveMetadata;
    file.GeneralSettings = {
      ...file.GeneralSettings,
      ModelVolume: 90,
    } as typeof file.GeneralSettings;
    file.Hotkeys = file.Hotkeys.map((h) =>
      hotkey(h, {
        AutoCreated: false,
        TwitchTriggers: { Active: false },
        SoundConfig: {
          SoundActive: false,
          StopWhenInactive: false,
          StopFadeOutSeconds: 2.0,
          SoundSlots: [],
        },
      }),
    );
    file.ParameterSettings = file.ParameterSettings.map((p) => ({ ...p, NewParamFlag: true }));
    const { report } = run(file);
    expect(report.unknownFields).toEqual(['ParameterSettings[].NewParamFlag', 'SomethingNew']);
    // The light strengths are imported now; the rest stays unread.
    expect(report.imported).toContain(
      'Light strength for 1 art mesh(es) (Model tab, light from the screen)',
    );
  });

  it('reads items_pinned_to_model.json', () => {
    const meta = {
      FileMetadata: {},
      SceneName: '',
      SceneGroupName: '',
      SceneModel: '',
      SceneID: '',
    };
    expect(
      run(baseFile('1.35.44'), JSON.stringify({ ...meta, Items: [] })).report.imported,
    ).toContain('Pinned items: none in the file');
    const r = run(baseFile('1.35.44'), JSON.stringify({ ...meta, Items: [{}], Extra: 1 })).report;
    expect(r.skipped.some((s) => s.what === '1 pinned item(s)')).toBe(true);
    expect(r.unknownFields).toContain('items_pinned_to_model.Extra');
  });

  it('takes the physics strength and wind (the same 0–100 scales), not the group multipliers', () => {
    const file = baseFile('1.25.0') as Record<string, any>;
    file.PhysicsSettings.PhysicsStrength = 61;
    file.PhysicsSettings.WindStrength = 10;
    file.PhysicsCustomizationSettings.PhysicsMultipliersPerPhysicsGroup = [{}];
    const { patch, report } = run(file);
    expect(patch.physicsTuning).toEqual({ strength: 61, wind: 10, groups: {} });
    expect(report.imported).toContain('Physics strength 61 and wind 10');
    expect(report.skipped.map((s) => s.what)).toContain('Physics group multipliers');
    // The defaults change nothing.
    expect(run(baseFile('1.25.0')).patch.physicsTuning).toBeUndefined();
  });

  it('imports mappings from the hand inputs, and keeps hand-gesture settings as they are', () => {
    const file = baseFile('1.25.0') as Record<string, any>;
    file.ParameterSettings = [
      param({ Name: 'Found', Input: 'HandLeftFound', OutputLive2D: 'ParamAngleX' }),
      param({ Name: 'Index', Input: 'HandRightFinger_2_Index', OutputLive2D: 'ParamMouthForm' }),
    ];
    const waveGesture = {
      GestureLeft: 'Something',
      GestureRight: '',
      GestureCombinator: 'OR',
      AllowMirroredGesture: true,
      DeactivateExpWhenGestureNotDetected: false,
      SecondsUntilDetection: 0.75,
      SecondsDetected: 0.0,
      PercentDetected: 0.0,
      SomethingNew: { nested: [1, 'two'] },
    };
    file.Hotkeys = [
      hotkey({ Name: 'Wave', File: 'smile.exp3.json', HandGestureSettings: waveGesture }),
      hotkey({ Name: 'Plain', File: 'angry.exp3.json' }),
    ];
    const { patch, report } = run(file);
    expect(patch.mapping!.map((m) => m.input)).toEqual([
      'HandLeftFound',
      'HandRightFinger_2_Index',
    ]);
    const assumed = report.assumed.join('\n');
    // The documented names: no note on the names.
    expect(assumed).not.toContain('HandRightFinger_2_Index');
    expect(assumed).not.toContain('HandLeftFound:');
    // The hotkeys are kept without a gesture of Mochi Studio's own; the file's gesture
    // settings stay with them verbatim.
    expect(patch.hotkeys!.map((h) => [h.label, h.gesture])).toEqual([
      ['Wave', undefined],
      ['Plain', undefined],
    ]);
    expect(patch.hotkeys![0]!.importedGesture).toEqual(waveGesture);
    expect(patch.hotkeys![1]!.importedGesture).toEqual({
      GestureLeft: '',
      GestureRight: '',
      GestureCombinator: 'AND',
    });
    // Only the one that names a gesture is reported: kept, not used.
    const gestures = report.skipped.filter((s) => s.what.includes('hand gesture'));
    expect(gestures).toHaveLength(1);
    expect(gestures[0]!.what).toContain('Wave');
    expect(gestures[0]!.what).toContain('Something');
    expect(gestures[0]!.reason).toContain('kept with the hotkey as it is, but not used');
    // Written back unchanged: through Mochi Studio's own validation, storage and export.
    const saved = importSettings(exportSettings(parseSettings({ version: 2, ...patch }, 'k')), 'k');
    expect(saved.hotkeys[0]!.importedGesture).toEqual(waveGesture);
    expect(JSON.stringify(saved.hotkeys[0]!.importedGesture)).toBe(JSON.stringify(waveGesture));
  });

  it('keeps mappings on the other documented inputs, not as custom inputs', () => {
    const file = baseFile('1.35.44') as Record<string, any>;
    const names = [
      'ControllerStickLeftX',
      'ControllerTriggerRight',
      'ControllerLean',
      'MousePositionX',
      'MousePositionY',
      'VoiceFrequency',
      'VoiceVolumePlusMouthOpen',
      'VoiceFrequencyPlusMouthSmile',
      'MocopiAngleX',
      'MocopiLowerLegRightAngleZ',
    ];
    file.ParameterSettings = names.map((n, i) =>
      param({ Name: `M${i}`, Input: n, OutputLive2D: 'ParamAngleX', InputRangeLower: -1 }),
    );
    file.Hotkeys = [];
    const { patch, report } = run(file);
    // As they are, with the file's own ranges.
    expect(patch.mapping!.map((m) => m.input)).toEqual(names);
    expect(patch.mapping!.every((m) => m.inMin === -1 && m.inMax === 1)).toBe(true);
    const skipped = report.skipped.map((s) => `${s.what} ${s.reason}`).join('\n');
    expect(skipped).not.toContain('custom input');
    expect(skipped).not.toContain('not supported');
    // No source in Mochi Studio: kept, without a value.
    const mocopi = report.imported.find((l) => l.includes('MocopiAngleX'))!;
    expect(mocopi).toContain('no mocopi body tracking');
    expect(report.imported.find((l) => l.includes('ControllerLean'))).not.toContain('no value');
    // The approximations and the assumed name are said.
    const assumed = report.assumed.join('\n');
    expect(assumed).toContain('VoiceFrequency: an approximation');
    expect(assumed).toContain('VoiceVolumePlusMouthOpen: an approximation');
    expect(assumed).toContain('Z is assumed');
    // A name that is neither known nor a blendshape is still a plugin's custom input.
    file.ParameterSettings = [param({ Name: 'X', Input: 'ControllerWiggle', OutputLive2D: 'P' })];
    expect(run(file).report.skipped[0]!.reason).toContain('custom input from a plugin');
  });

  it('keeps Screen Overlay hotkeys and the light strength per art mesh', () => {
    const file = baseFile('1.35.44') as Record<string, any>;
    const colorOverlay = {
      On: true,
      IsStaticColor: true,
      Display: -1,
      WindowName: '',
      IncludeLeft: true,
      IncludeMid: true,
      IncludeRight: true,
      BaseValue: 15,
      OverlayValue: 40,
      Smoothing: 3,
      IncludeItems: true,
      StaticColor: { r: 0.2724, g: 0.2464, b: 0.2612, a: 1 },
    };
    file.Hotkeys = [
      hotkey({ Name: 'Dusk', Action: 'ScreenColorOverlay', ColorOverlay: colorOverlay }),
      hotkey({
        Name: 'Daylight',
        Action: 'ScreenColorOverlay',
        ColorOverlay: { ...colorOverlay, On: false },
      }),
    ];
    file.ArtMeshDetails = {
      ArtMeshSceneLightingMultipliers: [
        { ID: 'ArtMeshEyeL', Value: 0 },
        { ID: 'ArtMeshEyeR', Value: 0.3 },
      ],
    };
    const { patch, report } = run(file);
    expect(patch.hotkeys!.map((h) => h.action)).toEqual([
      {
        type: 'screenOverlay',
        overlay: expect.objectContaining({ on: true, source: 'static', raw: colorOverlay }),
      },
      { type: 'screenOverlay', overlay: expect.objectContaining({ on: false }) },
    ]);
    expect(patch.lightStrengths).toEqual({ ArtMeshEyeL: 0, ArtMeshEyeR: 0.3 });
    expect(report.imported.join('\n')).toContain('Light strength for 2 art mesh(es)');
    // Not reported as unknown art mesh settings any more.
    expect(report.skipped.map((x) => x.what).join('\n')).not.toContain('Art mesh settings');
    // Through Mochi Studio's own settings unchanged.
    const saved = parseSettings({ version: 2, ...patch }, 'k');
    expect(saved.hotkeys[0]!.action).toEqual(patch.hotkeys![0]!.action);
    expect(saved.lightStrengths).toEqual(patch.lightStrengths);
  });

  it('produces settings that pass Mochi Studio’s own validation', () => {
    const { patch } = run(baseFile('1.35.44'));
    const s = parseSettings({ version: 2, ...patch }, 'k');
    expect(s.mapping).toHaveLength(patch.mapping!.length);
    expect(s.hotkeys).toEqual(patch.hotkeys);
    expect(s.idleMotion).toBe(patch.idleMotion);
  });

  it('handles odd files safely', () => {
    expect(() => run('nope')).toThrow(ImportError);
    expect(() => run({ Foo: 1 })).toThrow(ImportError);
    expect(() =>
      importVtubeStudio({
        vtubeJson: '{',
        manifest,
        paths: PATHS,
        parameters: [],
        blendshapes: [],
      }),
    ).toThrow(ImportError);
    const { patch, report } = run({
      Version: 2,
      ParameterSettings: [null, 3, param({ Input: 'MouthOpen' })],
    });
    expect(patch.mapping).toBeUndefined();
    expect(report.assumed.join()).toContain('File version 2');
    // A BOM at the start is accepted.
    expect(
      importVtubeStudio({
        vtubeJson: '﻿' + JSON.stringify({ Hotkeys: [] }),
        manifest,
        paths: PATHS,
        parameters: [],
        blendshapes: [],
      }).report.skipped,
    ).toEqual([]);
  });
});

describe('import helpers', () => {
  it('maps key names', () => {
    expect(keyCode('N7')).toBe('Digit7');
    expect(keyCode('Numpad0')).toBe('Numpad0');
    expect(keyCode('F5')).toBe('F5');
    expect(keyCode('Z')).toBe('KeyZ');
    expect(keyCode('Left')).toBe('ArrowLeft');
    expect(keyCode('Mouse3')).toBeUndefined();
    expect(comboFromTriggers(['LeftShift', 'S', ''])).toEqual({ combo: 'Shift+KeyS' });
    expect(comboFromTriggers(['', '', ''])).toEqual({ combo: '' });
    expect(comboFromTriggers(['LeftShift'])).toMatchObject({
      combo: '',
      problem: expect.stringContaining('modifier'),
    });
  });

  it('knows every name of the API key list', () => {
    const names = [
      ...['Tab', 'CapsLock', 'Escape', 'Space', 'Left', 'Up', 'Right', 'Down'],
      ...['Print', 'Delete', 'PageUp', 'PageDown', 'NumLock', 'ScrollLock'],
      ...Array.from({ length: 10 }, (_, i) => [`N${i}`, `Numpad${i}`]).flat(),
      ...Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i)),
      ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
      ...['Multiply', 'Add', 'Subtract', 'Decimal', 'Divide'],
      ...['RightMouseButton', 'MiddleMouseButton'],
    ];
    for (const n of names) expect(keyCode(n), n).toBeDefined();
    expect(keyCode('Multiply')).toBe('NumpadMultiply');
    expect(keyCode('Print')).toBe('PrintScreen');
    // The mouse buttons are Mochi Studio's; the left one stays for clicking.
    expect(comboFromTriggers(['LeftControl', 'RightMouseButton'])).toEqual({
      combo: 'Ctrl+MouseRight',
    });
    expect(comboFromTriggers(['MiddleMouseButton'])).toEqual({ combo: 'MouseMiddle' });
    expect(comboFromTriggers(['LeftMouseButton'])).toMatchObject({
      combo: '',
      problem: expect.stringContaining('stays for clicking'),
    });
    // With a modifier, a left click is a hotkey.
    expect(comboFromTriggers(['Alt', 'LeftMouseButton'])).toEqual({ combo: 'Alt+MouseLeft' });
    // The modifiers, the Windows keys among them.
    expect(comboFromTriggers(['LeftWindows', 'D'])).toEqual({ combo: 'Meta+KeyD' });
    expect(comboFromTriggers(['RightShift', 'Alt', 'F13'])).toEqual({ combo: 'Alt+Shift+F13' });
  });
  it('guesses blendshapes from custom input names', () => {
    expect(guessBlendshape('MouthFunnel', BLENDSHAPE_NAMES)).toBe('mouthFunnel');
    expect(guessBlendshape('REyeSquint', BLENDSHAPE_NAMES)).toBe('eyeSquintRight');
    expect(guessBlendshape('mouthSmileL', BLENDSHAPE_NAMES)).toBe('mouthSmileLeft');
    expect(guessBlendshape('nosesNEER', BLENDSHAPE_NAMES)).toBeUndefined();
    expect(guessBlendshape('MouthShrug', BLENDSHAPE_NAMES)).toBeUndefined();
    expect(guessBlendshapePair('nosesNEER', BLENDSHAPE_NAMES)).toEqual([
      'noseSneerLeft',
      'noseSneerRight',
    ]);
    expect(guessBlendshapePair('MouthShrug', BLENDSHAPE_NAMES)).toEqual([
      'mouthShrugUpper',
      'mouthShrugLower',
    ]);
    expect(guessBlendshapePair('MouthPressLipOpen', BLENDSHAPE_NAMES)).toBeUndefined();
  });
});
