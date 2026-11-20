import { DEFAULT_BACKGROUND, isHexColor, type Background } from './background';
import type { Calibration } from './calibration';
import { DEFAULT_ONE_EURO, type OneEuroParams } from './filter';
import { HANDOVER_MAX_MS, HANDOVER_MS } from './idleHandover';
import type { Hotkey, HotkeyAction } from './hotkeys';
import { keepImportedGesture, normalizeCombo } from './hotkeys';
import {
  DEFAULT_LIP_SYNC,
  GATE_MAX_DB,
  GATE_MIN_DB,
  LIP_SYNC_MODES,
  type LipSyncSettings,
} from './lipSync';
import { parseItemLayout, parseItems, type ItemEntry } from './items';
import { DEFAULT_PHYSICS_TUNING, parsePhysicsTuning, type PhysicsTuning } from './physicsTuning';
import { parseOwnExpressions, type OwnExpression } from './expressionEditor';
import { MAX_SCENE_FADE_S, parseItemScenes, type ItemScene } from './itemScenes';
import { parseFrequencyWeights, parseVoiceProfiles, type StoredVoiceProfile } from './voice';
import { parseGestureTrigger, parseSensitivity, type GestureSensitivity } from './gestures';
import { defaultRules, makeRule, type MappingRule } from './mapping';
import { RENAMED_HAND_INPUTS } from './hands';
import { DEFAULT_TRANSFORM, ZOOM_MAX, ZOOM_MIN, type SceneTransform } from './scene';
import { DEFAULT_MOUSE_RANGE, parseMouseRange, type MouseRange } from './mouseInput';
import { ALL_CONTROLLERS, type ControllerChoice } from './controller';
import {
  defaultLightOverlay,
  parseLightOverlay,
  parseLightStrengths,
  parseScreenOverlay,
  type LightOverlaySettings,
} from './lightOverlay';
import { DEFAULT_SPOUT, parseSpout, type SpoutSettings } from './spout';
import {
  DEFAULT_VIRTUAL_CAMERA,
  parseVirtualCamera,
  type VirtualCameraSettings,
} from './virtualCamera';

export const SETTINGS_VERSION = 2;
export const SETTINGS_FORMAT = 'mochi-studio/model-settings';

/** Everything Mochi Studio remembers about one model. */
export interface ModelSettings {
  version: number;
  modelKey: string;
  mirror: boolean;
  filter: OneEuroParams;
  /**
   * How long a handover between tracking and the idle animation takes, in
   * milliseconds (src/core/idleHandover.ts).
   */
  handoverMs: number;
  calibration: Calibration;
  mapping: MappingRule[];
  lipSync: LipSyncSettings;
  hotkeys: Hotkey[];
  transform: SceneTransform;
  /**
   * When true, this model uses its own background and frame cap below;
   * otherwise the app-wide ones (`AppSettings`).
   */
  stageOverride: boolean;
  /**
   * How collaborators get this model: video only (the default,
   * the next round), its files (memory only on their side), or never its files.
   */
  collabSharing: 'video' | 'shared' | 'never';
  background: Background;
  /** 0 = uncapped. */
  fpsCap: number;
  items: ItemEntry[];
  /** A motion file (path in the model folder) that loops while nothing else plays. */
  idleMotion?: string;
  /** Physics on or off. */
  physics: boolean;
  /** Physics strength, wind and group multipliers (src/core/physicsTuning.ts). */
  physicsTuning: PhysicsTuning;
  /** Expressions made or changed in the expression editor (src/core/expressionEditor.ts). */
  ownExpressions: OwnExpression[];
  /** Item scenes (src/core/itemScenes.ts). */
  itemScenes: ItemScene[];
  /** The person's name for the model; without one, the file name is used. */
  displayName?: string;
  /** Mochi2D's item layout (placements and pins), kept as is. */
  itemLayout?: unknown;
  /**
   * How much the light overlay affects each art mesh, 0 to 1 (missing
   * ones are 1).
   */
  lightStrengths: Record<string, number>;
}

