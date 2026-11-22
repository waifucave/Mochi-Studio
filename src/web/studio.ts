import { CalibrationRecorder } from '../core/calibration';
import { Emitter } from '../core/events';
import { FrameLimiter } from '../core/frameCap';
import { HotkeyController, type Hotkey, type MotionRef } from '../core/hotkeys';
import { newItemId, type ItemEntry, type ItemPlacement } from '../core/items';
import { mixMouth } from '../core/lipSync';
import type { InputInjector } from '../core/pipeline';
import { defaultRules } from '../core/mapping';
import type { LoadedModelFiles } from '../core/modelFiles';
import { MemoryFileSet, openModel, type ModelFileSet } from '../core/modelFiles';
import { MOUTH_PARAM, TrackingPipeline } from '../core/pipeline';
import type { TrackingRecording } from '../core/recording';
import type { AvatarRuntime, RuntimeModelInfo } from '../core/runtime';
import {
  DEFAULT_APP_SETTINGS,
  defaultSettings,
  effectiveStage,
  type AppSettings,
  type ModelSettings,
  type SettingsStore,
} from '../core/settings';
import type { Background } from '../core/background';
import type { CollabApi } from '../core/collab/api';
import { ParamDiffer, type SyncMessage, type SyncTransport } from '../core/sync';
import type { InputValues, TrackingFrame } from '../core/tracking';
import { canvasPng, pngContext } from './canvasPng';
import { FaceTracker, type TrackingMode } from './faceTracker';
import {
  readPhysicsDrivers,
  redirectToDrivers,
  trackingRedirects,
  type PhysicsDrivers,
} from '../core/physicsDrivers';
import { buildSettingsBundle, readSettingsExport } from '../core/settingsBundle';
import { exportSettings } from '../core/settings';
import { importVtubeStudio, type ImportResult } from '../core/importers/vtubeStudio';
import { BLENDSHAPE_NAMES } from '../core/tracking';
import { ControllerReader, type ControllerChoice, type PadLike } from '../core/controller';
import { parseMouseRange, type MouseRange } from '../core/mouseInput';
import { PointerInput } from './pointerInput';
import { bgraToRgba, parseWebItem, type WebItemSource } from '../core/webItems';
import { imageItemFiles } from '../core/imageItem';
import { errorText, guard } from '../core/appLog';
import {
  parseSpout,
  spoutConfig,
  type SpoutOutputState,
  type SpoutSettings,
  type SpoutState,
} from '../core/spout';
import {
  parseVirtualCamera,
  virtualCameraConfig,
  type VirtualCameraSettings,
  type VirtualCameraState,
} from '../core/virtualCamera';
import { desktopApi } from './desktopFiles';
import { LightCapture } from './lightCapture';
import {
  LightSmoother,
  type LightSource,
  type Rgb,
  type ScreenOverlayAction,
  activeAverage,
  overlayColor,
  overlayTint,
  parseLightOverlay,
  type LightOverlaySettings,
  type OverlayState,
} from '../core/lightOverlay';
import type { DesktopScreen } from './desktopFiles';
import { MemoryItemFileStore, type ItemFileStore } from './idbStore';
import { DiskFileSet } from './desktopFiles';
import { CommandRegistry, UI_ORIGIN, type Origin } from '../core/commands/registry';
import { studioCommands, type Snapshot, type StudioApi } from '../core/commands/studioCommands';
import { fileSetFromUrl } from '../core/modelFiles';
import type { ActiveAnimations } from '../core/paramSources';
import { IdleHandover } from '../core/idleHandover';
import { animatedMarkerOf } from '../core/animatedItem';
import { ItemAnimator, type ItemAnimationState } from '../core/itemAnimation';
import { handReadings, type HandReading, type HandSide, type TrackedHand } from '../core/hands';
import {
  GestureWatcher,
  handGestures,
  type Gesture,
  type HandGestures,
  type TwoHandPose,
} from '../core/gestures';
import {
  lacksVowelParameters,
  MOUTH_FORM_PARAM,
  mergeProfiles,
  openness,
  shapeMouthForm,
  vowelMouthForm,
  silentInputs,
  voiceInputs,
  vowelMapping,
  type StoredVoiceProfile,
  type VoiceElement,
  type VoiceReading,
} from '../core/voice';
import { VoiceCalibration } from 'mochi2d/headless';
import { usableProfile, VoiceAnalysis } from './voiceAnalysis';
import {
  MAX_SCENE_FADE_S,
  newSceneId,
  toggleScene,
  type ItemScene,
  type ItemSceneItem,
} from '../core/itemScenes';
import {
  draftFromFile,
  expressionFileText,
  expressionsWithoutHotkey,
  hotkeysForExpressions,
  newExpressionFile,
  type ExpressionDraft,
  type OwnExpression,
} from '../core/expressionEditor';
import {
  effectivePhysics,
  PhysicsOverrides,
  physicsValues,
  type EffectivePhysics,
  type OverridingPlugin,
  type OverrideRefusal,
} from '../core/physicsTuning';
import type { ParameterInfo } from '../core/runtime';
import { FrameClock } from './frameClock';

export type StudioEvents = {
  modelLoaded: { key: string; label: string };
  /** The opened model's files, before it is loaded (bridge views upload them). */
  modelFiles: {
    key: string;
    files: Array<[string, Uint8Array]>;
    /** The model is a folder on disk the desktop app opened: views read it from there. */
    disk?: { folderId: string; prefix: string };
  };
  modelUnloaded: undefined;
  settingsChanged: ModelSettings;
  appSettingsChanged: AppSettings;
  itemsChanged: { items: ItemEntry[] };
  cameraChanged: { on: boolean };
  microphoneChanged: { on: boolean };
  trackingFound: undefined;
  trackingLost: undefined;
  hotkeyFired: { hotkey: Hotkey };
  hotkeyReleased: { hotkey: Hotkey };
  expressionsChanged: { expressions: string[] };
  motionFinished: { motion: MotionRef };
  calibration: { state: 'counting' | 'sampling' | 'done' | 'failed'; secondsLeft?: number };
  outputViews: { count: number };
  /** The physics values in effect changed (the person's settings, or a plugin's overrides). */
  physicsChanged: { overriddenBy: string | undefined };
  /** The model's list of expressions changed (the expression editor saved or removed one). */
  expressionListChanged: undefined;
  /** An item scene was turned on or off. */
  itemScenesChanged: { active: string[] };
  /** A hand was found or lost (the inputs' sides). */
  handsChanged: { left: boolean; right: boolean };
  /** A controller button or stick direction was pressed or released (a hotkey trigger code). */
  padTrigger: { code: string; down: boolean };
  /** The display light overlay started or stopped. */
  lightOverlayChanged: { active: boolean };
  /** Controllers were connected or disconnected (their names). */
  controllersChanged: { names: string[] };
  error: { message: string };
  /** The Spout2 senders' state changed. */
  spoutState: SpoutState;
  virtualCameraState: VirtualCameraState;
  /** For the log only (no toast): a frame step that failed, and the like. */
  log: { text: string; kind: 'info' | 'error' };
};

/** No face for this long counts as "tracking lost". */
/** How long at most an output view's loading lowers the control window's frame rate. */
const LOADING_VIEW_MAX_MS = 60_000;
const LOST_AFTER_MS = 500;
/** Where tracking frames come from: this computer's camera, or a phone. */
export type FrameSource = 'webcam' | 'phone';

/**
 * The control window's state and frame loop. User actions go through the
 * command layer (`studio.run`, `studio.commands`), which agents use too.
 */
