import type { ActiveAnimations } from './paramSources';
import type { MotionRef } from './hotkeys';
import type { ItemPlacement } from './items';
import type { ItemDepth, ItemSplitPlace, MeshPlace } from './plugins/itemSort';
import type { LoadedModelFiles, ModelFileSet } from './modelFiles';
import type { PhysicsFacts } from './physicsDrivers';
import type { PhysicsValues } from './physicsTuning';
import type { StoredVoiceProfile, VoiceElement } from './voice';

/** One live motion-sync analysis: the setting, the level, the element weights and the values written. */
export interface MotionSyncReading {
  setting: { name: string; id: string };
  /** dBFS. */
  level: number;
  silent: boolean;
  weights: Record<VoiceElement, number>;
  /** The driven parameters' values, by ID. */
  values: Record<string, number>;
}
import type { SceneTransform } from './scene';

export interface ParameterInfo {
  id: string;
  name: string;
  /** Range and default, when the runtime knows them. */
  min?: number;
  max?: number;
  default?: number;
}

export interface RuntimeModelInfo {
  parameters: ParameterInfo[];
  /** Problems with optional files and downscaled textures, to show to the user. */
  notices: string[];
}

/** An item (a further model drawn over the main model) as the runtime sees it. */
export interface RuntimeItem {
  id: string;
  visible: boolean;
  placement: ItemPlacement;
  pinned: boolean;
}

export type RuntimeEvents = {
  motionFinished: { motion: MotionRef };
  /** A motion started (its file; `idle`: the idle motion). For the plugin API's animation events. */
  motionStarted: { file: string; idle: boolean };
  /** A motion played to its end. */
  motionEnded: { file: string; idle: boolean };
  /** A user event marker in a playing motion. */
  motionUserEvent: { value: string };
  /** An item was moved by dragging it on the stage. */
  itemMoved: { id: string };
  /** A problem the renderer found after the load: a motion sound that didn't play. */
  modelNotice: { text: string };
  /**
   * The graphics context was lost (the graphics driver or the app's graphics process
   * restarted) or is back. Drawing pauses while it is lost; a model load waits for it.
   */
  graphicsContext: { lost: boolean };
};

/** Automatic behaviours the runtime can switch. */
export type RuntimeEffect = 'eyeBlink' | 'breath' | 'physics' | 'idle';

/**
 * The seam between Mochi Studio and the renderer. Everything above this
 * interface (tracking, mapping, hotkeys, settings, UI) is the app; the
 * implementation below it (`src/web/mochiRuntime.ts`) is a thin adapter over
 * Mochi2D's public API (`MochiView`, `MochiModel`, `MochiItem`, live lip
 * sync).
 *
 * Nothing here depends on the DOM except `attach`, which takes whatever
 * surface the platform renders to.
 */
export interface AvatarRuntime {
  /** Playing motions and active expressions, with the parameters they write. */
  activeAnimations?(): ActiveAnimations;
  readonly name: string;
  attach(canvas: HTMLCanvasElement): void;
  load(model: LoadedModelFiles): Promise<RuntimeModelInfo>;
  unload(): void;

  /**
   * The parameter values for this frame (tracking output, overrides). They
   * replace the previous frame's: a parameter set last frame and missing now
   * goes back to its default.
   */
  setParameters(values: Record<string, number>): void;
  /** An expression on or off, with its file's fades, or `fade` seconds both ways. */
  setExpression(name: string, on: boolean, fade?: number): void;
  /**
   * Expressions made or changed in the expression editor: each replaces the
   * model's file of the same path, or is added to the model's expressions
   * (`manifest.expressions`).
   */
  setOwnExpressions(list: ReadonlyArray<{ name: string; file: string; bytes: Uint8Array }>): void;
  /** Shows an expression being edited at once, in this window only; undefined stops it. */
  previewExpression(bytes: Uint8Array | undefined): void;
  /**
   * Plays a motion once, or holds its last frame. Holding the same motion
   * again releases it.
   */
  playMotion(ref: MotionRef, mode: 'once' | 'hold'): void;
  stopMotions(): void;
  setEffect(effect: RuntimeEffect, on: boolean): void;
  /** What physics overwrites, look-at's routing and breath's parameters, for the driver choice. */
  physicsFacts(): PhysicsFacts | undefined;
  /**
   * The model's physics settings (groups) in file order: ID, display name, and
   * whether the file names it (`name` is the ID otherwise).
   */
  physicsSettings(): ReadonlyArray<{ id: string; name: string; named: boolean }>;
  /** Physics strength (the model's and each group's), wind and rate, in Mochi2D's values. */
  setPhysicsValues(v: PhysicsValues): void;
  /** The physics rate: the one set (absent: the file's), the physics file's own, and the one in use. */
  physicsRate(): { set: PhysicsValues['rate']; file: number; inUse: number };
  /** The stage's drawing size in device pixels (a Spout2 output's default size). */
  pixelSize(): { width: number; height: number };
  /** A motion file that loops at the lowest priority while nothing else plays (undefined: none). */
  setIdleMotion(file: string | undefined): void;
  /**
   * How far the idle animation moves each parameter, 0–1 (1, the default:
   * as usual; 0: it leaves the base value alone). Tracking wins this way.
   */
  setIdleWeights(weights: Readonly<Record<string, number>>): void;
  /** Tints of the main model's art meshes by ID, RGBA 0–1; meshes not listed are untinted. */
  setModelTints(tints: ReadonlyArray<readonly [string, readonly number[]]>): void;
  /** Replaces an item's texture in place (web items; Mochi2D 0.14.0). */
  updateItemTexture(
    id: string,
    image: ImageBitmap | ImageData | { width: number; height: number; data: Uint8Array },
  ): void;
  /** The display light overlay: a multiply color, RGB 0–1, for the model and, with `items`, the items. */
  setLight(
    rgb: readonly number[] | undefined,
    items: boolean,
    strengths?: Readonly<Record<string, number>>,
  ): void;
  /** One tint over all of an item's art meshes, RGBA 0–1 (undefined: none). */
  setItemTint(id: string, rgba: readonly number[] | undefined): void;
  /** Animated items: shows frame `frame` (its part at opacity 1, the others at 0). */
  setItemFrame(id: string, frame: number): void;
  setTransform(t: SceneTransform): void;