/** Settings that apply to every model, unless a model overrides them. */
export interface AppSettings {
  version: number;
  background: Background;
  fpsCap: number;
  /** Desktop app: hotkeys also work while another app has focus. */
  globalHotkeys: boolean;
  /** Desktop app: reopen the last model folder when the app starts. */
  reopenLastModel: boolean;
  /** Voice profiles for the advanced lipsync, one per voice (src/core/voice.ts). */
  voices: StoredVoiceProfile[];
  /** The voice in use (a profile's name); none: Mochi2D's neutral voice. */
  voice?: string;
  /** What the camera tracks: the face, the hands, or both. */
  trackingMode: 'face' | 'hands' | 'both';
  /** The Camera tab's hand preview (points only), off by default. */
  handPreview: boolean;
  /** How easily each hand gesture is recognized, 0 to 100; missing ones are 50. */
  gestureSensitivity: GestureSensitivity;
  /**
   * With a phone tracker and the webcam both seeing the face: whose face
   * wins. The webcam by default.
   */
  facePriority: 'phone' | 'webcam';
  /** The mouse inputs' X and Y ranges in pixels (src/core/mouseInput.ts). */
  mouseRange: MouseRange;
  /** Which controllers are read: `none`, `all`, or one controller's name. */
  controller: ControllerChoice;
  /** Desktop app: the screen the mouse ranges are centred on (a display id); absent: the main one. */
  mouseScreen?: number;
  /** The display light overlay's settings (src/core/lightOverlay.ts). */
  lightOverlay: LightOverlaySettings;
  /** Desktop app on Windows: Spout2 outputs (src/core/spout.ts). */
  spout: SpoutSettings;
  /** Desktop app: the virtual camera (src/core/virtualCamera.ts). Linux first. */
  virtualCamera: VirtualCameraSettings;
  /** Collaboration (docs/collaboration.md). */
  collab: CollabSettings;
}

export interface CollabSettings {
  /** The signaling server's WebSocket address; empty until one is chosen. */
  server: string;
  nickname: string;
  /** Connect through the relay only, so others never see this computer's address. */
  hideAddress: boolean;
  /** Updates a second, as host. */
  rate: number;
  /** How many people, as host (2–6). */
  size: number;
}

export const DEFAULT_COLLAB: CollabSettings = {
  server: '',
  nickname: '',
  hideAddress: true,
  rate: 30,
  size: 6,
};

function parseCollab(v: unknown): CollabSettings {
  const x = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
  const n = (k: string, d: number, lo: number, hi: number) =>
    typeof x[k] === 'number' && Number.isFinite(x[k])
      ? Math.max(lo, Math.min(hi, Math.round(x[k] as number)))
      : d;
  return {
    server:
      typeof x.server === 'string' && /^wss?:\/\//.test(x.server) ? x.server.slice(0, 500) : '',
    nickname: typeof x.nickname === 'string' ? x.nickname.trim().slice(0, 40) : '',
    hideAddress: x.hideAddress !== false,
    rate: n('rate', 30, 10, 60),
    size: n('size', 6, 2, 6),
  };
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  version: 1,
  background: { ...DEFAULT_BACKGROUND },
  fpsCap: 60,
  globalHotkeys: true,
  reopenLastModel: true,
  voices: [],
  trackingMode: 'face',
  handPreview: false,
  gestureSensitivity: {},
  facePriority: 'webcam',
  mouseRange: { ...DEFAULT_MOUSE_RANGE },
  controller: ALL_CONTROLLERS,
  lightOverlay: defaultLightOverlay(),
  spout: structuredClone(DEFAULT_SPOUT),
  virtualCamera: structuredClone(DEFAULT_VIRTUAL_CAMERA),
  collab: { ...DEFAULT_COLLAB },
};

/** The background and frame cap in effect for a model. */
export function effectiveStage(
  app: AppSettings,
  model: ModelSettings | undefined,
): { background: Background; fpsCap: number } {
  const src = model?.stageOverride ? model : app;
  return { background: src.background, fpsCap: src.fpsCap };
}