export class Studio implements StudioApi {
  readonly events = new Emitter<StudioEvents>();
  readonly commands: CommandRegistry<StudioApi>;
  /** Agents connected through the bridge (set by the bridge client). */
  agents: Array<{ name: string; scopes: readonly string[] }> = [];
  private overrideTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Parameters physics overwrites -> what drives them (from the model's physics file). */
  physicsDrivers: PhysicsDrivers = {};
  private ranges = new Map<string, { min: number; max: number }>();
  private defaults = new Map<string, number>();
  /** Tracking wins over the idle animation, with faded handovers. */
  readonly handover = new IdleHandover();
  /** Animated items' playback. */
  readonly animator = new ItemAnimator();
  /** Plugins' physics overrides (SetCurrentModelPhysicsRequest). */
  readonly physicsOverrides = new PhysicsOverrides();
  /** The physics values given to the renderer and views last (JSON), and who overrode them. */
  private appliedPhysics = '';
  private physicsOverriddenBy: string | undefined;
  /** Overrides are on: their timers are checked every frame. */
  private physicsWatched = false;
  /** Own expressions as loaded (for the runtime and output views), and files saved this session. */
  private ownExpressionList: Array<{ name: string; file: string; json: string }> = [];
  private savedExpressionFiles = new Map<string, string>();
  /** The model's expression files as its own files list them (before the editor's). */
  private baseExpressionFiles = new Set<string>();
  /** Item scenes that are on (this session), and items fading in or out (an opacity 0–1). */
  private activeScenes = new Set<string>();
  private itemFades = new Map<string, { from: number; to: number; start: number; ms: number }>();
  private lastAnimAt = 0;
  /** Rule outputs that got a value this frame (from tracking or a plugin), and agents' parameters. */
  private provided = new Set<string>();
  /** The mouse: the pointer over the page, or anywhere on the screen in the desktop app. */
  private pointer = new PointerInput();
  /** The display light overlay: the capture, and what it gives now. */
  private lightCapture = new LightCapture();
  private lightSmoother = new LightSmoother();
  private lightNow: OverlayState | undefined;
  private lastLightAt = 0;
  private sentLight = '';
  /** The controllers: the chosen ones' inputs, and the triggers held. */
  private controllerReader = new ControllerReader();
  private padHeld = new Set<string>();
  private padNames = '';
  /** The idle motion output views were told about last. */
  private sentIdle: string | undefined | null = null;
  /** Tints: the main model's by art-mesh ID, and one per item (RGBA 0–1), for output views. */
  private modelTints: Array<[string, number[]]> = [];
  private itemTints = new Map<string, number[]>();

  /** The redirects tracking uses now (drivers that no rule writes itself). */
  get trackingRedirects(): PhysicsDrivers {
    const rules = this.settings?.mapping.filter((r) => r.enabled) ?? [];
    return trackingRedirects(
      this.physicsDrivers,
      rules.map((r) => r.output),
      rules.filter((r) => r.followPhysics === false).map((r) => r.output),
    );
  }
  model: LoadedModelFiles | undefined;
  info: RuntimeModelInfo | undefined;
  settings: ModelSettings | undefined;
  app: AppSettings = { ...DEFAULT_APP_SETTINGS };
  /** Live values for the editors. */
  lastInputs: InputValues = {};
  lastParams: Record<string, number> = {};
  /** Collaboration for agents, set by the page. */
  collab: CollabApi | undefined;
  /** Called every frame after the parameters and items, before drawing (collaboration). */
  /** Run each frame, after the items; `draw` is whether this frame is drawn. */
  readonly frameHooks = new Set<(now: number, draw: boolean) => void>();
  /** The microphone's input level in dBFS, for the meter (display only, never stored). */
  micLevel: number | undefined;
  /** What lip sync added to the mouth last frame, in parameter units. */
  lipSyncValue: number | undefined;
  faceVisible = false;
  /** Manual parameter overrides (win over tracking). */
  overrides: Record<string, number> = {};

  private pipeline: TrackingPipeline | undefined;
  private hotkeys: HotkeyController;
  private tracker: FaceTracker | undefined;
  private mic = false;
  private micDevice: string | undefined;
  /** A stream given to `startMicrophone` (tests, or another audio source) instead of the microphone. */
  private micStream: MediaStream | undefined;
  /** The microphone runs the advanced lipsync. */
  private micAdvanced = false;
  /**
   * Starting the microphone waits for the browser (getUserMedia) and the audio
   * setup. Starts run one after another; a start overtaken by a later start or
   * a stop (its generation is no longer the current one) removes what it opened
   * instead of taking over.
   */
  private micGeneration = 0;
  private micQueue: Promise<void> = Promise.resolve();
  /** The advanced lipsync: the stream it follows (opened here, or given), its analysis, its reading. */
  private voiceStream: MediaStream | undefined;
  private voiceStreamOwned = false;
  private readonly voiceAnalysis = new VoiceAnalysis();
  voiceReading: VoiceReading | undefined;
  /** The model's motion-sync setting that moves the mouth now, if any. */
  motionSyncSetting: string | undefined;
  private lastVoiceAt = 0;
  /** What the running advanced lipsync was set up with (a change restarts or reroutes it). */
  private voiceKey = '';
  private latest: TrackingFrame | undefined;
  private lastFaceAt = 0;
  private limiter = new FrameLimiter(60);
  private lastRender = 0;
  private clock: FrameClock | undefined;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private calibrating: CalibrationRecorder | undefined;
  private recording: TrackingFrame[] | undefined;
  private differ = new ParamDiffer();
  private views = new Map<string, number>();
  private modelFilesForSync: Array<[string, Uint8Array]> = [];
  private itemFilesForSync = new Map<string, Array<[string, Uint8Array]>>();
  /** Values plugins inject into tracking inputs (the plugin API), if it is on. */
  plugins:
    | (InputInjector & {
        faceFound(t: number): boolean;
        /** Inputs plugins drive now, each with the plugin's ID. */
        injectedInputs(t: number): ReadonlyMap<string, string>;
      })
    | undefined;
  /**
   * Frames run since the page started (for the plugin API's frame rate):
   * the model's frame rate, drawn or not.
   */
  framesDrawn = 0;
  /** Frames that drew the canvas; a window out of sight advances without drawing. */
  framesPainted = 0;

  /** Resolves once the app-wide settings are read. */
  readonly ready: Promise<void>;
  private sentBlink: boolean | undefined;

  constructor(
    readonly runtime: AvatarRuntime,
    private store: SettingsStore,
    private sync?: SyncTransport,
    private itemFiles: ItemFileStore = new MemoryItemFileStore(),
  ) {
    this.hotkeys = new HotkeyController({
      setExpression: (n, on) => this.setExpression(n, on),
      playMotion: (r, m) => this.playMotion(r, m),
      setItemVisible: (i, v) => this.setItemVisible(i, v),
      isItemVisible: (i) => this.runtime.isItemVisible(i),
      setItemScene: (id, on, fade) => this.setItemScene(id, on, fade),
      applyScreenOverlay: (a) => void this.applyScreenOverlay(a),
      isItemSceneOn: (id) => this.activeScenes.has(id),
      calibrate: () => {
        if (this.trackingOn) void this.calibrate();
        else this.events.emit('error', { message: 'Start the camera (or a phone) to calibrate.' });
      },
    });
    runtime.on('motionFinished', (p) => this.events.emit('motionFinished', p));
    runtime.on('itemMoved', () => this.saveItems());
    sync?.onMessage((m) => this.onSync(m));
    this.commands = new CommandRegistry<StudioApi>(this, studioCommands());
    this.ready = store.getApp().then(
      (app) => {
        this.mark('settingsRead');
        this.app = app;
        if (app.mouseScreen !== undefined) this.pointer.setScreen(app.mouseScreen);
        this.applySettings();
        this.events.emit('appSettingsChanged', app);
      },
      () => undefined,
    );
  }

  // --- model ---------------------------------------------------------------

  async loadModel(files: ModelFileSet): Promise<void> {
    this.mark('modelStart');
    await this.ready;
    const model = await openModel(files);
    this.mark('modelOpened');
    for (const id of this.itemFilesForSync.keys()) this.runtime.removeItem(id);
    this.itemFilesForSync.clear();
    // Every file is read for output views, which bridge views start uploading as soon as
    // they are read, while the renderer loads the model from the same reads (the file
    // sets share reads in flight).
    const disk =
      files instanceof DiskFileSet ? { folderId: files.folderId, prefix: files.root } : undefined;
    const reading = Promise.all(
      files.paths().map(async (p): Promise<[string, Uint8Array]> => [p, await files.read(p)]),
    ).then((entries) => {
      this.mark('modelRead');
      this.events.emit('modelFiles', {
        key: model.key,
        files: entries,
        ...(disk ? { disk } : {}),
      });
      return entries;
    });
    const [info, entries] = await Promise.all([this.runtime.load(model), reading]);
    this.mark('modelLoaded');
    this.drawnSinceLoad = false;
    const facts = this.runtime.physicsFacts();
    this.physicsDrivers = facts ? await readPhysicsDrivers(model.files, model.manifest, facts) : {};
    this.ranges = new Map(
      info.parameters.map((p) => [p.id, { min: p.min ?? 0, max: p.max ?? 1 }] as const),
    );
    this.defaults = new Map(
      info.parameters.flatMap((p) => (p.default === undefined ? [] : [[p.id, p.default] as const])),
    );
    this.handover.reset();
    this.animator.clear();
    this.provided.clear();
    this.modelTints = [];
    this.itemTints.clear();
    this.sentIdle = null;
    this.physicsOverrides.clear();
    this.appliedPhysics = '';
    this.physicsOverriddenBy = undefined;
    this.physicsWatched = false;
    this.activeScenes.clear();
    this.itemFades.clear();
    // The old model's motion sync went with it; the new model's settings decide again.
    this.motionSyncSetting = undefined;
    this.model = model;
    this.baseExpressionFiles = new Set(model.manifest.expressions.map((e) => e.file));
    this.info = info;
    this.hotkeys.reset();
    this.overrides = {};
    const stored = await this.store.get(model.key);
    this.settings =
      stored ??
      defaultSettings(
        model.key,
        info.parameters.map((p) => p.id),
      );
    if (!stored) await this.store.put(this.settings);
    this.ownExpressionList = [];
    this.savedExpressionFiles.clear();
    await this.loadOwnExpressions(false);
    this.applySettings();
    await this.restoreItems();
    this.modelFilesForSync = entries;
    this.broadcastModel();
    // The light overlay on the new model too.
    this.sentLight = '';
    this.applyLight();
    this.events.emit('modelLoaded', { key: model.key, label: files.label });
  }

  unloadModel(): void {
    this.stopWebItems();
    for (const id of this.itemFilesForSync.keys()) this.runtime.removeItem(id);
    this.itemFilesForSync.clear();
    this.animator.clear();
    this.runtime.unload();
    this.model = undefined;
    this.physicsDrivers = {};
    this.physicsOverrides.clear();
    this.appliedPhysics = '';
    this.physicsWatched = false;
    this.info = undefined;
    this.settings = undefined;
    this.pipeline = undefined;
    this.modelFilesForSync = [];
    this.sync?.post({ type: 'unload' });
    this.events.emit('modelUnloaded', undefined);
  }

  // --- the command layer and its needs --------------------------------------

  /** Runs a command for the UI. Errors are shown as notices and passed on. */
  async run(name: string, args: unknown = {}, origin: Origin = UI_ORIGIN): Promise<unknown> {
    try {
      return await this.commands.dispatch(name, args, origin);
    } catch (e) {
      this.events.emit('error', { message: (e as Error).message });
      throw e;
    }
  }

  get parameters(): readonly ParameterInfo[] {
    return this.info?.parameters ?? [];
  }
  isItemPinned(id: string): boolean {
    return this.runtime.items().find((i) => i.id === id)?.pinned ?? false;
  }
  itemPlacement(id: string): ItemPlacement | undefined {
    return this.runtime.items().find((i) => i.id === id)?.placement;
  }
  async loadModelFromUrl(url: string): Promise<void> {
    await this.loadModel(await fileSetFromUrl(url));
  }
  stopMotions(): void {
    this.runtime.stopMotions();
    this.sync?.post({ type: 'stopMotions' });
  }

  setOverrides(values: Record<string, number>, ttlMs?: number): void {
    for (const [k, v] of Object.entries(values)) {
      this.overrides[k] = v;
      const t = this.overrideTimers.get(k);
      if (t) clearTimeout(t);
      this.overrideTimers.delete(k);
      if (ttlMs !== undefined)
        this.overrideTimers.set(
          k,
          setTimeout(() => {
            this.overrideTimers.delete(k);
            delete this.overrides[k];
          }, ttlMs),
        );
    }
  }
  clearOverrides(ids?: string[]): void {
    for (const k of ids ?? Object.keys(this.overrides)) {
      delete this.overrides[k];
      const t = this.overrideTimers.get(k);
      if (t) clearTimeout(t);
      this.overrideTimers.delete(k);
    }
  }

  async speak(audio: Uint8Array, volume: number): Promise<void> {
    // Output views move the mouth with the same sound, without playing it (only views that
    // are open: each message copies the sound).
    if (this.views.size) this.sync?.post({ type: 'speak', audio });
    await this.runtime.speak(audio, volume);
  }

  async screenshot(): Promise<Uint8Array> {
    const shot = this.runtime.screenshot();
    // The screenshot is of the next frame. A hidden window draws none (no
    // animation frames), so draw one if none came.
    let done = false;
    const nudge = setTimeout(() => {
      if (!done) this.runtime.render(0);
    }, 200);
    try {
      return new Uint8Array(await (await shot).arrayBuffer());
    } finally {
      done = true;
      clearTimeout(nudge);
    }
  }

  /** Restores a snapshot taken for undo. */
  restore(snap: Snapshot): void {
    this.app = snap.app;
    void this.store.putApp(this.app);
    this.events.emit('appSettingsChanged', this.app);
    this.clearOverrides();
    this.setOverrides(snap.overrides);
    if (snap.settings && this.settings && snap.settings.modelKey === this.settings.modelKey) {
      this.settings = snap.settings;
      this.applySettings();
      if (snap.settings.itemLayout) this.runtime.applyItemLayout(snap.settings.itemLayout);
      for (const i of snap.settings.items) this.runtime.setItemVisible(i.id, i.visible);
      this.broadcastItems();
      this.scheduleSave();
      this.events.emit('settingsChanged', this.settings);
      this.events.emit('itemsChanged', { items: this.items });
    } else this.applySettings();
  }

  isItemVisible(id: string): boolean {
    return this.runtime.isItemVisible(id);
  }

  /** A file for an output view over the bridge: of the loaded model, or of an item. */
  syncFile(scope: 'model' | 'item', owner: string, path: string): Uint8Array | undefined {
    const list =
      scope === 'model'
        ? owner === this.model?.key
          ? this.modelFilesForSync
          : undefined
        : this.itemFilesForSync.get(owner);
    return list?.find(([p]) => p === path)?.[1];
  }

  // --- settings ------------------------------------------------------------

  /** Replaces settings (for example after an import) and saves them. */
  updateSettings(patch: Partial<ModelSettings>): void {
    if (!this.settings) return;
    this.settings = { ...this.settings, ...patch, modelKey: this.settings.modelKey };
    this.applySettings();
    this.scheduleSave();
    this.events.emit('settingsChanged', this.settings);
  }

  /** `.vtube.json` files in the loaded model's folder. */
  get vtubeSettingsFiles(): string[] {
    return (this.model?.files.paths() ?? []).filter((p) => /\.vtube\.json$/i.test(p));
  }

  /**
   * Converts VTube Studio settings for the loaded model, without applying
   * them. With no text given, reads the `.vtube.json` (and
   * `items_pinned_to_model.json`) from the model's folder.
   */
  async previewVtubeImport(vtubeJson?: string, pinnedItemsJson?: string): Promise<ImportResult> {
    const m = this.model;
    if (!m || !this.info) throw new Error('Load a model first.');
    const text = (p: string) => m.files.read(p).then((d) => new TextDecoder().decode(d));
    if (vtubeJson === undefined) {
      const file = this.vtubeSettingsFiles[0];
      if (!file) throw new Error('The model folder has no .vtube.json file.');
      vtubeJson = await text(file);
      const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/') + 1) : '';
      const pinned = `${dir}items_pinned_to_model.json`;
      if (pinnedItemsJson === undefined && m.files.has(pinned))
        pinnedItemsJson = await text(pinned);
    }
    return importVtubeStudio({
      vtubeJson,
      pinnedItemsJson,
      manifest: m.manifest,
      paths: m.files.paths(),
      parameters: this.info.parameters.map((p) => p.id),
      blendshapes: BLENDSHAPE_NAMES,
    });
  }

  /** The settings export: JSON, or with `includeItems` a zip with the item files. */
  async exportSettingsFile(includeItems: boolean): Promise<Uint8Array> {
    const s = this.settings;
    if (!s) throw new Error('Load a model first.');
    await this.flushSave();
    const json = exportSettings(s);
    if (!includeItems || !s.items.length) return new TextEncoder().encode(json);
    const items = [];
    for (const i of s.items) {
      const files = this.itemFilesForSync.get(i.id) ?? (await this.itemFiles.get(i.id));
      if (files) items.push({ id: i.id, files });
    }
    return buildSettingsBundle(json, items);
  }

  /** Imports an exported settings file (JSON or zip) into the loaded model. */
  async importSettingsFile(data: Uint8Array): Promise<void> {
    const s = this.settings;
    if (!s) throw new Error('Load a model first.');
    const { settings, itemFiles } = await readSettingsExport(
      data,
      s.modelKey,
      s.items.map((i) => i.id),
    );
    for (const [id, files] of itemFiles) await this.itemFiles.put(id, files);
    for (const id of this.itemFilesForSync.keys()) this.runtime.removeItem(id);
    this.itemFilesForSync.clear();
    this.hotkeys.reset();
    this.activeScenes.clear();
    this.updateSettings(settings);
    await this.flushSave();
    await this.restoreItems();
    this.broadcastItems();
    // The file's own expressions (browser-kept ones carry their text).
    await this.loadOwnExpressions();
    this.events.emit('itemsChanged', { items: this.items });
  }

  /** Applies an import's converted settings to the loaded model. */
  applyImport(result: ImportResult): void {
    this.hotkeys.reset();
    this.updateSettings(result.patch);
  }

  resetMapping(): void {
    if (!this.info) return;
    this.updateSettings({ mapping: defaultRules(this.info.parameters.map((p) => p.id)) });
  }

  async flushSave(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    if (this.settings) await this.store.put(this.settings);
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.flushSave(), 300);
  }

  /** The background and frame cap in effect: app-wide, or the model's own. */
  get stage(): { background: Background; fpsCap: number } {
    return effectiveStage(this.app, this.settings);
  }

  /** Changes the background or frame cap where they currently come from. */
  setStage(patch: { background?: Background; fpsCap?: number }): void {
    if (this.settings?.stageOverride) {
      this.updateSettings(patch);
      return;
    }
    this.app = { ...this.app, ...patch };
    void this.store.putApp(this.app);
    this.applySettings();
    this.events.emit('appSettingsChanged', this.app);
  }