  // Items --------------------------------------------------------------------
  addItem(
    id: string,
    files: ModelFileSet,
    state: { visible: boolean; placement?: ItemPlacement },
  ): Promise<void>;
  removeItem(id: string): void;
  items(): RuntimeItem[];
  setItemVisible(id: string, visible: boolean): void;
  isItemVisible(id: string): boolean;
  placeItem(id: string, placement: Partial<ItemPlacement>): void;
  /** Pins the item to the part of the model under its anchor, or unpins it. */
  pinItem(id: string, pinned: boolean): boolean;
  /** The item under a point in page coordinates. */
  itemAt(clientX: number, clientY: number): string | undefined;
  /** An opaque, JSON-safe description of where the items are (including pins). */
  exportItemLayout(): unknown;
  applyItemLayout(layout: unknown): void;
  /** The main model's art-mesh IDs, in model order. */
  artMeshIds(): string[];
  /**
   * Where an item is drawn among the main model's art meshes, and its split
   * (null: drawn whole on its side of the model).
   */
  itemSort(id: string): { layer: MeshPlace | null; split: ItemSplitPlace | null } | undefined;
  /** Draws an item at a place in the main model's render order or on a side, split or whole. */
  setItemSort(id: string, layer: ItemDepth, split: ItemSplitPlace | null): void;

  // Lip sync -----------------------------------------------------------------
  /**
   * Starts live lip sync from the microphone (a `deviceId`, or the browser's
   * choice). Every frame the runtime combines its lip-sync value with the
   * mouth parameter's base value (`setLipSyncMix`); `setLipSyncGain` and the
   * base value let the app mix it with tracking.
   */
  startLipSync(
    deviceId?: string,
    opts?: { stream?: MediaStream; voiceProcessing?: boolean },
  ): Promise<void>;
  /** How the live value combines with the base value: added, or the larger of the two. */
  setLipSyncMix(mix: 'add' | 'max'): void;
  stopLipSync(): void;
  /** Sensitivity: 1 is the runtime's default, 0 silences the microphone's effect. */
  setLipSyncGain(gain: number): void;
  /** The noise gate in dBFS. */
  setLipSyncGate(db: number): void;
  /** What lip sync added to the mouth parameter last frame, or undefined when it is off. */
  lipSyncValue(): number | undefined;
  /** The microphone's input level in dBFS (an RMS level), or undefined when it is off. */
  lipSyncLevel(): number | undefined;
  /** The mouth parameter lip sync drives, if the model has one. */
  readonly lipSyncParameter: string | undefined;

  // Motion sync and voice calibration (the advanced lipsync) -------
  /** The settings of the model's motion-sync file (ID, dictionary name, whether they run). */
  motionSyncSettings(): ReadonlyArray<{ id: string; name: string; usable: boolean }>;
  /** Live motion sync from `stream` through a setting: its own shapes move the mouth. */
  startMotionSync(setting: string, stream: MediaStream): Promise<void>;
  stopMotionSync(): void;
  /** The latest live motion-sync analysis, or undefined when none runs. */
  motionSyncTick(): MotionSyncReading | undefined;
  /** The voice profile motion sync analyzes with (null: the neutral voice). */
  setVoiceProfile(profile: StoredVoiceProfile | null): void;
  /** Records a clip of the microphone (or `stream`), mono, for voice calibration. */
  recordAudio(
    seconds: number,
    opts?: { stream?: MediaStream; voiceProcessing?: boolean; deviceId?: string },
  ): Promise<{ sampleRate: number; channels: [Float32Array] }>;

  /**
   * Plays a sound and moves the mouth with it; resolves when it ends. With
   * `play: false` only the mouth moves (for output views).
   */
  speak(audio: Uint8Array, volume: number, play?: boolean): Promise<void>;
  /** A PNG of the next frame, with a transparent background. */
  screenshot(): Promise<Blob>;
  /**
   * Advances animation by `dtMs` and draws one frame; with `draw` false it
   * only advances (motions, their events, expressions, physics, live lip
   * sync, items), and the canvas keeps its last picture.
   */
  render(dtMs: number, draw?: boolean): void;
  on<K extends keyof RuntimeEvents>(type: K, fn: (p: RuntimeEvents[K]) => void): () => void;
}