export function parseAppSettings(raw: unknown): AppSettings {
  if (!isObj(raw)) return { ...DEFAULT_APP_SETTINGS };
  return {
    version: 1,
    background: parseBackground(raw.background),
    fpsCap: Math.round(num(raw.fpsCap, 60, 0, 240)),
    globalHotkeys: raw.globalHotkeys !== false,
    reopenLastModel: raw.reopenLastModel !== false,
    ...voices(raw),
    trackingMode:
      raw.trackingMode === 'hands' || raw.trackingMode === 'both' ? raw.trackingMode : 'face',
    handPreview: raw.handPreview === true,
    gestureSensitivity: parseSensitivity(raw.gestureSensitivity),
    facePriority: raw.facePriority === 'phone' ? 'phone' : 'webcam',
    mouseRange: parseMouseRange(raw.mouseRange),
    controller:
      typeof raw.controller === 'string' && raw.controller
        ? raw.controller.slice(0, 200)
        : ALL_CONTROLLERS,
    lightOverlay: parseLightOverlay(raw.lightOverlay),
    spout: parseSpout(raw.spout),
    virtualCamera: parseVirtualCamera(raw.virtualCamera),
    collab: parseCollab(raw.collab),
    ...(typeof raw.mouseScreen === 'number' && Number.isFinite(raw.mouseScreen)
      ? { mouseScreen: raw.mouseScreen }
      : {}),
  };
}

function voices(raw: Obj): Pick<AppSettings, 'voices' | 'voice'> {
  const list = parseVoiceProfiles(raw.voices);
  const voice =
    typeof raw.voice === 'string' && list.some((v) => v.name === raw.voice) ? raw.voice : undefined;
  return { voices: list, ...(voice ? { voice } : {}) };
}

export function defaultSettings(modelKey: string, modelParams: Iterable<string>): ModelSettings {
  return {
    version: SETTINGS_VERSION,
    modelKey,
    mirror: true,
    filter: { ...DEFAULT_ONE_EURO },
    handoverMs: HANDOVER_MS,
    calibration: {},
    mapping: defaultRules(modelParams),
    lipSync: { ...DEFAULT_LIP_SYNC },
    hotkeys: [],
    transform: { ...DEFAULT_TRANSFORM },
    stageOverride: false,
    collabSharing: 'video',
    background: { ...DEFAULT_BACKGROUND },
    fpsCap: 60,
    items: [],
    physics: true,
    physicsTuning: { ...DEFAULT_PHYSICS_TUNING, groups: {} },
    ownExpressions: [],
    itemScenes: [],
    lightStrengths: {},
  };
}

export class SettingsError extends Error {}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown, d: number, lo = -Infinity, hi = Infinity): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);
const str = (v: unknown, d: string, max = 500): string =>
  typeof v === 'string' ? v.slice(0, max) : d;

function parseAction(v: unknown): HotkeyAction | undefined {
  if (!isObj(v)) return undefined;
  if (v.type === 'expression' && typeof v.expression === 'string')
    return { type: 'expression', expression: v.expression };
  if (v.type === 'item' && typeof v.item === 'string') return { type: 'item', item: v.item };
  if (v.type === 'clearExpressions' || v.type === 'calibrate') return { type: v.type };
  if (v.type === 'screenOverlay')
    return { type: 'screenOverlay', overlay: parseScreenOverlay(v.overlay) };
  if (v.type === 'itemScene' && typeof v.scene === 'string')
    return { type: 'itemScene', scene: v.scene, fade: num(v.fade, 0, 0, MAX_SCENE_FADE_S) };
  if (v.type === 'motion' && isObj(v.motion) && typeof v.motion.group === 'string') {
    return {
      type: 'motion',
      motion: { group: v.motion.group, index: Math.trunc(num(v.motion.index, 0, 0)) },
      mode: v.mode === 'hold' ? 'hold' : 'once',
    };
  }
  return undefined;
}

function parseBackground(v: unknown): Background {
  if (!isObj(v)) return { ...DEFAULT_BACKGROUND };
  switch (v.kind) {
    case 'chroma':
    case 'color':
      return { kind: v.kind, color: isHexColor(v.color) ? v.color : '#00ff00' };
    case 'image':
      if (typeof v.src === 'string' && /^data:image\/(png|jpeg|webp|gif);base64,/.test(v.src))
        return { kind: 'image', src: v.src, fit: v.fit === 'contain' ? 'contain' : 'cover' };
      return { ...DEFAULT_BACKGROUND };
    default:
      return { kind: 'transparent' };
  }
}

/**
 * Validates untrusted settings (from storage or an imported file). Unknown
 * fields are dropped and invalid values fall back to defaults; only a
 * structurally wrong document is rejected.
 */