  /** App-wide options of the desktop app (global hotkeys, reopening the last model). */
  setAppOptions(patch: Partial<Pick<AppSettings, 'globalHotkeys' | 'reopenLastModel'>>): void {
    this.app = { ...this.app, ...patch };
    void this.store.putApp(this.app);
    this.events.emit('appSettingsChanged', this.app);
  }

  /** Collaboration settings: the server, nickname, address hiding, rate and size. */
  setCollabSettings(patch: Partial<AppSettings['collab']>): void {
    this.app = { ...this.app, collab: { ...this.app.collab, ...patch } };
    void this.store.putApp(this.app);
    this.events.emit('appSettingsChanged', this.app);
  }

  // --- Spout2 output ------------------------------------------------

  private spoutLast: SpoutState | undefined;
  private cameraLast: VirtualCameraState | undefined;
  private cameraApplied = '';
  private cameraTimer: ReturnType<typeof setInterval> | undefined;

  /** Whether this app can run the virtual camera at all (the desktop app; the platform decides the rest). */
  get virtualCameraSupported(): boolean {
    return !!desktopApi()?.virtualCameraConfigure;
  }

  virtualCameraStatus(): VirtualCameraState & { settings: VirtualCameraSettings } {
    const st = this.cameraLast;
    return {
      available: st?.available ?? false,
      active: false,
      width: 0,
      height: 0,
      fps: 0,
      frames: 0,
      ...(st ?? {}),
      ...(!st?.problem && !this.virtualCameraSupported
        ? { problem: 'The virtual camera is available in the desktop app.' }
        : {}),
      settings: structuredClone(this.app.virtualCamera),
    };
  }

  setVirtualCamera(settings: VirtualCameraSettings): void {
    this.app = { ...this.app, virtualCamera: parseVirtualCamera(settings) };
    void this.store.putApp(this.app);
    this.events.emit('appSettingsChanged', this.app);
    this.applyVirtualCamera();
  }

  /** Tells the main process what the camera sends; polls its state while it is on. */
  applyVirtualCamera(): void {
    const api = desktopApi();
    if (!api?.virtualCameraConfigure || typeof location === 'undefined') return;
    const cfg = virtualCameraConfig(
      this.app.virtualCamera,
      new URL('output.html', location.href).href,
    );
    const key = JSON.stringify(cfg);
    if (key === this.cameraApplied) return;
    this.cameraApplied = key;
    void api.virtualCameraConfigure(cfg).then((st) => st && this.gotCamera(st));
    if (cfg.enabled && !this.cameraTimer)
      this.cameraTimer = setInterval(() => void this.refreshVirtualCamera(), 2000);
    else if (!cfg.enabled && this.cameraTimer) {
      clearInterval(this.cameraTimer);
      this.cameraTimer = undefined;
    }
  }

  /**
   * Installs or removes the camera other apps list (Windows and macOS). A
   * person's action: Windows asks for administrator rights, macOS for approval.
   */
  async installVirtualCamera(
    action: 'install' | 'uninstall',
    options?: { olderApps?: boolean },
  ): Promise<VirtualCameraState | undefined> {
    const api = desktopApi();
    if (!api?.virtualCameraInstall) return undefined;
    const busy = this.cameraLast?.install;
    if (busy) this.gotCamera({ ...this.cameraLast!, install: { ...busy, busy: true } });
    const st = await api.virtualCameraInstall(action, options);
    if (st) this.gotCamera(st);
    // The camera, if on, starts now that it is installed.
    this.cameraApplied = '';
    this.applyVirtualCamera();
    return st ?? undefined;
  }

  async refreshVirtualCamera(): Promise<VirtualCameraState | undefined> {
    const st = await desktopApi()?.virtualCameraState?.();
    if (st) this.gotCamera(st);
    return st ?? undefined;
  }

  private gotCamera(st: VirtualCameraState): void {
    this.cameraLast = st;
    this.events.emit('virtualCameraState', st);
  }
  private spoutApplied = '';
  private spoutTimer: ReturnType<typeof setInterval> | undefined;
  /** For measurements and tests: the frames read back even where the GPU path works. */
  spoutPath: 'auto' | 'readback' = 'auto';
  /** For tests: never draw an output at a scale. */
  spoutNoScale = false;

  /** Whether this app can send Spout2 at all (the desktop app; Windows decides the rest). */
  get spoutSupported(): boolean {
    return !!desktopApi()?.spoutConfigure;
  }

  spoutStatus(): {
    available: boolean;
    problem?: string;
    settings: SpoutSettings;
    outputs: SpoutOutputState[];
  } {
    const st = this.spoutLast;
    return {
      available: st?.available ?? false,
      ...(st?.problem
        ? { problem: st.problem }
        : !this.spoutSupported
          ? { problem: 'Spout2 is available in the desktop app on Windows.' }
          : {}),
      settings: structuredClone(this.app.spout),
      outputs: st?.outputs ?? [],
    };
  }

  setSpout(settings: SpoutSettings): void {
    this.app = { ...this.app, spout: parseSpout(settings) };
    void this.store.putApp(this.app);
    this.events.emit('appSettingsChanged', this.app);
    this.applySpout();
  }

  /**
   * Tells the main process which outputs to send, at what size and rate:
   * after the settings change, and when the stage's size or frame cap does.
   */
  applySpout(): void {
    const api = desktopApi();
    if (!api?.spoutConfigure || typeof location === 'undefined') return;
    const cfg = {
      ...spoutConfig(
        this.app.spout,
        this.runtime.pixelSize(),
        new URL('output.html', location.href).href,
        this.stage.fpsCap,
      ),
      ...(this.spoutPath === 'readback' ? { path: 'readback' as const } : {}),
      ...(this.spoutNoScale ? { noScale: true } : {}),
    };
    const key = JSON.stringify(cfg);
    if (key === this.spoutApplied) return;
    this.spoutApplied = key;
    void api.spoutConfigure(cfg).then((st) => st && this.gotSpout(st));
    // The senders' state, every two seconds while one is on.
    if (cfg.outputs.length && !this.spoutTimer)
      this.spoutTimer = setInterval(() => void this.refreshSpout(), 2000);
    else if (!cfg.outputs.length && this.spoutTimer) {
      clearInterval(this.spoutTimer);
      this.spoutTimer = undefined;
    }
  }

  async refreshSpout(): Promise<SpoutState | undefined> {
    const st = await desktopApi()?.spoutState?.();
    if (st) this.gotSpout(st);
    return st ?? undefined;
  }

  private gotSpout(st: SpoutState): void {
    this.spoutLast = st;
    this.events.emit('spoutState', st);
  }

  /** Gives this model its own background and frame cap (starting from the current ones), or not. */
  setStageOverride(on: boolean): void {
    if (!this.settings) return;
    this.updateSettings(on ? { stageOverride: true, ...this.stage } : { stageOverride: false });
  }

  private applySettings(): void {
    const s = this.settings;
    this.updateFrameCap();
    this.applySpout();
    this.applyVirtualCamera();
    if (!s) {
      this.broadcastStage();
      return;
    }
    const cfg = {
      mirror: s.mirror,
      filter: s.filter,
      calibration: s.calibration,
      mapping: s.mapping,
      ...(s.lipSync.frequencyWeights ? { frequencyWeights: s.lipSync.frequencyWeights } : {}),
    };
    if (this.pipeline) this.pipeline.configure(cfg);
    else this.pipeline = new TrackingPipeline(cfg);
    this.updateFrameCap();
    this.runtime.setTransform(s.transform);
    this.handover.fadeMs = s.handoverMs;
    this.runtime.setLipSyncGate(s.lipSync.gate);
    this.followVoiceSettings();
    this.runtime.setEffect('physics', s.physics);
    this.applyPhysics();
    // Per-mesh light strengths are the model's.
    this.applyLight();
    const idle = s.idleMotion && this.model?.files.has(s.idleMotion) ? s.idleMotion : undefined;
    this.runtime.setIdleMotion(idle);
    if (idle !== this.sentIdle) {
      this.sentIdle = idle;
      this.sync?.post({ type: 'idle', file: idle });
    }
    this.broadcastStage();
  }

  // --- camera, microphone, calibration -------------------------------------

  async startCamera(deviceId?: string): Promise<void> {
    this.tracker ??= new FaceTracker((f) => this.feedFrame(f));
    this.tracker.mode = this.app.trackingMode;
    await this.tracker.start(deviceId);
    this.events.emit('cameraChanged', { on: true });
  }

  // --- hand tracking and gestures ---------------------------------------

  /** What the camera tracks: the face, the hands, or both (app-wide). */
  get trackingMode(): TrackingMode {
    return this.app.trackingMode;
  }

  /** Changes what the camera tracks; a running camera follows at once. */
  async setTrackingMode(mode: TrackingMode): Promise<void> {
    if (this.tracker?.active) await this.tracker.setMode(mode);
    this.app = { ...this.app, trackingMode: mode };
    void this.store.putApp(this.app);
    if (mode === 'face') this.clearHands();
    this.events.emit('appSettingsChanged', this.app);
  }

  /** How easily a gesture (or the two-hand pose) is recognized, 0 to 100 (app-wide). */
  setGestureSensitivity(gesture: Gesture | TwoHandPose, value: number): void {
    const v = Math.max(0, Math.min(100, Math.round(value)));
    this.app = {
      ...this.app,
      gestureSensitivity: { ...this.app.gestureSensitivity, [gesture]: v },
    };
    void this.store.putApp(this.app);
    this.events.emit('appSettingsChanged', this.app);
  }

  /** The hand preview in the Camera tab (points only, this window only). */
  setHandPreview(on: boolean): void {
    this.app = { ...this.app, handPreview: on };
    void this.store.putApp(this.app);
    this.events.emit('appSettingsChanged', this.app);
  }

  /** The latest frame's tracked hands (points), for the preview; empty without hand tracking. */
  get latestHands(): readonly TrackedHand[] {
    return this.latest?.hands ?? [];
  }

  /** The latest frame's hands (the subject's own sides), for the preview and gestures. */
  handReadings: Partial<Record<HandSide, HandReading>> = {};
  /** What the hands show now. */
  handGestures: HandGestures | undefined;
  private readonly gestures = new GestureWatcher();
  private handsFoundKey = '00';

  /** Whether each hand is found, as the inputs name them (mirrored like the face). */
  get handsFound(): { left: boolean; right: boolean } {
    return {
      left: this.lastInputs.HandLeftFound === 1,
      right: this.lastInputs.HandRightFound === 1,
    };
  }

  /** No hands any more (camera off, face only): gestures end, so "while held" hotkeys turn off. */
  private clearHands(): void {
    this.handReadings = {};
    this.handGestures = undefined;
    const { release } = this.gestures.step(
      this.settings?.hotkeys ?? [],
      undefined,
      performance.now(),
    );
    this.gestures.reset();
    for (const id of release) this.releaseHotkey(id);
  }

  /** Reads the hands of a frame, and fires and releases gesture hotkeys. */
  private stepHands(f: TrackingFrame | undefined, now: number): void {
    if (!f?.hands) {
      if (this.handGestures) this.clearHands();
    } else {
      this.handReadings = handReadings(f.hands);
      this.handGestures = handGestures(this.handReadings, this.app.gestureSensitivity);
    }
    const hotkeys = this.settings?.hotkeys ?? [];
    if (!hotkeys.some((h) => h.gesture)) return;
    const { fire, release } = this.gestures.step(hotkeys, this.handGestures, now);
    for (const id of fire) this.fireHotkey(id);
    for (const id of release) this.releaseHotkey(id);
  }

  stopCamera(): void {
    this.tracker?.stop();
    // A phone tracker goes on: its next frame is the latest again.
    delete this.sources.webcam;
    this.latest = undefined;
    this.clearHands();
    if (this.faceVisible) {
      this.faceVisible = false;
      this.events.emit('trackingLost', undefined);
    }
    this.events.emit('cameraChanged', { on: false });
  }

  /** A phone tracker sent a frame within the last second. */
  get phoneTracking(): boolean {
    const f = this.sources.phone;
    return !!f && performance.now() - f.t < 1000;
  }

  /** Something tracks the face: this computer's camera, or a phone. */
  get trackingOn(): boolean {
    return this.cameraOn || this.phoneTracking;
  }

  get cameraOn(): boolean {
    return !!this.tracker?.active;
  }
  get trackerRate(): number {
    return this.tracker?.rate ?? 0;
  }
  get cameraElement(): HTMLVideoElement | undefined {
    return this.tracker?.element;
  }

  /**
   * Starts the microphone for lip sync: a `deviceId` from
   * `enumerateDevices()`, or the browser's choice. Mochi2D opens it (with the
   * browser's voice processing), and opens it again for each model loaded.
   * Starting it while on switches the device.
   */
  async startMicrophone(deviceId?: string, opts: { stream?: MediaStream } = {}): Promise<void> {
    const generation = ++this.micGeneration;
    const run = this.micQueue.then(() => this.openMicrophone(deviceId, opts, generation));
    this.micQueue = run.catch(() => undefined);
    return run;
  }

  private async openMicrophone(
    deviceId: string | undefined,
    opts: { stream?: MediaStream },
    generation: number,
  ): Promise<void> {
    // Overtaken before it began: nothing to do.
    if (generation !== this.micGeneration) return;
    const advanced = this.settings?.lipSync.type === 'advanced';
    if (
      this.mic &&
      this.micDevice === deviceId &&
      this.micStream === opts.stream &&
      this.micAdvanced === advanced
    )
      return;
    this.stopVoice();
    try {
      if (advanced) await this.startVoice(deviceId, opts.stream);
      else await this.runtime.startLipSync(deviceId, opts.stream ? { stream: opts.stream } : {});
    } catch (e) {
      this.stopVoice();
      this.runtime.stopLipSync();
      if (generation !== this.micGeneration) {
        this.mic = false;
        return;
      }
      this.mic = false;
      this.micDevice = undefined;
      this.micStream = undefined;
      this.events.emit('microphoneChanged', { on: false });
      throw e;
    }
    // Overtaken while it opened (turned off, or started again): what it opened goes, and
    // the microphone counts as off until the start that overtook it (if any) opens it.
    if (generation !== this.micGeneration) {
      this.stopVoice();
      this.runtime.stopLipSync();
      this.mic = false;
      return;
    }
    this.mic = true;
    this.micDevice = deviceId;
    this.micStream = opts.stream;
    this.micAdvanced = advanced;
    this.events.emit('microphoneChanged', { on: true });
  }

  // --- the advanced lipsync ---------------------------------------------