export function parseSettings(raw: unknown, modelKey?: string): ModelSettings {
  if (!isObj(raw)) throw new SettingsError('Settings must be a JSON object.');
  const v = typeof raw.version === 'number' ? raw.version : NaN;
  if (!(v >= 1)) throw new SettingsError('Missing or invalid settings version.');
  if (v > SETTINGS_VERSION)
    throw new SettingsError(
      `Settings version ${v} is newer than this app supports (${SETTINGS_VERSION}).`,
    );
  const base = defaultSettings(modelKey ?? str(raw.modelKey, 'unknown'), []);

  const f = isObj(raw.filter) ? raw.filter : {};
  const cal: Calibration = {};
  if (isObj(raw.calibration))
    for (const [k, x] of Object.entries(raw.calibration))
      if (typeof x === 'number' && Number.isFinite(x)) cal[k.slice(0, 100)] = x;

  const mapping: MappingRule[] = [];
  if (Array.isArray(raw.mapping)) {
    for (const r of raw.mapping) {
      if (!isObj(r) || typeof r.input !== 'string' || typeof r.output !== 'string') continue;
      mapping.push(
        makeRule({
          id: str(r.id, '', 50) || undefined,
          // The first finger names move to the documented ones.
          input: RENAMED_HAND_INPUTS[r.input] ?? r.input.slice(0, 100),
          output: r.output.slice(0, 100),
          enabled: bool(r.enabled, true),
          inMin: num(r.inMin, 0),
          inMax: num(r.inMax, 1),
          outMin: num(r.outMin, 0),
          outMax: num(r.outMax, 1),
          invert: bool(r.invert, false),
          clamp: bool(r.clamp, true),
          smoothing: num(r.smoothing, 0, 0, 1),
          followPhysics: r.followPhysics !== false,
          ...(r.smoother === 'rate' || r.smoother === 'exponential'
            ? { smoother: r.smoother }
            : {}),
        }),
      );
    }
  } else {
    mapping.push(...base.mapping);
  }

  const ls = isObj(raw.lipSync) ? raw.lipSync : {};
  const mode = LIP_SYNC_MODES.find((m) => m === ls.mode) ?? DEFAULT_LIP_SYNC.mode;

  const hotkeys: Hotkey[] = [];
  if (Array.isArray(raw.hotkeys)) {
    for (const h of raw.hotkeys) {
      if (!isObj(h)) continue;
      const action = parseAction(h.action);
      if (!action) continue;
      const keys = typeof h.keys === 'string' && h.keys ? (normalizeCombo(h.keys) ?? '') : '';
      const release =
        (action.type === 'expression' || action.type === 'item' || action.type === 'itemScene') &&
        (h.release === 'hold' || h.release === 'timer')
          ? h.release
          : undefined;
      const gesture = parseGestureTrigger(h.gesture);
      const importedGesture = keepImportedGesture(h.importedGesture);
      hotkeys.push({
        id: str(h.id, `h${hotkeys.length}`, 50),
        label: str(h.label, '', 100),
        keys,
        button: bool(h.button, true),
        ...(gesture ? { gesture } : {}),
        ...(importedGesture ? { importedGesture } : {}),
        action,
        ...(release ? { release } : {}),
        ...(release === 'timer' ? { seconds: num(h.seconds, 5, 0.1, 3600) } : {}),
      });
    }
  }

  const t = isObj(raw.transform) ? raw.transform : {};
  const background = parseBackground(raw.background);
  const fpsCap = Math.round(num(raw.fpsCap, 60, 0, 240));
  // Version 1 kept background and frame cap per model. Keep a model's own
  // choice when it differs from the defaults; otherwise use the app-wide one.
  const stageOverride =
    typeof raw.stageOverride === 'boolean'
      ? raw.stageOverride
      : v < 2 && (background.kind !== 'transparent' || fpsCap !== 60);
  const itemLayout = parseItemLayout(raw.itemLayout);
  return {
    version: SETTINGS_VERSION,
    modelKey: base.modelKey,
    mirror: bool(raw.mirror, true),
    filter: {
      minCutoff: num(f.minCutoff, DEFAULT_ONE_EURO.minCutoff, 0.001, 100),
      beta: num(f.beta, DEFAULT_ONE_EURO.beta, 0, 100),
      dCutoff: num(f.dCutoff, DEFAULT_ONE_EURO.dCutoff, 0.001, 100),
    },
    handoverMs: num(raw.handoverMs, HANDOVER_MS, 0, HANDOVER_MAX_MS),
    calibration: cal,
    mapping,
    lipSync: {
      type: ls.type === 'advanced' ? 'advanced' : 'simple',
      ...(typeof ls.motionSync === 'string' && ls.motionSync
        ? { motionSync: ls.motionSync.slice(0, 100) }
        : {}),
      voiceProcessing: bool(ls.voiceProcessing, DEFAULT_LIP_SYNC.voiceProcessing),
      ...(typeof ls.vowelForm === 'boolean' ? { vowelForm: ls.vowelForm } : {}),
      ...(isObj(ls.frequencyWeights)
        ? { frequencyWeights: parseFrequencyWeights(ls.frequencyWeights) }
        : {}),
      mode,
      weight: num(ls.weight, DEFAULT_LIP_SYNC.weight, 0, 1),
      gain: num(ls.gain, DEFAULT_LIP_SYNC.gain, 0, 10),
      gate: num(ls.gate, DEFAULT_LIP_SYNC.gate, GATE_MIN_DB, GATE_MAX_DB),
    },
    hotkeys,
    transform: {
      x: num(t.x, 0, -10, 10),
      y: num(t.y, 0, -10, 10),
      zoom: num(t.zoom, 1, ZOOM_MIN, ZOOM_MAX),
      rotation: num(t.rotation, 0, -180, 180),
    },
    stageOverride,
    collabSharing:
      raw.collabSharing === 'shared' || raw.collabSharing === 'never' ? raw.collabSharing : 'video',
    background,
    fpsCap,
    items: parseItems(raw.items),
    physics: bool(raw.physics, true),
    physicsTuning: parsePhysicsTuning(raw.physicsTuning),
    ownExpressions: parseOwnExpressions(raw.ownExpressions),
    itemScenes: parseItemScenes(raw.itemScenes),
    lightStrengths: parseLightStrengths(raw.lightStrengths),
    ...(typeof raw.displayName === 'string' && raw.displayName.trim()
      ? { displayName: raw.displayName.trim().slice(0, 64) }
      : {}),
    ...(typeof raw.idleMotion === 'string' && raw.idleMotion
      ? { idleMotion: raw.idleMotion.slice(0, 500) }
      : {}),
    ...(itemLayout === undefined ? {} : { itemLayout }),
  };
}