  /**
   * Opens the stream the advanced lipsync follows (the microphone, with the
   * browser's voice processing off unless asked for), and routes it.
   */
  private async startVoice(deviceId: string | undefined, given?: MediaStream): Promise<void> {
    const ls = this.settings!.lipSync;
    const stream =
      given ??
      (await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
          echoCancellation: ls.voiceProcessing,
          noiseSuppression: ls.voiceProcessing,
          autoGainControl: ls.voiceProcessing,
        },
      }));
    this.voiceStream = stream;
    this.voiceStreamOwned = !given;
    this.voiceKey = this.voiceSetup();
    await this.routeVoice();
  }

  /**
   * Where the stream goes: through the model's motion-sync setting (its own
   * shapes move the mouth), or to Mochi2D's live lip sync (the mouth's
   * opening) and Mochi Studio's analysis (the voice inputs).
   */
  private async routeVoice(): Promise<void> {
    const stream = this.voiceStream;
    const s = this.settings;
    if (!stream || !s) return;
    const setting = this.usableMotionSync(s.lipSync.motionSync);
    this.applyVoiceProfile();
    if (setting) {
      this.voiceAnalysis.stop();
      this.runtime.stopLipSync();
      await this.runtime.startMotionSync(setting, stream);
      this.motionSyncSetting = setting;
      return;
    }
    if (this.motionSyncSetting) {
      this.runtime.stopMotionSync();
      this.motionSyncSetting = undefined;
    }
    await this.runtime.startLipSync(this.micDevice, { stream });
    this.voiceAnalysis.gain = Math.max(0, s.lipSync.gain);
    if (!this.voiceAnalysis.running) await this.voiceAnalysis.start(stream);
  }

  /** The model's usable motion-sync setting of that name (or ID), if it has one. */
  private usableMotionSync(name: string | undefined): string | undefined {
    if (!name) return undefined;
    const x = this.runtime
      .motionSyncSettings()
      .find((m) => m.usable && (m.name === name || m.id === name));
    return x ? x.name || x.id : undefined;
  }

  /** The model's motion-sync settings that can run (for the lipsync's choice of mouth shapes). */
  get motionSyncSettings(): ReadonlyArray<{ id: string; name: string }> {
    return this.model ? this.runtime.motionSyncSettings().filter((m) => m.usable) : [];
  }

  private stopVoice(): void {
    this.voiceAnalysis.stop();
    if (this.motionSyncSetting) {
      this.runtime.stopMotionSync();
      this.motionSyncSetting = undefined;
    }
    if (this.voiceStream && this.voiceStreamOwned)
      for (const t of this.voiceStream.getTracks()) t.stop();
    this.voiceStream = undefined;
    this.voiceStreamOwned = false;
    this.voiceReading = undefined;
    this.voiceKey = '';
  }

  /** What a running advanced lipsync depends on: a change of the type or of voice processing restarts it. */
  private voiceSetup(): string {
    const ls = this.settings?.lipSync;
    return ls ? JSON.stringify([ls.type, ls.voiceProcessing]) : '';
  }

  /** Follows lipsync changes while the microphone is on. */
  private followVoiceSettings(): void {
    const s = this.settings;
    if (!s || !this.mic) return;
    const advanced = s.lipSync.type === 'advanced';
    if (advanced !== this.micAdvanced || (advanced && this.voiceSetup() !== this.voiceKey)) {
      const device = this.micDevice;
      const stream = this.micStream;
      this.micAdvanced = !advanced; // force the restart
      void this.startMicrophone(device, stream ? { stream } : {}).catch((e) =>
        this.events.emit('error', { message: (e as Error).message }),
      );
      return;
    }
    if (!advanced) return;
    this.voiceAnalysis.gain = Math.max(0, s.lipSync.gain);
    this.applyVoiceProfile();
    if (this.usableMotionSync(s.lipSync.motionSync) !== this.motionSyncSetting)
      void this.routeVoice().catch((e) =>
        this.events.emit('error', { message: (e as Error).message }),
      );
  }

  /** The voice profile in use, given to the analysis and to the model's motion sync. */
  private applyVoiceProfile(): void {
    const p = this.voiceProfile;
    this.voiceAnalysis.configure(p, this.settings?.lipSync.gate);
    this.runtime.setVoiceProfile(usableProfile(p) as StoredVoiceProfile | null);
  }

  /** The voice profile chosen (app-wide), if any. */
  get voiceProfile(): StoredVoiceProfile | undefined {
    return this.app.voices.find((v) => v.name === this.app.voice);
  }
  get voiceProfiles(): readonly StoredVoiceProfile[] {
    return this.app.voices;
  }

  /** Chooses the voice the analysis knows (undefined: Mochi2D's neutral voice). */
  selectVoice(name: string | undefined): void {
    const voice = name && this.app.voices.some((v) => v.name === name) ? name : undefined;
    const { voice: _old, ...rest } = this.app;
    this.app = { ...rest, ...(voice ? { voice } : {}) };
    void this.store.putApp(this.app);
    this.applyVoiceProfile();
    this.events.emit('appSettingsChanged', this.app);
  }

  deleteVoice(name: string): void {
    this.app = { ...this.app, voices: this.app.voices.filter((v) => v.name !== name) };
    if (this.app.voice === name) this.selectVoice(undefined);
    else {
      void this.store.putApp(this.app);
      this.events.emit('appSettingsChanged', this.app);
    }
  }

  /**
   * Calibrates a voice (Mochi2D's `VoiceCalibration`): records `element`
   * (say the vowel, or stay quiet for "Silence") from the stream the
   * lipsync follows, or the microphone, and keeps it in the voice's profile,
   * saved app-wide. Returns how many analysis windows were used.
   */
  async calibrateVoice(name: string, element: VoiceElement, seconds = 1.2): Promise<number> {
    const voice = name.trim().slice(0, 64);
    if (!voice) throw new Error('Give the voice a name first.');
    const ls = this.settings?.lipSync;
    const clip = await this.runtime.recordAudio(seconds, {
      ...(this.voiceStream
        ? { stream: this.voiceStream }
        : this.micStream
          ? { stream: this.micStream }
          : {}),
      ...(this.micDevice ? { deviceId: this.micDevice } : {}),
      voiceProcessing: ls?.voiceProcessing ?? false,
    });
    const cal = new VoiceCalibration(voice);
    const used = cal.add(element, clip.channels, clip.sampleRate);
    if (!used)
      throw new Error(
        element === 'Silence'
          ? 'Nothing was recorded. Check the microphone, then stay quiet while it records.'
          : `No voice was heard. Say “${element}” clearly while it records (about a second), a little louder.`,
      );
    const old = this.app.voices.find((v) => v.name === voice);
    const profile = mergeProfiles(old, cal.profile() as StoredVoiceProfile, [element]);
    this.app = {
      ...this.app,
      voices: [...this.app.voices.filter((v) => v.name !== voice), profile],
      voice,
    };
    void this.store.putApp(this.app);
    this.applyVoiceProfile();
    this.events.emit('appSettingsChanged', this.app);
    return used;
  }

  /**
   * The lipsync's own automatic setup: VoiceA …
   * VoiceO to ParamA … ParamO, and VoiceSilence to ParamSilence, where the
   * model has them. Returns the parameters it set up.
   */
  setUpVowelMapping(): string[] {
    const s = this.settings;
    if (!s || !this.info) return [];
    const { rules, mapped } = vowelMapping(s.mapping, this.info.parameters);
    if (mapped.length) {
      this.updateSettings({ mapping: rules });
      return mapped;
    }
    // A model without vowel parameters: the vowels shape its mouth form instead.
    if (
      lacksVowelParameters(this.info.parameters) &&
      this.info.parameters.some((p) => p.id === MOUTH_FORM_PARAM)
    ) {
      if (!s.lipSync.vowelForm) this.updateSettings({ lipSync: { ...s.lipSync, vowelForm: true } });
      return [MOUTH_FORM_PARAM];
    }
    return [];
  }

  /** The mouth form the vowels give this frame, smoothed (−1 round to 1 wide), and when it was set. */
  private vowelForm = 0;

  /** The basic mouth: the vowels shape the mouth form, on top of tracking. */
  private shapeMouth(params: Record<string, number>, dt: number): void {
    const s = this.settings;
    const r = this.voiceReading;
    if (!s?.lipSync.vowelForm || !this.micAdvanced || !this.info) return;
    const p = this.info.parameters.find((x) => x.id === MOUTH_FORM_PARAM);
    if (!p) return;
    const target = r ? vowelMouthForm(r.weights) : 0;
    // About 60 ms to follow: the analysis jumps from window to window.
    this.vowelForm += (target - this.vowelForm) * (1 - Math.exp(-dt / 60));
    if (Math.abs(this.vowelForm) < 1e-4 && params[MOUTH_FORM_PARAM] === undefined) return;
    params[MOUTH_FORM_PARAM] = shapeMouthForm(params[MOUTH_FORM_PARAM], this.vowelForm, {
      min: p.min ?? -1,
      max: p.max ?? 1,
      ...(p.default !== undefined ? { default: p.default } : {}),
    });
  }

  /** The voice inputs for this frame (advanced lipsync), and the motion-sync values to show. */
  private voiceFrame(now: number): {
    inputs?: Record<string, number>;
    shown?: Record<string, number>;
  } {
    if (!this.mic || !this.micAdvanced) return {};
    const dt = this.lastVoiceAt ? (now - this.lastVoiceAt) / 1000 : 1 / 60;
    this.lastVoiceAt = now;
    if (this.motionSyncSetting) {
      const t = this.runtime.motionSyncTick();
      this.voiceReading = t
        ? {
            weights: t.weights,
            volume: openness(t.level, usableProfile(this.voiceProfile)),
            level: t.level,
            silent: t.silent,
          }
        : undefined;
      return {
        inputs: this.voiceReading ? voiceInputs(this.voiceReading) : silentInputs(),
        ...(t ? { shown: t.values } : {}),
      };
    }
    this.voiceReading = this.voiceAnalysis.step(Math.min(0.5, Math.max(0.001, dt)));
    return { inputs: this.voiceReading ? voiceInputs(this.voiceReading) : silentInputs() };
  }

  /** The microphone chosen with `startMicrophone` (undefined: the browser's choice). */
  get microphoneDevice(): string | undefined {
    return this.micDevice;
  }

  stopMicrophone(): void {
    // A start still opening is overtaken: it removes what it opens.
    this.micGeneration++;
    this.stopVoice();
    this.runtime.stopLipSync();
    this.mic = false;
    this.micDevice = undefined;
    this.micStream = undefined;
    this.micAdvanced = false;
    this.micLevel = undefined;
    this.lipSyncValue = undefined;
    this.events.emit('microphoneChanged', { on: false });
  }

  get microphoneOn(): boolean {
    return !!this.mic;
  }

  /** The stream the advanced lipsync follows now (tests check which one it is). */
  get voiceStreamInUse(): MediaStream | undefined {
    return this.voiceStream;
  }

  private mergeSources(now: number): TrackingFrame {
    const fresh = (s: FrameSource): TrackingFrame | undefined => {
      const x = this.sources[s];
      return x && Math.abs(now - x.t) <= LOST_AFTER_MS ? x : undefined;
    };
    const cam = fresh('webcam');
    const phone = fresh('phone');
    const order =
      this.app.facePriority === 'webcam'
        ? ([
            ['webcam', cam],
            ['phone', phone],
          ] as const)
        : ([
            ['phone', phone],
            ['webcam', cam],
          ] as const);
    const pick = order.find(([, x]) => x?.face) ?? order.find(([, x]) => x);
    this.faceSource = pick?.[0];
    const face = pick?.[1] ?? cam ?? phone!;
    const { hands: _h, ...rest } = face;
    // Hands come from the webcam only (a phone tracks the face).
    return { ...rest, t: now, ...(cam?.hands ? { hands: cam.hands } : {}) };
  }

  /** Which source's face wins when both a phone and the webcam see it (app-wide). */
  setFacePriority(priority: FrameSource): void {
    this.app = { ...this.app, facePriority: priority };
    void this.store.putApp(this.app);
    this.events.emit('appSettingsChanged', this.app);
  }

  /** The latest frame of each tracking source. */
  private sources: Partial<Record<FrameSource, TrackingFrame>> = {};
  /** Where the face comes from now, or undefined without any source. */
  faceSource: FrameSource | undefined;

  /**
   * Feeds one tracking frame (from the camera, a phone, a replay or a test).
   * With a phone and the webcam both sending, the face comes from the one
   * the person prefers (the phone by default) while it sees the face, and
   * from the other while that one sees it; the webcam's hands come along.
   */
  feedFrame(input: TrackingFrame, source: FrameSource = 'webcam'): void {
    this.sources[source] = input;
    const f = this.mergeSources(input.t);
    this.latest = f;
    if (f.face) {
      this.lastFaceAt = f.t;
      if (!this.faceVisible) {
        this.faceVisible = true;
        this.events.emit('trackingFound', undefined);
      }
    } else if (this.faceVisible && f.t - this.lastFaceAt > LOST_AFTER_MS) {
      this.faceVisible = false;
      this.events.emit('trackingLost', undefined);
    }
    if (this.calibrating && f.face && this.pipeline)
      this.calibrating.add(this.pipeline.filteredInputs(f));
    this.recording?.push(structuredClone(f));
  }

  /** Counts down, then samples the neutral pose for `sampleMs`. */
  async calibrate(countdownS = 3, sampleMs = 1500): Promise<boolean> {
    for (let s = countdownS; s > 0; s--) {
      this.events.emit('calibration', { state: 'counting', secondsLeft: s });
      await new Promise((r) => setTimeout(r, 1000));
    }
    this.events.emit('calibration', { state: 'sampling' });
    this.calibrating = new CalibrationRecorder();
    await new Promise((r) => setTimeout(r, sampleMs));
    const rec = this.calibrating;
    this.calibrating = undefined;
    if (rec.samples < 5) {
      this.events.emit('calibration', { state: 'failed' });
      return false;
    }
    this.updateSettings({ calibration: rec.result() });
    this.events.emit('calibration', { state: 'done' });
    return true;
  }

  clearCalibration(): void {
    this.updateSettings({ calibration: {} });
  }

  /** Developer tool: records tracking values (never video) in memory. */
  startRecording(): void {
    this.recording = [];
  }
  stopRecording(): TrackingRecording | undefined {
    const frames = this.recording;
    this.recording = undefined;
    if (!frames) return undefined;
    const t0 = frames[0]?.t ?? 0;
    return {
      format: 'mochi-studio/tracking-recording',
      version: 1,
      source: `Recorded with Mochi Studio on ${new Date().toISOString().slice(0, 10)}`,
      frames: frames.map((f) => ({ ...f, t: Math.round(f.t - t0) })),
    };
  }
  get recordingActive(): boolean {
    return !!this.recording;
  }

  // --- expressions, motions, items, hotkeys --------------------------------

  /** An expression on or off; `fade` (seconds) replaces its file's fades, as plugins ask. */
  setExpression(name: string, on: boolean, fade?: number): void {
    if (on) this.hotkeys.activeExpressions.add(name);
    else this.hotkeys.activeExpressions.delete(name);
    this.runtime.setExpression(name, on, fade);
    this.sync?.post({ type: 'expression', name, on, ...(fade === undefined ? {} : { fade }) });
    this.events.emit('expressionsChanged', { expressions: [...this.hotkeys.activeExpressions] });
  }
  /** Playing motions and active expressions, with the parameters they write. */
  activeAnimations(): ActiveAnimations {
    return this.runtime.activeAnimations?.() ?? { motions: [], expressions: [] };
  }
  get activeExpressions(): ReadonlySet<string> {
    return this.hotkeys.activeExpressions;
  }
  playMotion(motion: MotionRef, mode: 'once' | 'hold'): void {
    this.runtime.playMotion(motion, mode);
    this.sync?.post({ type: 'motion', motion, mode });
  }
  setItemVisible(item: string, visible: boolean): void {
    this.runtime.setItemVisible(item, visible);
    this.sync?.post({ type: 'item', item, visible });
    if (this.settings)
      this.updateSettings({
        items: this.items.map((i) => (i.id === item ? { ...i, visible } : i)),
      });
  }
  fireHotkey(id: string): void {
    const h = this.settings?.hotkeys.find((x) => x.id === id);
    if (!h) return;
    this.hotkeys.fire(h);
    this.events.emit('hotkeyFired', { hotkey: h });
  }
  /** The hotkey's keys or button were released ("while held" hotkeys turn off). */
  releaseHotkey(id: string): void {
    const h = this.settings?.hotkeys.find((x) => x.id === id);
    if (!h || !this.hotkeys.heldHotkeys.has(id)) return;
    this.hotkeys.release(h);
    this.events.emit('hotkeyReleased', { hotkey: h });
  }
  get heldHotkeys(): ReadonlySet<string> {
    return this.hotkeys.heldHotkeys;
  }

  // --- items ---------------------------------------------------------------

  get items(): ItemEntry[] {
    return this.settings?.items ?? [];
  }

  /** Adds an item (a model folder or zip) to the current model. */
  /**
   * Adds an item. `file` names its source for plugins (default: the folder or
   * zip name); a `temporary` item's files are not stored (a plugin's, for
   * this session only, until the person keeps it).
   */
  async addItem(
    files: ModelFileSet,
    opts: { file?: string; temporary?: boolean; placement?: ItemPlacement; visible?: boolean } = {},
  ): Promise<string> {
    if (!this.settings) throw new Error('Load a model first.');
    const entries = await Promise.all(
      files.paths().map(async (p): Promise<[string, Uint8Array]> => [p, await files.read(p)]),
    );
    const id = newItemId(this.items.map((i) => i.id));
    const visible = opts.visible ?? true;
    // The files are stored first: once the runtime draws the item, the settings list it
    // in the same step, with no wait between (a test once read the
    // runtime's list while this waited for IndexedDB, and found no new id in the settings).
    if (!opts.temporary) await this.itemFiles.put(id, entries);
    try {
      await this.runtime.addItem(id, new MemoryFileSet(files.label, entries), {
        visible,
        ...(opts.placement ? { placement: opts.placement } : {}),
      });
    } catch (e) {
      if (!opts.temporary) await this.itemFiles.delete(id).catch(() => undefined);
      throw e;
    }
    this.itemFilesForSync.set(id, entries);
    this.registerAnimation(id, entries, undefined);
    const label = (files.label.split('/').pop() ?? files.label).replace(/\.zip$/i, '');
    this.updateSettings({
      items: [
        ...this.items,
        {
          id,
          label,
          visible,
          pinned: false,
          file: opts.file ?? label,
          ...(opts.temporary ? { temporary: true } : {}),
        },
      ],
    });
    this.saveItems();
    this.broadcastItems();
    return id;
  }

  // --- web items ---------------------------------------------------

  /** Whether web items can run here: the desktop app renders their pages. */
  get webItemsAvailable(): boolean {
    return !!desktopApi()?.startWebItem;
  }

  /** Adds a web item: a transparent picture of the page's size, which the page's frames replace. */
  async addWebItem(src: WebItemSource, label?: string): Promise<string> {
    const ok = parseWebItem(src);
    if (!ok) throw new Error('A web item needs an http or https address.');
    const canvas = new OffscreenCanvas(ok.width, ok.height);
    pngContext(canvas);
    const png = await canvasPng(canvas);
    const name = label || new URL(ok.url).hostname;
    const id = await this.addItem(
      new MemoryFileSet(name, imageItemFiles(png, ok.width, ok.height, { name, flipped: false })),
      { file: ok.url },
    );
    this.updateSettings({ items: this.items.map((i) => (i.id === id ? { ...i, web: ok } : i)) });
    await this.startWebItem(id, ok);
    return id;
  }

  private webFrameHooked = false;
  /** Web item frames received (for tests). */
  webItemFrames = 0;
  private webSent = new Map<string, number>();
  private async startWebItem(id: string, src: WebItemSource): Promise<void> {
    const desk = desktopApi();
    if (!desk?.startWebItem) return;
    if (!this.webFrameHooked && desk.onWebItemFrame) {
      this.webFrameHooked = true;
      desk.onWebItemFrame((wid, f) => void this.webItemFrame(wid, f));
    }
    const r = await desk.startWebItem({ id, ...src });
    if (r?.error) this.events.emit('error', { message: r.error });
  }

  /** A web item's frame: into its texture, and (WebP, at most its rate) to output views. */
  private async webItemFrame(
    id: string,
    f: { width: number; height: number; data: Uint8Array },
  ): Promise<void> {
    this.webItemFrames++;
    const src = this.items.find((i) => i.id === id)?.web;
    if (!src) return;
    const px = new Uint8ClampedArray(f.data.length);
    px.set(bgraToRgba(new Uint8Array(f.data)));
    const img = new ImageData(px, f.width, f.height);
    // The texture is the page's size in CSS pixels; a high-density screen's frames are larger.
    const bmp =
      f.width === src.width && f.height === src.height
        ? img
        : await createImageBitmap(img, {
            resizeWidth: src.width,
            resizeHeight: src.height,
            premultiplyAlpha: 'none',
          });
    this.runtime.updateItemTexture(id, bmp);
    // Kept for views that open later (a still page paints only once); sent at its rate.
    this.webLast.set(id, bmp);
    if (!this.views.size) return;
    const now = performance.now();
    if (now - (this.webSent.get(id) ?? 0) < 1000 / src.fps - 5) return;
    this.webSent.set(id, now);
    await this.postWebFrame(id);
  }

  /** Each web item's latest frame, for output views that open later. */
  private webLast = new Map<string, ImageBitmap | ImageData>();

  /** Sends a web item's latest frame to output views, as WebP. */
  private async postWebFrame(id: string): Promise<void> {
    const img = this.webLast.get(id);
    const src = this.items.find((i) => i.id === id)?.web;
    if (!img || !src || !this.sync) return;
    const c = new OffscreenCanvas(src.width, src.height);
    c.getContext('2d')!.drawImage(
      img instanceof ImageData ? await createImageBitmap(img) : img,
      0,
      0,
    );
    const bytes = new Uint8Array(
      await (await c.convertToBlob({ type: 'image/webp', quality: 0.8 })).arrayBuffer(),
    );
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000)
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    this.sync.post({ type: 'itemTexture', id, webp: btoa(bin) });
  }

  private stopWebItems(): void {
    for (const i of this.items) if (i.web) void desktopApi()?.stopWebItem?.(i.id);
  }

  /** Keeps a plugin's session-only item: its files are stored like any other item's. */
  async keepItem(id: string): Promise<void> {
    const entries = this.itemFilesForSync.get(id);
    if (!entries) return;
    await this.itemFiles.put(id, entries);
    this.updateSettings({
      items: this.items.map((i) => {
        if (i.id !== id) return i;
        const { temporary: _t, ...rest } = i;
        return rest;
      }),
    });
  }

  /** Locks an item on the stage (or unlocks it): a locked item cannot be dragged. */
  setItemLocked(id: string, locked: boolean): void {
    this.updateSettings({
      items: this.items.map((i) => (i.id === id ? { ...i, locked: locked || undefined } : i)),
    });
  }

  /** The item's stored files (for example to flip an image item). */
  async itemFilesOf(id: string): Promise<Array<[string, Uint8Array]> | undefined> {
    return this.itemFilesForSync.get(id) ?? (await this.itemFiles.get(id).catch(() => undefined));
  }

  /** Replaces an item's files, keeping its place, pin and visibility. */
  async replaceItemFiles(id: string, entries: Array<[string, Uint8Array]>): Promise<void> {
    const entry = this.items.find((i) => i.id === id);
    if (!entry) return;
    const pinned = this.runtime.items().find((i) => i.id === id);
    await this.runtime.addItem(id, new MemoryFileSet(entry.label, entries), {
      visible: entry.visible,
      ...(pinned ? { placement: pinned.placement } : {}),
    });
    if (pinned?.pinned) this.runtime.pinItem(id, true);
    if (!entry.temporary) await this.itemFiles.put(id, entries);
    this.itemFilesForSync.set(id, entries);
    this.saveItems();
    this.broadcastItems();
  }

  removeItem(id: string): void {
    void desktopApi()?.stopWebItem?.(id);
    this.webLast.delete(id);
    this.animator.remove(id);
    this.itemFades.delete(id);
    if (this.itemTints.delete(id)) this.broadcastTints();
    this.runtime.removeItem(id);
    this.itemFilesForSync.delete(id);
    void this.itemFiles.delete(id);
    this.updateSettings({
      items: this.items.filter((i) => i.id !== id),
      hotkeys: (this.settings?.hotkeys ?? []).filter(
        (h) => !(h.action.type === 'item' && h.action.item === id),
      ),
    });
    this.saveItems();
    this.broadcastItems();
  }

  renameItem(id: string, label: string): void {
    this.updateSettings({ items: this.items.map((i) => (i.id === id ? { ...i, label } : i)) });
  }

  placeItem(id: string, placement: Partial<ItemPlacement>): void {
    this.runtime.placeItem(id, placement);
    this.saveItems();
  }

  /** Where a plugin put an item among the model's art meshes, and its split (null: drawn whole on its side). */
  itemSort(id: string): ReturnType<AvatarRuntime['itemSort']> {
    return this.runtime.itemSort(id);
  }

  /** Draws an item whole on its side of the model again (after a plugin put it between layers). */
  drawItemWhole(id: string): void {
    const front = this.runtime.items().find((i) => i.id === id)?.placement.front ?? true;
    this.runtime.setItemSort(id, front ? 'front' : 'behind', null);
    this.saveItems();
  }

  /** Tells output views where the items are now, without saving (for moves and fades as they go). */
  postItemLayout(): void {
    if (this.views.size)
      this.sync?.post({ type: 'itemLayout', layout: this.runtime.exportItemLayout() });
  }

  /** Saves the runtime's item state (placements, pins) after changes made on the runtime directly. */
  commitItems(): void {
    this.saveItems();
  }

  pinItem(id: string, pinned: boolean): boolean {
    const ok = this.runtime.pinItem(id, pinned);
    this.saveItems();
    return ok;
  }

  /** Copies the runtime's item state into the settings, saves, and tells output views. */
  private saveItems(): void {
    if (!this.settings) return;
    const state = new Map(this.runtime.items().map((i) => [i.id, i]));
    const items = this.items.map((i) => {
      const r = state.get(i.id);
      return r ? { ...i, visible: r.visible, placement: r.placement, pinned: r.pinned } : i;
    });
    const itemLayout = this.runtime.exportItemLayout();
    this.updateSettings({ items, itemLayout });
    this.events.emit('itemsChanged', { items });
    this.sync?.post({ type: 'itemLayout', layout: itemLayout });
  }

  /** Loads the current model's stored items into the runtime. */
  private async restoreItems(): Promise<void> {
    const s = this.settings;
    if (!s) return;
    const missing: string[] = [];
    for (const item of s.items) {
      const files = await this.itemFiles.get(item.id).catch(() => undefined);
      if (!files?.length) {
        missing.push(item.label);
        continue;
      }
      try {
        await this.runtime.addItem(item.id, new MemoryFileSet(item.label, files), {
          visible: item.visible,
          placement: item.placement,
        });
        this.itemFilesForSync.set(item.id, files);
        this.registerAnimation(item.id, files, item.animation);
      } catch (e) {
        missing.push(item.label);
        console.warn(e);
      }
    }
    if (s.itemLayout) this.runtime.applyItemLayout(s.itemLayout);
    for (const item of s.items) this.runtime.setItemVisible(item.id, item.visible);
    // Web items' pages again (desktop app).
    for (const item of s.items)
      if (item.web && !missing.includes(item.label)) void this.startWebItem(item.id, item.web);
    if (missing.length)
      this.events.emit('error', {
        message: `Some items could not be restored: ${missing.join(', ')}. Add them again.`,
      });
  }

  // --- frame loop ----------------------------------------------------------

  /**
   * Starts the frame loop: animation frames while the window is drawn, a
   * worker's ticks while it is hidden or minimized, so output views keep
   * getting the parameters (src/web/frameClock.ts).
   */
  start(): void {
    this.clock ??= new FrameClock((now, draw) => this.frame(now, draw));
    this.clock.start();
  }

  stop(): void {
    this.clock?.stop();
  }

  /** The mouse and controller inputs of this frame; controller triggers become `padTrigger` events. */
  private otherInputs(): InputValues {
    const pads =
      typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
    const names = pads
      .filter((p): p is Gamepad => !!p && p.connected)
      .map((p) => p.id)
      .join('\n');
    if (names !== this.padNames) {
      this.padNames = names;
      this.events.emit('controllersChanged', { names: names ? names.split('\n') : [] });
    }
    const c = this.controllerReader.read(
      pads as ReadonlyArray<PadLike | null>,
      this.app.controller,
    );
    for (const code of this.padHeld)
      if (!c.pressed.has(code)) {
        this.padHeld.delete(code);
        this.events.emit('padTrigger', { code, down: false });
      }
    for (const code of c.pressed)
      if (!this.padHeld.has(code)) {
        this.padHeld.add(code);
        this.events.emit('padTrigger', { code, down: true });
      }
    return { ...this.pointer.values(this.app.mouseRange), ...c.inputs };
  }

  /** Where the mouse inputs come from: anywhere on the screen (the desktop app), or the page. */
  get pointerScope(): 'screen' | 'page' {
    return this.pointer.scope;
  }

  // --- the display light overlay ----------------------------------

  /** Where the light's color comes from while it is on: a capture, or the static color. */
  private lightSource: LightSource | undefined;

  /** Starts capturing a screen or window (the browser, or the desktop app, asks which). */
  async startLightOverlay(hint?: { window: boolean; sourceId?: string }): Promise<void> {
    await this.lightCapture.start(hint);
    this.lightCapture.onEnded = () => this.stopLightOverlay();
    this.lightSmoother.reset();
    this.lightSource = 'capture';
    this.events.emit('lightOverlayChanged', { active: true });
  }

  /** The static color instead of a capture: the settings' `staticColor`. */
  startStaticLight(): void {
    this.lightCapture.stop();
    this.lightSmoother.reset();
    this.lightSource = 'static';
    this.lastLightAt = 0;
    this.events.emit('lightOverlayChanged', { active: true });
  }

  stopLightOverlay(): void {
    this.lightCapture.stop();
    this.lightSource = undefined;
    this.lightNow = undefined;
    this.applyLight();
    this.events.emit('lightOverlayChanged', { active: false });
  }

  get lightOverlayOn(): boolean {
    return this.lightSource !== undefined;
  }
  /** The light's source while it is on. */
  get lightOverlaySource(): LightSource | undefined {
    return this.lightSource;
  }

  /** What the light does now, for a «Screen Overlay» hotkey (Record settings). */
  recordScreenOverlay(): ScreenOverlayAction {
    return {
      on: this.lightSource !== undefined,
      source: this.lightSource ?? 'capture',
      settings: parseLightOverlay(this.app.lightOverlay),
    };
  }

  /**
   * A «Screen Overlay» hotkey: off; or its settings, with the
   * static color; or with a capture, which only the person can start (a
   * browser asks which screen), so a capture hotkey applies its settings and
   * lights the model while a capture runs.
   */
  applyScreenOverlay(a: ScreenOverlayAction): void {
    if (!a.on) return this.stopLightOverlay();
    this.setLightOverlaySettings(a.settings);
    if (a.source === 'static') this.startStaticLight();
  }

  /** The overlay now (undefined while it is off, or before the first picture). */
  get lightOverlay(): OverlayState | undefined {
    return this.lightNow;
  }

  setLightOverlaySettings(patch: Partial<LightOverlaySettings>): void {
    this.app = {
      ...this.app,
      lightOverlay: parseLightOverlay({ ...this.app.lightOverlay, ...patch }),
    };
    void this.store.putApp(this.app);
    this.events.emit('appSettingsChanged', this.app);
    this.applyLight();
  }

  /** About ten samples a second while the light is on. */
  private stepLight(now: number): void {
    if (!this.lightSource || now - this.lastLightAt < 100) return;
    const dt = this.lastLightAt ? (now - this.lastLightAt) / 1000 : 0;
    this.lastLightAt = now;
    const s = this.app.lightOverlay;
    const c = s.staticColor;
    const parts =
      this.lightSource === 'static'
        ? { left: [...c] as Rgb, middle: [...c] as Rgb, right: [...c] as Rgb }
        : this.lightCapture.sample();
    if (!parts) return;
    const average = this.lightSmoother.step(activeAverage(parts, s.parts), dt, s.smoothing);
    this.lightNow = {
      active: true,
      isWindowCapture: this.lightSource === 'capture' && this.lightCapture.isWindow,
      settings: s,
      parts,
      average,
      overlay: overlayColor(average, s),
    };
    this.applyLight();
  }

  private lightMessage(): Extract<SyncMessage, { type: 'light' }> {
    const st = this.lightNow;
    const strengths = this.settings?.lightStrengths ?? {};
    return st
      ? {
          type: 'light',
          rgb: overlayTint(st.overlay),
          items: this.app.lightOverlay.items,
          ...(Object.keys(strengths).length ? { strengths } : {}),
        }
      : { type: 'light', rgb: null, items: false };
  }

  /** Gives the renderer and output views the overlay's color, when it changed. */
  private applyLight(): void {
    if (this.lightNow)
      this.lightNow.overlay = overlayColor(this.lightNow.average, this.app.lightOverlay);
    const m = this.lightMessage();
    const key = JSON.stringify([m.rgb?.map((c) => Math.round(c * 1000)), m.items, m.strengths]);
    if (key === this.sentLight) return;
    this.sentLight = key;
    this.runtime.setLight(m.rgb ?? undefined, m.items, m.strengths);
    this.sync?.post(m);
  }

  /** The controllers connected now, by name (`Gamepad.id`). */
  get controllers(): string[] {
    return this.padNames ? this.padNames.split('\n') : [];
  }

  /** Which controllers are read (app-wide): none, all, or one by name. */
  setController(choice: ControllerChoice): void {
    this.app = { ...this.app, controller: choice };
    void this.store.putApp(this.app);
    this.events.emit('appSettingsChanged', this.app);
  }

  /** Desktop app: the screen the mouse ranges are centred on (undefined: the main one). */
  setMouseScreen(id: number | undefined): void {
    const { mouseScreen: _old, ...rest } = this.app;
    this.app = id === undefined ? rest : { ...rest, mouseScreen: id };
    this.pointer.setScreen(id);
    void this.store.putApp(this.app);
    this.events.emit('appSettingsChanged', this.app);
  }

  /** The desktop app's screens, for that choice (none in a browser). */
  screens(): Promise<DesktopScreen[]> {
    return this.pointer.screens();
  }

  /** The mouse inputs' X and Y ranges in pixels (0: the whole screen or page). */
  setMouseRange(range: MouseRange): void {
    this.app = { ...this.app, mouseRange: parseMouseRange(range) };
    void this.store.putApp(this.app);
    this.events.emit('appSettingsChanged', this.app);
  }

  /** The controller's current orientation becomes zero. */
  resetControllerOrientation(): void {
    this.controllerReader.resetOrientation();
  }

  /** Frames run while the window was out of sight (no animation frames). */
  get backgroundFrames(): number {
    return this.clock?.ticked ?? 0;
  }

  /**
   * One frame. Public so tests can drive time. With `draw` false (the window
   * is out of sight) everything moves on as usual, and the output views and
   * plugins get this frame's values, but the canvas is not drawn: the next
   * frame of a shown window draws the current state (Mochi2D 0.18.0).
   */
  frame(now: number, draw = true): void {
    if (!this.limiter.shouldRender(now)) return;
    const dt = this.lastRender ? Math.min(100, now - this.lastRender) : 16;
    this.lastRender = now;
    if (
      this.latest &&
      !this.latest.face &&
      now - this.lastFaceAt > LOST_AFTER_MS &&
      this.faceVisible
    ) {
      this.faceVisible = false;
      this.events.emit('trackingLost', undefined);
    }
    // Each step runs guarded: an error is logged (once while it repeats) and the frame
    // goes on, so the stage and the output views keep moving.
    const step = <T>(where: string, fn: () => T): T | undefined =>
      guard(this.frameError, where, fn);
    step('Hand tracking', () => this.stepHands(this.latest, now));
    step('The light overlay', () => this.stepLight(now));
    const voice = step('The voice', () => this.voiceFrame(now)) ?? {};
    step('The microphone', () => {
      this.micLevel = this.runtime.lipSyncLevel() ?? this.voiceReading?.level;
      this.lipSyncValue = this.runtime.lipSyncValue();
    });
    if (this.pipeline && this.model && this.settings)
      step('Tracking and parameters', () => this.stepParameters(now, dt, voice));
    step('Items', () => this.stepItems(now));
    for (const hook of this.frameHooks) step('Collaboration', () => hook(now, draw));
    step(draw ? 'Drawing' : 'Advancing', () => this.runtime.render(dt, draw));
    this.framesDrawn++;
    if (draw) this.framesPainted++;
    if (draw && !this.drawnSinceLoad && this.model) {
      this.drawnSinceLoad = true;
      this.mark('modelDrawn');
    }
  }

  /**
   * When startup got where: milliseconds since the
   * page's start (`performance.now()`), the first time each happened.
   */
  readonly startup: Record<string, number> = {};
  private drawnSinceLoad = true;
  mark(name: string): void {
    this.startup[name] ??= Math.round(performance.now());
  }

  /** A frame step failed: to the log (Studio's `log` event), and the frame goes on. */
  private frameError = (where: string, e: unknown): void => {
    this.events.emit('log', { text: `${where}: ${errorText(e)}`, kind: 'error' });
  };

  /** Tracking, plugins, voice and overrides to the model's parameters, and to output views. */
  private stepParameters(
    now: number,
    dt: number,
    voice: { inputs?: Record<string, number>; shown?: Record<string, number> },
  ): void {
    if (!this.pipeline || !this.model || !this.settings) return;
    const mapped = this.pipeline.step(
      this.latest,
      now,
      this.plugins,
      voice.inputs,
      this.otherInputs(),
    );
    this.provided = new Set([...Object.keys(mapped), ...Object.keys(this.overrides)]);
    // Rules aimed at parameters physics overwrites move to the driving parameter.
    let params = redirectToDrivers(mapped, this.trackingRedirects, this.ranges);
    this.lastInputs = this.pipeline.lastInputs;
    const hands = `${this.lastInputs.HandLeftFound === 1 ? 1 : 0}${this.lastInputs.HandRightFound === 1 ? 1 : 0}`;
    if (hands !== this.handsFoundKey) {
      this.handsFoundKey = hands;
      this.events.emit('handsChanged', this.handsFound);
    }
    // Automatic blinking only while no face is tracked (a plugin may say it is found).
    const face = this.faceVisible || !!this.plugins?.faceFound(now);
    this.runtime.setEffect('eyeBlink', !face);
    if (this.sentBlink !== !face) {
      this.sentBlink = !face;
      this.sync?.post({ type: 'effects', eyeBlink: this.sentBlink });
    }
    // Mouth: Mochi2D combines its live lip sync with the base value we set.
    // An override of the mouth (an agent, a test) counts as the tracked value.
    const mouthId = this.runtime.lipSyncParameter ?? MOUTH_PARAM;
    const p = this.info?.parameters.find((x) => x.id === mouthId);
    const range = { min: p?.min ?? 0, max: p?.max ?? 1 };
    const tracked = mouthId in this.overrides ? this.overrides[mouthId] : params[mouthId];
    const mix = mixMouth(tracked, this.lipSyncValue, this.settings.lipSync, range);
    this.runtime.setLipSyncGain(mix.liveGain);
    this.runtime.setLipSyncMix(mix.mix);
    Object.assign(params, this.overrides);
    if (mix.base === undefined) delete params[mouthId];
    else params[mouthId] = mix.base;
    if (!(MOUTH_FORM_PARAM in this.overrides)) this.shapeMouth(params, dt);
    // What is written keeps the idle animation off; handovers fade (held values included).
    const h = this.handover.step(params, (id) => this.defaults.get(id), dt);
    params = h.values;
    if (Object.keys(h.weights).length) {
      this.runtime.setIdleWeights(h.weights);
      if (this.views.size) this.sync?.post({ type: 'idleWeights', weights: h.weights });
    }
    this.runtime.setParameters(params);
    // What is shown: the mouth with lip sync included (output views have no microphone).
    const shown = { ...params };
    if (mix.value !== undefined) shown[mouthId] = mix.value;
    // The model's motion sync writes its mouth parameters itself: output views get them.
    if (voice.shown) Object.assign(shown, voice.shown);
    this.lastParams = shown;
    const changed = this.differ.diff(shown);
    if (changed && this.views.size)
      this.sync?.post({ type: 'params', values: changed.values, removed: changed.removed });
  }

  /** Animated items, item fades and plugins' physics overrides. */
  private stepItems(now: number): void {
    // Animated items step on the control window's clock, in real time even when frames
    // are slow (the 2 fps cap while a view loads); output views show the same frames.
    const animDt = this.lastAnimAt ? now - this.lastAnimAt : 0;
    this.lastAnimAt = now;
    const frames = this.animator.tick(animDt);
    if (frames.length) {
      for (const [id, f] of frames) this.runtime.setItemFrame(id, f);
      if (this.views.size) this.sync?.post({ type: 'itemFrames', frames });
    }
    if (this.itemFades.size) this.stepItemFades(now);
    // Plugins' physics overrides run out on their own timers.
    if (this.physicsWatched) {
      this.applyPhysics(now);
      this.physicsWatched = this.physicsOverriddenBy !== undefined;
    }
  }

  // --- output views --------------------------------------------------------

  get outputViewCount(): number {
    return this.views.size;
  }

  /** The ids of the connected output views. */
  get outputViewIds(): string[] {
    return [...this.views.keys()];
  }

  /** How loading goes in each output view (they report it; OBS captures the view itself). */
  readonly viewStatus = new Map<string, Extract<SyncMessage, { type: 'viewStatus' }>>();

  /** Views loading a model now, with when they started (for the frame cap below). */
  private loadingViews = new Map<string, number>();
  /** The control window's frame cap while an output view loads (0: no change). */
  loadingViewFps = 2;

  /**
   * The frame cap: the stage's, but at most `loadingViewFps` while an output
   * view loads a model. Pages of one browser share its GPU process, and with
   * software WebGL the control window's drawing held a loading view back
   * (measured: 12 s instead of 5 s); a view in OBS loads as fast either way.
   */
  private updateFrameCap(): void {
    const now = Date.now();
    for (const [id, since] of this.loadingViews)
      if (now - since > LOADING_VIEW_MAX_MS) this.loadingViews.delete(id);
    const cap = this.stage.fpsCap;
    const low = this.loadingViewFps;
    this.limiter.fps =
      this.loadingViews.size && low > 0 ? (cap > 0 ? Math.min(cap, low) : low) : cap;
  }

  private onSync(m: SyncMessage): void {
    if (m.type === 'viewStatus') {
      if (!this.views.has(m.viewId)) {
        // A view open before this window (re)loaded: it never said hello here, and items go
        // only to views this window knows. It gets them all now.
        this.views.set(m.viewId, Date.now());
        this.itemsSentToViews.clear();
        this.broadcastItems();
      }
      this.viewStatus.set(m.viewId, m);
      if (m.state === 'loading') {
        if (!this.loadingViews.has(m.viewId)) this.loadingViews.set(m.viewId, Date.now());
      } else this.loadingViews.delete(m.viewId);
      // A view that has its model now gets every parameter again, not only the changes.
      if (m.state === 'ready') this.differ.reset();
      this.updateFrameCap();
      this.events.emit('outputViews', { count: this.views.size });
      return;
    }
    if (m.type === 'bye') {
      this.views.delete(m.viewId);
      this.avatarViews.delete(m.viewId);
      this.viewStatus.delete(m.viewId);
      this.loadingViews.delete(m.viewId);
      this.updateFrameCap();
      this.events.emit('outputViews', { count: this.views.size });
      return;
    }
    if (m.type === 'viewLog') {
      this.events.emit('log', { text: m.text.slice(0, 300), kind: 'error' });
      return;
    }
    if (m.type !== 'hello') return;
    this.views.set(m.viewId, Date.now());
    if (m.avatar) this.avatarViews.add(m.viewId);
    this.sentBlink = undefined;
    this.events.emit('outputViews', { count: this.views.size });
    this.differ.reset();
    this.broadcastModel();
  }

  /** Sends the model, items and stage to output views again (and lets the bridge upload them). */
  resendToViews(): void {
    this.broadcastModel();
  }

  private broadcastModel(): void {
    if (!this.sync || !this.model) return;
    // No view known: the model's files would be copied for nobody. A view that is there all
    // the same (open before this window loaded) answers this with hello, and gets them.
    if (!this.views.size) {
      this.itemsSentToViews.clear();
      this.sync.post({ type: 'modelAvailable', key: this.model.key });
      return;
    }
    // Views load the model (and its items) again: they get every item's files.
    this.itemsSentToViews.clear();
    this.sync.post({
      type: 'model',
      key: this.model.key,
      label: this.model.files.label,
      files: this.modelFilesForSync,
    });
    this.broadcastStage();
    this.broadcastItems();
    if (this.ownExpressionList.length)
      this.sync.post({ type: 'ownExpressions', list: this.ownExpressionList });
    this.sync.post({
      type: 'toggles',
      expressions: [...this.hotkeys.activeExpressions],
      items: this.items.filter((i) => this.runtime.isItemVisible(i.id)).map((i) => i.id),
    });
    const s = this.settings;
    const idle = s?.idleMotion && this.model.files.has(s.idleMotion) ? s.idleMotion : undefined;
    this.sentIdle = idle;
    this.sync.post({ type: 'idle', file: idle });
    this.sync.post({ type: 'idleWeights', weights: this.handover.weights(), all: true });
    this.broadcastTints();
    this.sync.post({ type: 'itemFrames', frames: this.animator.frames() });
    if (this.appliedPhysics)
      this.sync.post({ type: 'physics', values: JSON.parse(this.appliedPhysics) });
    this.sync.post(this.lightMessage());
    for (const id of this.webLast.keys()) void this.postWebFrame(id);
    this.differ.reset();
  }

  // --- physics strength and wind ---------------------------------

  /** The model's physics groups (its physics settings): ID and name, in file order. */
  physicsGroups(): ReadonlyArray<{ id: string; name: string; named: boolean }> {
    return this.model ? this.runtime.physicsSettings() : [];
  }

  /** The physics values in effect: the person's settings, with plugins' overrides in their place. */
  physicsInEffect(now = performance.now()): EffectivePhysics | undefined {
    const s = this.settings;
    if (!s) return undefined;
    return effectivePhysics(
      s.physicsTuning,
      this.physicsGroups().map((g) => g.id),
      this.physicsOverrides.values(now),
    );
  }

  /** Gives the renderer and the output views the physics values in effect, when they changed. */
  private applyPhysics(now = performance.now()): void {
    const e = this.physicsInEffect(now);
    if (!e) return;
    const v = physicsValues(e);
    const key = JSON.stringify(v);
    const by = this.physicsOverrides.controller(now)?.name;
    const changed = key !== this.appliedPhysics;
    if (changed) {
      this.appliedPhysics = key;
      this.runtime.setPhysicsValues(v);
      this.sync?.post({ type: 'physics', values: v });
    }
    if (changed || by !== this.physicsOverriddenBy) {
      this.physicsOverriddenBy = by;
      this.events.emit('physicsChanged', { overriddenBy: by });
    }
  }

  /** A plugin's physics overrides; a refusal names the error. */
  overridePhysics(
    plugin: OverridingPlugin,
    data: Record<string, unknown>,
    now = performance.now(),
  ): OverrideRefusal | undefined {
    const refused = this.physicsOverrides.apply(
      plugin,
      data,
      this.physicsGroups().map((g) => g.id),
      now,
    );
    if (refused) return refused;
    this.physicsWatched = true;
    this.applyPhysics(now);
    return undefined;
  }

  /** A plugin's session ended: its physics overrides end with it. */
  endPhysicsOverrides(session: string): void {
    if (this.physicsOverrides.endSession(session)) this.applyPhysics();
  }

  // --- the expression editor ---------------------------------------

  /**
   * Reads the model's own expressions (the settings' list): the text kept in
   * the settings (browser), a file saved this session, or the file in the
   * model folder (desktop). Broken or missing ones are left out.
   */
  private async loadOwnExpressions(announce = true): Promise<void> {
    const s = this.settings;
    const m = this.model;
    if (!s || !m) return;
    const list: Array<{ name: string; file: string; json: string }> = [];
    for (const o of s.ownExpressions) {
      let json = o.json ?? this.savedExpressionFiles.get(o.file);
      if (json === undefined && m.files.has(o.file))
        json = await m.files
          .read(o.file)
          .then((b) => new TextDecoder().decode(b))
          .catch(() => undefined);
      if (json === undefined) continue;
      try {
        draftFromFile(o.name, json);
      } catch {
        continue;
      }
      list.push({ name: o.name, file: o.file, json });
    }
    this.ownExpressionList = list;
    this.runtime.setOwnExpressions(
      list.map((o) => ({ name: o.name, file: o.file, bytes: new TextEncoder().encode(o.json) })),
    );
    if (announce) {
      this.sync?.post({ type: 'ownExpressions', list });
      this.events.emit('expressionListChanged', undefined);
    }
  }

  /** The desktop app saves expressions into the model folder; the browser keeps them in the settings. */
  get savesExpressionsToFolder(): boolean {
    return this.model?.files instanceof DiskFileSet;
  }

  /** Whether an expression of the model was made or changed in the editor. */
  ownExpression(file: string): OwnExpression | undefined {
    return this.settings?.ownExpressions.find((o) => o.file === file);
  }

  /** The text of one of the model's expressions (its own file, or the editor's version). */
  async expressionText(file: string): Promise<string> {
    const m = this.model;
    if (!m) throw new Error('Load a model first.');
    const own = this.ownExpressionList.find((o) => o.file === file);
    if (own) return own.json;
    return new TextDecoder().decode(await m.files.read(file));
  }

  /** An expression of the model as a draft for the editor. */
  async expressionDraft(name: string): Promise<{ draft: ExpressionDraft; file: string }> {
    const e = this.model?.manifest.expressions.find((x) => x.name === name);
    if (!e) throw new Error(`The model has no expression named “${name}”.`);
    return { draft: draftFromFile(e.name, await this.expressionText(e.file)), file: e.file };
  }

  /**
   * Saves an expression: on the desktop into the model folder (as the
   * familiar editor does), in the browser into the model's settings. Without
   * `file`, a new file next to the model's other expressions. Returns the file.
   */
  async saveExpression(draft: ExpressionDraft, file?: string): Promise<string> {
    const s = this.settings;
    const m = this.model;
    if (!s || !m) throw new Error('Load a model first.');
    const name = draft.name.trim().slice(0, 100);
    if (!name) throw new Error('Give the expression a name.');
    const expressions = m.manifest.expressions;
    const target =
      file ??
      newExpressionFile(
        name,
        expressions.map((e) => e.file),
        new Set([
          ...m.files.paths(),
          ...expressions.map((e) => e.file),
          ...s.ownExpressions.map((o) => o.file),
        ]),
      );
    const original = expressions.find((e) => e.file === target);
    if (!original && expressions.some((e) => e.name === name))
      throw new Error(`The model already has an expression named “${name}”. Choose another name.`);
    const json = expressionFileText({ ...draft, name });
    let entry: OwnExpression;
    if (m.files instanceof DiskFileSet) {
      await m.files.write(target, new TextEncoder().encode(json));
      this.savedExpressionFiles.set(target, json);
      entry = { file: target, name: original?.name ?? name };
    } else entry = { file: target, name: original?.name ?? name, json };
    this.updateSettings({
      ownExpressions: [...s.ownExpressions.filter((o) => o.file !== target), entry],
    });
    await this.loadOwnExpressions();
    return target;
  }

  /**
   * Forgets an expression made or changed in the editor: a new one leaves
   * the model's list, a changed one is the model's own file again. On the
   * desktop the file stays in the model folder.
   */
  async removeOwnExpression(file: string): Promise<void> {
    const s = this.settings;
    const own = s?.ownExpressions.find((o) => o.file === file);
    if (!s || !own) return;
    // A new expression leaves the list: it is switched off first.
    if (!this.isBaseExpression(file) && this.activeExpressions.has(own.name))
      this.setExpression(own.name, false);
    this.savedExpressionFiles.delete(file);
    this.updateSettings({ ownExpressions: s.ownExpressions.filter((o) => o.file !== file) });
    await this.loadOwnExpressions();
  }

  /** Whether the model's own files list (or its folder holds, when it lists none) this expression. */
  isBaseExpression(file: string): boolean {
    return this.baseExpressionFiles.has(file);
  }

  /** Shows a draft on the model at once (this window only), or stops showing it. */
  previewExpression(draft: ExpressionDraft | undefined): void {
    this.runtime.previewExpression(
      draft
        ? new TextEncoder().encode(expressionFileText({ ...draft, fadeIn: 0, fadeOut: 0 }))
        : undefined,
    );
  }

  /** The model's expressions that no hotkey toggles. */
  expressionsWithoutHotkey(): string[] {
    return expressionsWithoutHotkey(
      this.model?.manifest.expressions ?? [],
      this.settings?.hotkeys ?? [],
    );
  }

  /** Makes a hotkey (no keys yet) for every expression that lacks one; returns how many. */
  createExpressionHotkeys(): number {
    const s = this.settings;
    if (!s) return 0;
    const names = this.expressionsWithoutHotkey();
    if (!names.length) return 0;
    const made = hotkeysForExpressions(names, new Set(s.hotkeys.map((h) => h.id)));
    this.updateSettings({ hotkeys: [...s.hotkeys, ...made] });
    return made.length;
  }

  private broadcastTints(): void {
    this.sync?.post({ type: 'tints', model: this.modelTints, items: this.itemTintsShown() });
  }

  /** Each item's tint as drawn: a plugin's tint, its opacity times a scene fade's. */
  private itemTintsShown(now = performance.now()): Array<[string, number[]]> {
    const ids = new Set([...this.itemTints.keys(), ...this.itemFades.keys()]);
    return [...ids].flatMap((id): Array<[string, number[]]> => {
      const t = this.itemTintShown(id, now);
      return t ? [[id, t]] : [];
    });
  }
  private itemTintShown(id: string, now = performance.now()): number[] | undefined {
    const base = this.itemTints.get(id);
    const f = this.itemFades.get(id);
    if (!f) return base;
    const k = f.ms > 0 ? Math.min(1, Math.max(0, (now - f.start) / f.ms)) : 1;
    const a = f.from + (f.to - f.from) * k;
    return [base?.[0] ?? 1, base?.[1] ?? 1, base?.[2] ?? 1, (base?.[3] ?? 1) * a];
  }

  /** The main model's tints by art-mesh ID, RGBA 0–1 (plugins' ColorTintRequest). */
  setModelTints(tints: Array<[string, number[]]>): void {
    this.modelTints = tints.map(([id, c]) => [id, [...c]]);
    this.runtime.setModelTints(this.modelTints);
    this.broadcastTints();
  }

  /** One tint over all of an item's art meshes, RGBA 0–1 (undefined: none). */
  setItemTint(id: string, rgba: number[] | undefined): void {
    if (rgba) this.itemTints.set(id, [...rgba]);
    else this.itemTints.delete(id);
    this.runtime.setItemTint(id, this.itemTintShown(id));
    this.broadcastTints();
  }

  // --- item scenes ---------------------------------------------------

  get itemScenes(): readonly ItemScene[] {
    return this.settings?.itemScenes ?? [];
  }
  isItemSceneOn(id: string): boolean {
    return this.activeScenes.has(id);
  }

  /** The items given, as they are placed now (pinned ones stay pinned). */
  private sceneItems(ids: readonly string[]): ItemSceneItem[] {
    const placed = new Map(this.runtime.items().map((i) => [i.id, i] as const));
    return ids
      .filter((id) => this.items.some((i) => i.id === id))
      .map((id) => {
        const r = placed.get(id);
        return r && !r.pinned ? { id, placement: { ...r.placement } } : { id };
      });
  }

  /** Makes a scene of the items given, where they are now; a group is optional. */
  createItemScene(name: string, group: string, itemIds: readonly string[]): ItemScene {
    const s = this.settings;
    if (!s) throw new Error('Load a model first.');
    const g = group.trim().slice(0, 64);
    const scene: ItemScene = {
      id: newSceneId(s.itemScenes.map((x) => x.id)),
      name: name.trim().slice(0, 100) || 'Scene',
      ...(g ? { group: g } : {}),
      items: this.sceneItems(itemIds),
    };
    this.updateSettings({ itemScenes: [...s.itemScenes, scene] });
    return scene;
  }

  /** Changes a scene's name, group or items (items are taken where they are now). */
  updateItemScene(id: string, patch: { name?: string; group?: string; items?: string[] }): void {
    const s = this.settings;
    if (!s) return;
    this.updateSettings({
      itemScenes: s.itemScenes.map((x) => {
        if (x.id !== id) return x;
        const g = (patch.group ?? x.group ?? '').trim().slice(0, 64);
        const { group: _old, ...rest } = x;
        return {
          ...rest,
          name: (patch.name ?? x.name).trim().slice(0, 100) || x.name,
          ...(g ? { group: g } : {}),
          items: patch.items ? this.sceneItems(patch.items) : x.items,
        };
      }),
    });
  }

  removeItemScene(id: string): void {
    const s = this.settings;
    if (!s) return;
    this.activeScenes.delete(id);
    this.updateSettings({ itemScenes: s.itemScenes.filter((x) => x.id !== id) });
    this.events.emit('itemScenesChanged', { active: [...this.activeScenes] });
  }

  /**
   * Turns an item scene on (its items show where the scene has them, and
   * the other scenes of its group turn off) or off, fading over `fade` seconds.
   */
  setItemScene(id: string, on: boolean, fade = 0): void {
    const s = this.settings;
    if (!s) return;
    const change = toggleScene(s.itemScenes, this.activeScenes, id, on);
    this.activeScenes = change.active;
    const ms = Math.max(0, Math.min(MAX_SCENE_FADE_S, fade)) * 1000;
    let moved = false;
    for (const it of change.show) {
      if (!this.items.some((i) => i.id === it.id)) continue;
      if (it.placement && !this.runtime.items().find((r) => r.id === it.id)?.pinned) {
        this.runtime.placeItem(it.id, it.placement);
        moved = true;
      }
      this.fadeItem(it.id, 1, ms);
    }
    for (const i of change.hide) this.fadeItem(i, 0, ms);
    if (moved) this.saveItems();
    this.broadcastTints();
    this.events.emit('itemScenesChanged', { active: [...this.activeScenes] });
  }

  /** Fades an item in (showing it first) or out (hiding it at the end). */
  private fadeItem(id: string, to: 0 | 1, ms: number): void {
    if (!this.items.some((i) => i.id === id)) return;
    const now = performance.now();
    const visible = this.runtime.isItemVisible(id);
    const shown = this.itemTintShown(id, now)?.[3];
    const from = this.itemFades.has(id)
      ? (shown ?? 1) / (this.itemTints.get(id)?.[3] ?? 1)
      : visible
        ? 1
        : 0;
    if (to === 1 && !visible) this.setItemVisible(id, true);
    if (ms <= 0 || from === to) {
      this.itemFades.delete(id);
      if (to === 0 && visible) this.setItemVisible(id, false);
    } else this.itemFades.set(id, { from, to, start: now, ms: ms * Math.abs(to - from) });
    this.runtime.setItemTint(id, this.itemTintShown(id, now));
  }

  /** Steps the items' scene fades; an item that faded out is hidden. */
  private stepItemFades(now: number): void {
    for (const [id, f] of this.itemFades) {
      const done = now - f.start >= f.ms;
      if (done) {
        this.itemFades.delete(id);
        if (f.to === 0) this.setItemVisible(id, false);
      }
      this.runtime.setItemTint(id, this.itemTintShown(id, now));
    }
    if (this.views.size) this.broadcastTints();
  }

  /** Starts playback of an animated item (its files carry the frame count and the rate it came with). */
  private registerAnimation(
    id: string,
    files: ReadonlyArray<readonly [string, Uint8Array]>,
    saved: { fps: number; playing: boolean } | undefined,
  ): void {
    const marker = animatedMarkerOf(files);
    if (!marker) return;
    if (this.animator.has(id)) return; // replaced files: playback goes on
    this.animator.add(
      id,
      marker.frames,
      saved?.fps ?? marker.fps,
      saved?.playing ?? true,
      marker.delays ? { delays: marker.delays, baseFps: marker.fps } : undefined,
    );
    this.runtime.setItemFrame(id, 0);
  }

  /** An animated item's playback: frames, rate, play state, frame shown, auto-stop frames. */
  itemAnimation(id: string): ItemAnimationState | undefined {
    return this.animator.get(id);
  }

  /**
   * Changes an animated item's playback: the frame rate (0–60) and play state
   * are saved with the item; a frame jump and auto-stop frames are not.
   */
  setItemAnimation(
    id: string,
    c: { fps?: number; frame?: number; playing?: boolean; autoStop?: readonly number[] },
  ): ItemAnimationState | undefined {
    const before = this.animator.get(id);
    if (!before) return undefined;
    const frame = this.animator.control(id, c)!;
    if (frame !== before.frame) {
      this.runtime.setItemFrame(id, frame);
      if (this.views.size) this.sync?.post({ type: 'itemFrames', frames: [[id, frame]] });
    }
    const after = this.animator.get(id)!;
    if (after.fps !== before.fps || after.playing !== before.playing)
      this.updateSettings({
        items: this.items.map((i) =>
          i.id === id ? { ...i, animation: { fps: after.fps, playing: after.playing } } : i,
        ),
      });
    return after;
  }

  /** Flips an item horizontally (Mochi2D's `mirror`), keeping its place and pin. */
  setItemMirror(id: string, mirror: boolean): void {
    this.runtime.placeItem(id, { mirror });
    this.saveItems();
  }
  isItemMirrored(id: string): boolean {
    return this.runtime.items().find((i) => i.id === id)?.placement.mirror === true;
  }

  /** Whether a rule's output got a value this frame (tracking, a plugin, or an agent). */
  isProvided(output: string): boolean {
    return this.provided.has(output);
  }

  /**
   * Items output views show besides the model's own: collaborators' avatars,
   * given by the collaboration while a session runs.
   */
  extraViewItems:
    | (() => Array<{
        id: string;
        label: string;
        visible: boolean;
        files: Array<[string, Uint8Array]>;
      }>)
    | undefined;

  /** Sends the items to output views again (collaborators came or went). */
  refreshViewItems(): void {
    this.broadcastItems();
  }

  /** The collaboration's own video avatar pages: views nobody looks at. */
  private avatarViews = new Set<string>();

  /** Whether output views people see are open (this window's or the bridge's). */
  get hasViews(): boolean {
    for (const id of this.views.keys()) if (!this.avatarViews.has(id)) return true;
    return false;
  }

  /** A message for the output views people see, when there are any. */
  postToViews(m: SyncMessage): void {
    if (this.hasViews) this.sync?.post(m);
  }

  /** Items whose files output views have been sent since the last full send. */
  private itemsSentToViews = new Set<string>();

  /**
   * The items, to output views. Their files go only while views are open (a
   * view's hello sends everything again), and only once: an item the views
   * have already got is sent without them (views keep what they have by
   * id). Collaborators' avatars go only to views people see. Each message
   * copies the files it carries, to every view.
   */
  private broadcastItems(): void {
    if (!this.sync || !this.model) return;
    if (this.views.size) {
      const list = [
        ...this.items
          .filter((i) => this.itemFilesForSync.has(i.id))
          .map((i) => ({
            id: i.id,
            label: i.label,
            visible: this.runtime.isItemVisible(i.id),
            files: this.itemFilesForSync.get(i.id)!,
          })),
        ...((this.hasViews && this.extraViewItems?.()) || []),
      ];
      const sent = this.itemsSentToViews;
      this.sync.post({
        type: 'items',
        items: list.map((i) => (sent.has(i.id) ? { ...i, files: [] } : i)),
      });
      this.itemsSentToViews = new Set(list.map((i) => i.id));
    } else this.itemsSentToViews.clear();
    this.sync.post({ type: 'itemLayout', layout: this.runtime.exportItemLayout() });
  }

  private broadcastStage(): void {
    if (!this.sync) return;
    const { background, fpsCap } = this.stage;
    this.sync.post({
      type: 'stage',
      background,
      transform: this.settings?.transform ?? { x: 0, y: 0, zoom: 1, rotation: 0 },
      fpsCap,
    });
  }
}