/** The JSON file written by "Export settings". */
export function exportSettings(s: ModelSettings): string {
  return JSON.stringify({ format: SETTINGS_FORMAT, ...s }, null, 2);
}

/** Reads an exported file. The settings are re-keyed to the current model. */
export function importSettings(json: string, modelKey: string): ModelSettings {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new SettingsError('The file is not valid JSON.');
  }
  if (isObj(raw) && raw.format !== undefined && raw.format !== SETTINGS_FORMAT)
    throw new SettingsError('This is not a Mochi Studio settings file.');
  return parseSettings(raw, modelKey);
}

/** Persistent per-model settings. IndexedDB in the browser; a Map in tests. */
export interface SettingsStore {
  get(modelKey: string): Promise<ModelSettings | undefined>;
  put(s: ModelSettings): Promise<void>;
  delete(modelKey: string): Promise<void>;
  keys(): Promise<string[]>;
  getApp(): Promise<AppSettings>;
  putApp(s: AppSettings): Promise<void>;
}

export class MemorySettingsStore implements SettingsStore {
  private map = new Map<string, string>();
  async get(k: string): Promise<ModelSettings | undefined> {
    const s = this.map.get(k);
    return s === undefined ? undefined : parseSettings(JSON.parse(s), k);
  }
  async put(s: ModelSettings): Promise<void> {
    this.map.set(s.modelKey, JSON.stringify(s));
  }
  async delete(k: string): Promise<void> {
    this.map.delete(k);
  }
  async keys(): Promise<string[]> {
    return [...this.map.keys()];
  }
  private app: string | undefined;
  async getApp(): Promise<AppSettings> {
    return parseAppSettings(this.app === undefined ? undefined : JSON.parse(this.app));
  }
  async putApp(s: AppSettings): Promise<void> {
    this.app = JSON.stringify(s);
  }
}
