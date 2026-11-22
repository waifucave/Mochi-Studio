import { strengthTint } from '../core/lightOverlay';
import { MODEL_TEXTURE_LIMITS, SHARED_TEXTURE_LIMITS } from '../core/archiveLimits';
import { describeLoadError, ModelLoadError } from '../core/modelFiles';
import { COLLAB_ITEM_PREFIX } from '../core/collab/stage';
import {
  LIVE_LIP_SYNC_DEFAULTS,
  MochiView,
  type ItemDepth,
  type ItemLayout,
  type ItemMeshPlace,
  type ItemSplit,
  type MochiItem,
  type MochiModel,
  type MotionSyncTick,
  type VoiceProfile,
} from 'mochi2d';
import { parseExpression, parseMotion } from 'mochi2d/headless';
import { Emitter } from '../core/events';
import type { ActiveAnimations } from '../core/paramSources';
import type { MotionRef } from '../core/hotkeys';
import { layoutWithIds, type ItemPlacement } from '../core/items';
import type { LoadedModelFiles, ModelFileSet } from '../core/modelFiles';
import { physicsFacts, type PhysicsFacts } from '../core/physicsDrivers';
import { windGust, type PhysicsValues } from '../core/physicsTuning';
import type { StoredVoiceProfile } from '../core/voice';
import { framePartId } from '../core/animatedItem';
import type {
  AvatarRuntime,
  RuntimeEffect,
  RuntimeEvents,
  RuntimeItem,
  RuntimeModelInfo,
} from '../core/runtime';
import { DEFAULT_TRANSFORM, type SceneTransform } from '../core/scene';

/** A message for a renderer that could not start, saying what is missing. */
export function webglProblem(e: unknown): string {
  const msg = (e as Error)?.message ?? String(e);
  return /webgl/i.test(msg)
    ? 'The avatar cannot be drawn: this browser or computer does not offer WebGL 2.'
    : `The avatar cannot be drawn: ${msg}`;
}

/** What to try when WebGL 2 is missing. */
export const WEBGL_TIPS = [
  'Turn on hardware acceleration in the browser’s settings (in Chrome and Edge: Settings → System → “Use graphics acceleration when available”), then restart the browser.',
  'Update the graphics drivers.',
  'Try another browser (a recent Chrome, Edge, Firefox or Safari).',
  'In OBS, check that the Browser Source is not set to run without the GPU.',
];

/** A `ModelFileSet` as Mochi2D's `FileSource`. */
type Source = { label: string; list(): readonly string[]; read(p: string): Promise<Uint8Array> };

function toSource(files: ModelFileSet): Source {
  return { label: files.label, list: () => files.paths(), read: (p) => files.read(p) };
}

/**
 * A source that keeps the first bytes of each file Mochi2D reads (a copy,
 * not the file), so a refused texture's format can be named. Only until
 * `done()`: the source stays the model's, and later reads (an expression,
 * each preview) need none.
 */
function watched(src: Source): {
  source: Source;
  head(path: string): Uint8Array | undefined;
  done(): void;
} {
  const heads = new Map<string, Uint8Array>();
  let watching = true;
  return {
    source: {
      label: src.label,
      list: () => src.list(),
      read: async (p) => {
        const b = await src.read(p);
        if (watching) heads.set(p, b.slice(0, 32));
        return b;
      },
    },
    done: () => {
      watching = false;
      heads.clear();
    },
    head: (path) => {
      for (const [p, b] of heads) if (p === path || p.endsWith(`/${path}`)) return b;
      return undefined;
    },
  };
}

/** Mochi2D's refusal of a model or an item, said plainly (src/core/modelFiles.ts). */
function plainRefusal(e: unknown, what: string, head: (p: string) => Uint8Array | undefined) {
  const d = describeLoadError(e, what, head);
  return d ? new ModelLoadError(d.message, d.problem) : e;
}

/**
 * The caps an item is loaded with: a collaborator's shared model gets the
 * shared ones (the same its files were checked against), every other item
 * the caps of the person's own (src/core/archiveLimits.ts).
 */
const itemTextureLimits = (id: string) =>
  id.startsWith(COLLAB_ITEM_PREFIX) ? SHARED_TEXTURE_LIMITS : MODEL_TEXTURE_LIMITS;

/** Which audio live lip sync follows: a stream instead of the microphone, and voice processing. */
export interface LiveAudioOptions {
  stream?: MediaStream;
  voiceProcessing?: boolean;
}

/**
 * The renderer: a thin adapter from `AvatarRuntime` to Mochi2D's `MochiView`,
 * `MochiModel` and `MochiItem`. Mochi Studio drives the frame loop
 * (`render`), so the view does not start its own.
 */
export class MochiRuntime implements AvatarRuntime {
  readonly name = 'Mochi2D';
  private view: MochiView | undefined;
  private canvas: HTMLCanvasElement | undefined;
  private model: MochiModel | undefined;
  /** The physics wind's peak force (gusts vary it; src/core/physicsTuning.ts). */
  private windPeak: [number, number] = [0, 0];
  /** The physics rate set (`PhysicsValues.rate`), and the physics file's own (read at load). */
  private physicsRateSet: PhysicsValues['rate'];
  private filePhysicsRate = 0;
  /** Files laid over the model's: own expressions and the editor's preview, by path. */
  private extraFiles = new Map<string, Uint8Array>();
  /**
   * Own expressions (made or changed in the editor): name -> the path Mochi2D
   * knows the current version by. Every version gets a new path, so a changed
   * file is read afresh.
   */
  private ownPaths = new Map<string, string>();
  private ownVersion = 0;
  /** The model's expressions as its files list them, before own ones were added. */
  private baseExpressions: Array<{ name: string; file: string }> = [];
  private previewPath: string | undefined;
  /** Expression changes run one after another (an add reads its file first). */
  private exprChain: Promise<void> = Promise.resolve();
  private files: LoadedModelFiles | undefined;
  private events = new Emitter<RuntimeEvents>();
  private defaults = new Map<string, number>();
  private ranges = new Map<string, { min: number; max: number }>();
  /** Parameters set last frame, so the ones that disappear return to default. */
  private lastSet = new Set<string>();
  /** The motion Mochi Studio started last, while it plays or holds. */
  private playing: { ref: MotionRef; hold: boolean } | undefined;
  /** A held motion that reached its last frame (Mochi2D keeps showing it). */
  private held: { ref: MotionRef } | undefined;
  private itemMap = new Map<string, MochiItem>();
  private transform: SceneTransform = { ...DEFAULT_TRANSFORM };
  /** CSS pixels per model unit at zoom 1, once the view has measured it. */
  private pixelsPerUnit: number | undefined;
  /** The microphone is on (undefined: off); its device, or '' for the browser's choice. */
  private micDevice: string | undefined;
  private micOptions: LiveAudioOptions = {};
  private voiceProfile: VoiceProfile | null = null;
  private lipMix: 'add' | 'max' = 'add';
  private lipGain = 1;
  private lipGate = LIVE_LIP_SYNC_DEFAULTS.gate;
  private effects = new Map<RuntimeEffect, boolean>();
  private resizeObserver: ResizeObserver | undefined;
  private draggingItem: string | undefined;
  private idleMotion: string | undefined;
  private idleStarting = false;

  /** Why the renderer cannot draw (no WebGL 2), or undefined when it can. */
  problem: string | undefined;
  /** How many of the model's warnings have been told (load's notices included). */
  private warningsSeen = 0;

  attach(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    try {
      this.view = new MochiView(canvas, {
        look: 'off',
        autoStart: false,
        background: 'transparent',
        dragItems: true,
      });
    } catch (e) {
      // Without WebGL 2 nothing can be drawn; the rest of the app still works.
      this.problem = webglProblem(e);
      return;
    }
    this.view.on('error', ({ error }) => console.error('Mochi2D:', error));
    this.view.on('motionevent', ({ value }) => this.events.emit('motionUserEvent', { value }));
    this.resizeObserver = new ResizeObserver(() => {
      this.pixelsPerUnit = undefined;
      this.applyTransform();
    });
    this.resizeObserver.observe(canvas);
    // Items dragged with Mochi2D's own item dragging: report where they went.
    canvas.addEventListener('pointerdown', (e) => {
      this.draggingItem = this.itemAt(e.clientX, e.clientY);
    });
    const end = (): void => {
      const id = this.draggingItem;
      this.draggingItem = undefined;
      if (id) this.events.emit('itemMoved', { id });
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
  }

  /** The stage's drawing size in device pixels (a Spout2 output's default size). */
  pixelSize(): { width: number; height: number } {
    const c = this.canvas;
    const r = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
    return c
      ? { width: Math.round(c.clientWidth * r), height: Math.round(c.clientHeight * r) }
      : { width: 1280, height: 720 };
  }

  private get v(): MochiView {
    if (this.problem) throw new Error(this.problem);
    if (!this.view) throw new Error('The renderer is not attached to a canvas.');
    return this.view;
  }

  async load(model: LoadedModelFiles): Promise<RuntimeModelInfo> {
    const files = model.files;
    const extra = this.extraFiles;
    // Own expressions (and the editor's preview) are files laid over the model's. Mochi2D
    // reads them from this source when they are added, after the load; the map is cleared
    // with the model state below, once the new model has loaded.
    const w = watched({
      label: files.label,
      list: () => [...files.paths(), ...extra.keys()],
      read: (p: string) => {
        const x = extra.get(p);
        return x ? Promise.resolve(x) : files.read(p);
      },
    });
    // The person's own model: its compressed motion sounds play too (MP3, Ogg);
    // a collaborator's model is an item, and items play no motion sounds.
    let m: MochiModel;
    try {
      m = await this.v.load(w.source, {
        settings: model.manifest.file,
        textures: MODEL_TEXTURE_LIMITS,
        sounds: { compressed: true },
      });
    } catch (e) {
      // Mochi2D keeps the model shown before, and so does this state.
      throw plainRefusal(e, 'This model', w.head);
    } finally {
      w.done();
    }
    this.resetModelState();
    this.model = m;
    this.warningsSeen = m.warnings.length;
    this.filePhysicsRate = m.physicsRate;
    m.runtime.onMotionEnd((end) => {
      if (end.reason === 'finished')
        this.events.emit('motionEnded', { file: end.motion, idle: end.motion === this.idleMotion });
    });
    this.files = model;
    this.baseExpressions = model.manifest.expressions.map((e) => ({ ...e }));
    this.touchCache = new Map();
    for (const p of m.parameters) {
      this.defaults.set(p.id, p.default);
      this.ranges.set(p.id, { min: p.min, max: p.max });
    }
    for (const [effect, on] of this.effects) if (m.effectAvailable(effect)) m.setEffect(effect, on);
    this.pixelsPerUnit = undefined;
    this.applyTransform();
    if (this.voiceProfile) m.setVoiceProfile(this.voiceProfile);
    if (this.micDevice !== undefined)
      await this.startLipSync(this.micDevice || undefined, this.micOptions).catch((e) =>
        console.warn('Microphone:', e),
      );
    return {
      parameters: m.parameters.map((p) => ({
        id: p.id,
        name: p.name,
        min: p.min,
        max: p.max,
        default: p.default,
      })),
      notices: [...m.warnings, ...(m.textureNotice ? [m.textureNotice] : [])],
    };
  }

  private resetModelState(): void {
    this.defaults.clear();
    this.ranges.clear();
    this.lastSet.clear();
    this.playing = undefined;
    this.held = undefined;
    this.windPeak = [0, 0];
    this.physicsRateSet = undefined;
    this.filePhysicsRate = 0;
    this.extraFiles.clear();
    this.ownPaths.clear();
    this.previewPath = undefined;
    this.exprChain = Promise.resolve();
  }

  unload(): void {
    this.view?.unload();
    this.model = undefined;
    this.files = undefined;
    this.resetModelState();
  }

  // --- parameters, expressions, motions -------------------------------------

  setParameters(values: Record<string, number>): void {
    const m = this.model;
    if (!m) return;
    // A playing or held motion writes over these: Mochi2D applies motions after them.
    const all = values;
    for (const id of this.lastSet)
      if (!(id in all)) {
        const d = this.defaults.get(id);
        if (d !== undefined) m.setParameter(id, d);
      }
    this.lastSet.clear();
    for (const [id, v] of Object.entries(all)) {
      if (!Number.isFinite(v)) continue;
      if (m.setParameter(id, v)) this.lastSet.add(id);
    }
  }

  /** Parameters each motion or expression file writes, parsed once per model (null while reading). */
  private touchCache = new Map<string, Map<string, 'Add' | 'Multiply' | 'Overwrite'> | null>();
  private touches(
    file: string,
    kind: 'motion' | 'expression',
  ): ReadonlyMap<string, 'Add' | 'Multiply' | 'Overwrite'> {
    const known = this.touchCache.get(file);
    if (known !== undefined) return known ?? new Map();
    const files = this.files?.files;
    const extra = this.extraFiles.get(file);
    if (!extra && !files?.has(file)) return new Map();
    this.touchCache.set(file, null);
    const cache = this.touchCache;
    void (extra ? Promise.resolve(extra) : files!.read(file))
      .then((bytes) => {
        const out = new Map<string, 'Add' | 'Multiply' | 'Overwrite'>();
        if (kind === 'motion') {
          for (const c of parseMotion(bytes, file).curves)
            if (c.target === 'Parameter') out.set(c.id, 'Overwrite');
        } else for (const p of parseExpression(bytes, file).parameters) out.set(p.id, p.blend);
        cache.set(file, out);
      })
      .catch(() => cache.set(file, new Map()));
    return new Map();
  }

  /** The playing motions and active expressions, with the parameters they write. */
  activeAnimations(): ActiveAnimations {
    const m = this.model;
    if (!m || !this.files) return { motions: [], expressions: [] };
    const manifest = this.files.manifest;
    // Mochi2D plays the model's Idle group by itself, at the idle priority (idle weights apply),
    // unless the app started that motion (a hotkey).
    const own = this.playing
      ? manifest.motions.find(
          (e) => e.group === this.playing!.ref.group && e.index === this.playing!.ref.index,
        )?.file
      : undefined;
    const idleGroup = new Set(
      manifest.motions.filter((e) => e.group === 'Idle').map((e) => e.file),
    );
    return {
      motions: m.motions.map((file) => ({
        file,
        idle: file === this.idleMotion || (file !== own && idleGroup.has(file)),
        parameters: new Set(this.touches(file, 'motion').keys()),
      })),
      expressions: m.addedExpressions
        .filter((file) => file !== this.previewPath)
        .map((file) => ({
          name:
            [...this.ownPaths].find(([, p]) => p === file)?.[0] ??
            manifest.expressions.find((e) => e.file === file)?.name ??
            file,
          parameters: this.touches(file, 'expression'),
        })),
    };
  }

  /** The path Mochi2D knows an expression by: its file, relative to the settings file. */
  private expressionPath(name: string): string {
    return (
      this.ownPaths.get(name) ??
      this.files?.manifest.expressions.find((e) => e.name === name)?.file ??
      name
    );
  }

  /** Runs expression changes in order, each after the one before has read its file. */
  private expressionStep(fn: (m: MochiModel) => Promise<unknown> | unknown): void {
    const m = this.model;
    if (!m) return;
    this.exprChain = this.exprChain
      .then(async () => {
        if (this.model === m) await fn(m);
      })
      .catch((e) => console.error(e));
  }

  /**
   * Expressions layer (Mochi2D's `addExpression`), each with its file's
   * fades, or with `fade` seconds both ways (Mochi2D 0.13.0: an expression
   * added with a fade-out keeps it for its removal).
   */
  setExpression(name: string, on: boolean, fade?: number): void {
    const path = this.expressionPath(name);
    const fades = fade === undefined ? undefined : { fadeIn: fade, fadeOut: fade };
    this.expressionStep((m) =>
      on
        ? m.addExpression(path, fades)
        : m.removeExpression(path, fades ? { fadeOut: fades.fadeOut } : undefined),
    );
  }

  /** Waits until every expression change asked for so far has taken effect (for tests). */
  expressionsSettled(): Promise<void> {
    return this.exprChain;
  }

  /**
   * Expressions made or changed in the editor: each replaces the model's file
   * of the same path, or is added to the model's expressions. Expressions that
   * are on stay on, with their new content.
   */
  setOwnExpressions(list: ReadonlyArray<{ name: string; file: string; bytes: Uint8Array }>): void {
    const f = this.files;
    if (!f || !this.model) return;
    const before = new Map(
      f.manifest.expressions.map((e) => [e.name, this.expressionPath(e.name)] as const),
    );
    const oldPaths = [...this.ownPaths.values()];
    this.ownPaths.clear();
    const entries = this.baseExpressions.map((e) => ({ ...e }));
    for (const o of list) {
      const path = `.mochi-studio/expressions/${++this.ownVersion}/${o.file}`;
      this.extraFiles.set(path, o.bytes);
      const base = entries.find((e) => e.file.toLowerCase() === o.file.toLowerCase());
      const name = base ? base.name : o.name;
      if (!base) entries.push({ name, file: o.file });
      this.ownPaths.set(name, path);
    }
    f.manifest.expressions = entries;
    this.expressionStep(async (m) => {
      const added = new Set(m.addedExpressions);
      for (const [name, old] of before) {
        if (!added.has(old)) continue;
        const now = entries.some((e) => e.name === name) ? this.expressionPath(name) : undefined;
        if (now === old) continue;
        m.removeExpression(old);
        if (now) await m.addExpression(now);
      }
      // Old versions' files are no longer needed once nothing reads them.
      for (const p of oldPaths)
        if (![...this.ownPaths.values()].includes(p)) this.extraFiles.delete(p);
    });
  }

  /**
   * Shows an expression being edited at once (no fades), over everything
   * else, or (undefined) stops showing it. Only this window shows it.
   */
  previewExpression(bytes: Uint8Array | undefined): void {
    const path = bytes ? `.mochi-studio/preview/${++this.ownVersion}.exp3.json` : undefined;
    if (path && bytes) this.extraFiles.set(path, bytes);
    this.expressionStep(async (m) => {
      const old = this.previewPath;
      this.previewPath = path;
      if (old) {
        m.removeExpression(old);
        this.extraFiles.delete(old);
      }
      if (path) await m.addExpression(path);
    });
  }

  playMotion(ref: MotionRef, mode: 'once' | 'hold'): void {
    const m = this.model;
    const entry = this.files?.manifest.motions.find(
      (x) => x.group === ref.group && x.index === ref.index,
    );
    if (!m || !entry || !this.files) return;
    const current = this.held ?? (this.playing?.hold ? this.playing : undefined);
    const same = current && current.ref.group === ref.group && current.ref.index === ref.index;
    this.held = undefined;
    if (mode === 'hold' && same) {
      // Pressing a held motion again releases it.
      this.stopMotions();
      return;
    }
    const playing = { ref, hold: mode === 'hold' };
    this.playing = playing;
    // Mochi2D holds the last frame until stopMotions() or the next motion. A
    // hold shows the motion's own last frame, so it must not fade out.
    const options = { priority: 3, ...(playing.hold ? { hold: true, fadeOut: 0 } : {}) };
    const start = this.files.manifest.discovered.motions
      ? m.startMotionFile(entry.file, options)
      : m.startMotion(ref.group, ref.index, options);
    void start
      .then((playback) => {
        if (!playback) {
          if (this.playing === playing) this.playing = undefined;
          return;
        }
        this.events.emit('motionStarted', { file: playback.motion, idle: false });
        void playback.ended.then((end) => {
          if (this.playing !== playing) return;
          if (end.reason === 'finished') {
            if (playing.hold) this.held = { ref };
            else this.playing = undefined;
            this.events.emit('motionFinished', { motion: ref });
          } else {
            this.playing = undefined;
            this.held = undefined;
          }
        });
      })
      .catch((e) => {
        console.error(e);
        if (this.playing === playing) this.playing = undefined;
      });
  }

  stopMotions(): void {
    this.playing = undefined;
    this.held = undefined;
    this.model?.stopMotions();
  }

  physicsFacts(): PhysicsFacts | undefined {
    return this.model ? physicsFacts(this.model.runtime) : undefined;
  }
  physicsSettings(): ReadonlyArray<{ id: string; name: string; named: boolean }> {
    return this.model?.physicsSettings ?? [];
  }
  setPhysicsValues(v: PhysicsValues): void {
    const m = this.model;
    if (!m) return;
    m.resetPhysicsStrengths();
    m.setPhysicsStrength(Math.max(0, v.strength));
    for (const [id, k] of Object.entries(v.settings))
      m.setPhysicsSettingStrength(id, Math.max(0, k));
    // Each group's share of the wind (Mochi2D 0.13.0).
    m.resetPhysicsSettingWinds();
    for (const [id, k] of Object.entries(v.windSettings ?? {}))
      m.setPhysicsSettingWind(id, Math.max(0, k));
    this.windPeak = [v.wind[0], v.wind[1]];
    this.applyWind();
    if (v.rate !== this.physicsRateSet) {
      this.physicsRateSet = v.rate;
      m.setPhysicsRate(v.rate ?? null);
    }
  }
  /** The physics rate: the one set (absent: the file's), the file's own, and the one in use. */
  physicsRate(): { set: PhysicsValues['rate']; file: number; inUse: number } {
    return {
      set: this.physicsRateSet,
      file: this.filePhysicsRate,
      inUse: this.model?.physicsRate ?? 0,
    };
  }
  /** Mochi2D's physics values (the wind as its peak), for tests. */
  physicsValues(): PhysicsValues | undefined {
    const m = this.model;
    if (!m) return undefined;
    const settings: Record<string, number> = {};
    for (const { id } of m.physicsSettings) {
      const k = m.getPhysicsSettingStrength(id);
      if (k !== 1) settings[id] = k;
    }
    const windSettings: Record<string, number> = {};
    for (const { id } of m.physicsSettings) {
      const k = m.getPhysicsSettingWind(id);
      if (k !== 1) windSettings[id] = k;
    }
    return {
      strength: m.physicsStrength,
      settings,
      ...(Object.keys(windSettings).length ? { windSettings } : {}),
      wind: [...this.windPeak],
      ...(this.physicsRateSet !== undefined ? { rate: this.physicsRateSet } : {}),
    };
  }
  /** The wind force Mochi2D has now (a gust of the peak). */
  physicsWindNow(): [number, number] {
    return this.model ? this.model.physicsWind : [0, 0];
  }
  /** Gusts: the peak wind scaled by `windGust` on the wall clock (every window the same). */
  private applyWind(): void {
    const m = this.model;
    if (!m) return;
    const [px, py] = this.windPeak;
    if (px === 0 && py === 0) {
      const [x, y] = m.physicsWind;
      if (x !== 0 || y !== 0) m.setPhysicsWind(0, 0);
      return;
    }
    const [gx, gy] = windGust(Date.now() / 1000);
    const peak = Math.hypot(px, py);
    m.setPhysicsWind(px * gx, py * gx + peak * gy);
  }

  setIdleMotion(file: string | undefined): void {
    if (file === this.idleMotion) return;
    const previous = this.idleMotion;
    this.idleMotion = file;
    const m = this.model;
    if (m && previous && m.motions.includes(previous) && !this.playing) m.stopMotions();
    this.keepIdle();
  }

  /** Starts the idle motion when nothing plays. */
  private keepIdle(): void {
    const m = this.model;
    const file = this.idleMotion;
    if (!m || !file || this.idleStarting || this.playing || this.held || m.motions.length) return;
    this.idleStarting = true;
    void m
      .startMotionFile(file, { priority: 1, loop: true })
      .then((pb) => {
        if (pb) this.events.emit('motionStarted', { file: pb.motion, idle: true });
      })
      .catch((e) => {
        console.warn('Idle motion:', e);
        this.idleMotion = undefined;
      })
      .finally(() => (this.idleStarting = false));
  }

  setEffect(effect: RuntimeEffect, on: boolean): void {
    if (this.effects.get(effect) === on) return;
    this.effects.set(effect, on);
    if (this.model?.effectAvailable(effect)) this.model.setEffect(effect, on);
  }

  // --- for the plugin API -------------------------------------------------------

  /** The art mesh a pinned item is attached to, or undefined. */
  itemPinMesh(id: string): string | undefined {
    return this.itemMap.get(id)?.pin?.drawable;
  }

  /** The model's art-mesh IDs, in model order. */
  artMeshIds(): string[] {
    return this.model ? [...this.model.runtime.model.meshes.ids] : [];
  }

  /** The model's user-data file (art-mesh tags), as a path in its file set, if any. */
  userDataPath(): string | undefined {
    const rt = this.model?.runtime;
    return rt?.settings.userData ? rt.resolve(rt.settings.userData) : undefined;
  }

  /** A model parameter's current value. */
  parameterValue(id: string): number | undefined {
    return this.model && this.defaults.has(id) ? this.model.getParameter(id) : undefined;
  }

  /**
   * Art meshes of the main model under a point in page coordinates, topmost
   * first, with the triangle hit and the point's barycentric weights.
   */
  artMeshHits(
    clientX: number,
    clientY: number,
  ): Array<{ id: string; order: number; masked: boolean; vertices: number[]; weights: number[] }> {
    const m = this.model;
    const p = this.view?.toModel(clientX, clientY);
    if (!m || !p) return [];
    const moc = m.runtime.model;
    const inst = m.runtime.instance;
    const hits: Array<{
      id: string;
      render: number;
      masked: boolean;
      vertices: number[];
      weights: number[];
    }> = [];
    moc.meshes.ids.forEach((id, i) => {
      if (!inst.drawableVisible[i] || !(inst.drawableOpacity[i]! > 0)) return;
      const v = inst.drawableVertices[i];
      const tris = moc.meshes.triangles[i];
      if (!v || !tris) return;
      for (let t = 0; t + 2 < tris.length; t += 3) {
        const [a, b, c] = [tris[t]!, tris[t + 1]!, tris[t + 2]!];
        const w = barycentric(
          p.x,
          p.y,
          v[a * 2]!,
          v[a * 2 + 1]!,
          v[b * 2]!,
          v[b * 2 + 1]!,
          v[c * 2]!,
          v[c * 2 + 1]!,
        );
        if (!w) continue;
        hits.push({
          id,
          render: inst.drawableRenderOrder[i] ?? 0,
          masked: (moc.meshes.masks[i]?.length ?? 0) > 0,
          vertices: [a, b, c],
          weights: w,
        });
        return;
      }
    });
    hits.sort((x, y) => y.render - x.render);
    return hits.map((h, order) => ({
      id: h.id,
      order,
      masked: h.masked,
      vertices: h.vertices,
      weights: h.weights,
    }));
  }

  /** Plugin tints by art-mesh index (0–255 per channel; white is no tint), as last set. */
  readonly tints = new Map<number, { r: number; g: number; b: number; a: number }>();
  /** Sets the plugin tints by art-mesh index, and draws them (Mochi2D's `setTint`). */
  setTints(tints: ReadonlyMap<number, { r: number; g: number; b: number; a: number }>): void {
    this.tints.clear();
    for (const [i, t] of tints) this.tints.set(i, t);
    this.setModelTints(this.modelTintsById());
  }
  /** The tints by art-mesh ID, RGBA 0–1 (for output views). */
  modelTintsById(): Array<[string, number[]]> {
    const ids = this.artMeshIds();
    const out: Array<[string, number[]]> = [];
    for (const [i, t] of this.tints) {
      const id = ids[i];
      if (id !== undefined) out.push([id, [t.r / 255, t.g / 255, t.b / 255, t.a / 255]]);
    }
    return out;
  }
  /** The tints asked for (plugins'), apart from the light, which multiplies them. */
  private wantedTints = new Map<string, readonly number[]>();
  /** The display light overlay's multiply color (0–1), and whether items get it. */
  private light: readonly number[] | undefined;
  private lightItems = false;
  /** Art mesh ID → how much of the light it takes; missing: all of it. */
  private lightStrengths: Readonly<Record<string, number>> = {};
  setModelTints(tints: ReadonlyArray<readonly [string, readonly number[]]>): void {
    this.wantedTints = new Map(tints);
    this.applyModelTints();
  }
  private applyModelTints(): void {
    const m = this.model;
    if (!m) return;
    const want = this.wantedTints;
    const light = this.light;
    if (!light) {
      for (const id of [...m.tints.keys()]) if (!want.has(id)) m.clearTint(id);
      for (const [id, rgba] of want) m.setTint(id, rgba);
      return;
    }
    for (const id of this.artMeshIds()) {
      const s = this.lightStrengths[id];
      m.setTint(id, lit(want.get(id), s === undefined ? light : strengthTint(light, s)));
    }
  }
  /** The light overlay: a multiply color for the model (and the items, with `items`); undefined: off. */
  setLight(
    rgb: readonly number[] | undefined,
    items: boolean,
    strengths: Readonly<Record<string, number>> = {},
  ): void {
    const was = this.lightItems || !!this.light;
    this.lightStrengths = strengths;
    this.light = rgb ? [rgb[0] ?? 1, rgb[1] ?? 1, rgb[2] ?? 1] : undefined;
    this.lightItems = items && !!rgb;
    this.applyModelTints();
    if (this.lightItems || was) for (const id of this.itemMap.keys()) this.applyItemTint(id);
  }
  /** The light overlay's color as applied (for tests). */
  lightColor(): { rgb: readonly number[] | undefined; items: boolean } {
    return { rgb: this.light, items: this.lightItems };
  }

  /** Item tints (one over all of an item's meshes), kept so a re-added item gets its own back. */
  private itemTints = new Map<string, readonly number[]>();
  setItemTint(id: string, rgba: readonly number[] | undefined): void {
    if (rgba) this.itemTints.set(id, [...rgba]);
    else this.itemTints.delete(id);
    this.applyItemTint(id);
  }
  itemTint(id: string): readonly number[] | undefined {
    return this.itemTints.get(id);
  }
  private applyItemTint(id: string): void {
    const item = this.itemMap.get(id);
    if (!item) return;
    const own = this.itemTints.get(id);
    const rgba = this.lightItems && this.light ? lit(own, this.light) : own;
    if (!rgba) return item.clearTints();
    for (const mesh of item.runtime.model.meshes.ids) item.setTint(mesh, rgba);
  }

  /** Animated items: the frame each shows, kept so a re-added item shows its own. */
  private itemFrames = new Map<string, number>();
  setItemFrame(id: string, frame: number): void {
    const prev = this.itemFrames.get(id) ?? 0;
    this.itemFrames.set(id, frame);
    const item = this.itemMap.get(id);
    if (!item || prev === frame) return;
    item.setPartOpacity(framePartId(prev), 0);
    item.setPartOpacity(framePartId(frame), 1);
  }
  itemFrame(id: string): number | undefined {
    return this.itemFrames.get(id);
  }
  private applyItemFrame(id: string): void {
    const item = this.itemMap.get(id);
    const f = this.itemFrames.get(id);
    if (!item || !f) return;
    // A new item shows frame 0 (its part starts visible).
    item.setPartOpacity(framePartId(0), 0);
    item.setPartOpacity(framePartId(f), 1);
  }

  /** The idle weights set last (Mochi2D keeps them per model). */
  setIdleWeights(weights: Readonly<Record<string, number>>): void {
    const m = this.model;
    if (!m) return;
    for (const [id, w] of Object.entries(weights))
      if (Number.isFinite(w)) m.setIdleWeight(id, Math.max(0, Math.min(1, w)));
  }
  idleWeight(id: string): number {
    return this.model?.getIdleWeight(id) ?? 1;
  }
  resetIdleWeights(): void {
    this.model?.resetIdleWeights();
  }
  /** A parameter's base value (what the frame starts from), beside `parameterValue`'s drawn one. */
  parameterBase(id: string): number | undefined {
    return this.model && this.defaults.has(id) ? this.model.getParameterBase(id) : undefined;
  }

  // --- placement --------------------------------------------------------------

  setTransform(t: SceneTransform): void {
    this.transform = { ...t };
    this.applyTransform();
  }

  /**
   * Mochi Studio's transform: an offset of the model on screen in canvas
   * heights (x right, y down), a zoom, and a rotation in degrees, clockwise
   * as in CSS. Mochi2D's view (docs/api.md, "View coordinates") takes the
   * model point at the canvas center in model units, in the model's own
   * directions, and a counterclockwise rotation about the canvas center. So
   * the screen offset is turned into the model's directions, and the
   * rotation's sign flips. The model then turns about its own center.
   */
  private applyTransform(): void {
    const view = this.view;
    const c = this.canvas;
    if (!view || !c || !this.model) return;
    const t = this.transform;
    if (this.pixelsPerUnit === undefined) {
      const vt = view.viewTransform;
      if (!(vt.pixelsPerUnit > 0) || !(vt.zoom > 0)) return;
      this.pixelsPerUnit = vt.pixelsPerUnit / vt.zoom;
    }
    const ppu = this.pixelsPerUnit * t.zoom;
    const h = c.clientHeight;
    // The offset in CSS pixels, y up; then turned by −rotation into model directions.
    const sx = t.x * h;
    const sy = -t.y * h;
    const a = (-t.rotation * Math.PI) / 180;
    const mx = Math.cos(a) * sx + Math.sin(a) * sy;
    const my = -Math.sin(a) * sx + Math.cos(a) * sy;
    view.setView({ zoom: t.zoom, x: -mx / ppu, y: -my / ppu, rotation: -t.rotation });
  }

  // --- items ------------------------------------------------------------------

  /** Items being loaded, by id: the last load asked for. */
  private itemLoads = new Map<string, Promise<void>>();

  /**
   * One load at a time for each id: a second waits for the first, then
   * replaces it (two loads at once would give Mochi2D the same id twice).
   */
  addItem(
    id: string,
    files: ModelFileSet,
    state: { visible: boolean; placement?: ItemPlacement },
  ): Promise<void> {
    const before = this.itemLoads.get(id);
    const run = (before ? before.catch(() => undefined) : Promise.resolve()).then(() =>
      this.loadItem(id, files, state),
    );
    this.itemLoads.set(id, run);
    run
      .finally(() => {
        if (this.itemLoads.get(id) === run) this.itemLoads.delete(id);
      })
      .catch(() => undefined);
    return run;
  }

  private async loadItem(
    id: string,
    files: ModelFileSet,
    state: { visible: boolean; placement?: ItemPlacement },
  ): Promise<void> {
    // Replacing an item's files keeps its tint and its opacity (a plugin's brightness
    // redraws a still picture: its opacity stays).
    const previous = this.itemMap.get(id);
    const opacity = previous?.opacity;
    previous?.dispose();
    this.itemMap.delete(id);
    // Mochi2D knows the item by Mochi Studio's id, so copies keep their own places.
    const w = watched(toSource(files));
    let item: MochiItem;
    try {
      item = await this.v.addItem(w.source, {
        id,
        textures: itemTextureLimits(id),
        ...(state.placement ? { placement: state.placement } : {}),
      });
    } catch (e) {
      throw plainRefusal(
        e,
        id.startsWith(COLLAB_ITEM_PREFIX) ? 'Their model' : 'This item',
        w.head,
      );
    } finally {
      w.done();
    }
    item.visible = state.visible;
    if (opacity !== undefined) item.opacity = opacity;
    this.itemMap.set(id, item);
    this.applyItemTint(id);
    this.applyItemFrame(id);
  }

  /** Replaces an item's (first) texture in place (Mochi2D 0.14.0), for web items. */
  updateItemTexture(
    id: string,
    image: ImageBitmap | ImageData | { width: number; height: number; data: Uint8Array },
  ): void {
    const item = this.itemMap.get(id);
    if (!item) return;
    try {
      item.updateTexture(0, image as Parameters<typeof item.updateTexture>[1]);
    } catch (e) {
      console.warn('A web item frame did not fit its texture:', e);
    }
  }

  removeItem(id: string): void {
    this.itemMap.get(id)?.dispose();
    this.itemMap.delete(id);
    this.itemTints.delete(id);
    this.itemFrames.delete(id);
  }

  items(): RuntimeItem[] {
    return [...this.itemMap].map(([id, item]) => {
      const p = item.placement;
      return {
        id,
        visible: item.visible,
        placement: {
          x: p.x,
          y: p.y,
          scale: p.scale,
          rotation: p.rotation,
          front: p.front,
          ...(p.mirror ? { mirror: true } : {}),
        },
        pinned: !!item.pin,
      };
    });
  }

  setItemVisible(id: string, visible: boolean): void {
    const item = this.itemMap.get(id);
    if (item) item.visible = visible;
  }
  isItemVisible(id: string): boolean {
    return this.itemMap.get(id)?.visible ?? false;
  }
  placeItem(id: string, placement: Partial<ItemPlacement>): void {
    const item = this.itemMap.get(id);
    if (!item) return;
    const { front, mirror, ...rest } = placement;
    // Setting the side draws the item whole on it (Mochi2D 0.10.0): only when the side changes,
    // so an item between the model's layers stays there when it is merely restacked.
    if (front !== undefined && item.front !== front) item.front = front;
    // Mirroring keeps a pin (Mochi2D 0.7.0: pins follow the mirrored item).
    if (mirror !== undefined) item.mirror = mirror;
    if (Object.keys(rest).length) item.place(rest);
  }
  pinItem(id: string, pinned: boolean): boolean {
    const item = this.itemMap.get(id);
    if (!item) return false;
    if (!pinned) {
      item.unpin();
      return true;
    }
    return item.pinToModel();
  }
  setItemOpacity(id: string, v: number): void {
    const item = this.itemMap.get(id);
    if (item) item.opacity = Math.max(0, Math.min(1, v));
  }
  itemOpacity(id: string): number {
    return this.itemMap.get(id)?.opacity ?? 1;
  }
  /** Draws the items in this order on their sides (the last one on top). */
  stackItems(ids: readonly string[]): void {
    for (const id of ids) {
      const item = this.itemMap.get(id);
      if (!item) continue;
      item.raise();
    }
  }
  /**
   * The items' ids in drawing order, bottom first (within each side and
   * place): Mochi2D's `view.items`, which `raise()` reorders (0.12.0).
   */
  itemOrder(): string[] {
    return (this.view?.items ?? []).map((i) => i.id).filter((id) => this.itemMap.has(id));
  }
  /**
   * Where an item is drawn among the main model's art meshes, and its split
   * (Mochi2D 0.10.0): null for an item drawn whole on its side.
   */
  itemSort(id: string): { layer: ItemMeshPlace | null; split: ItemSplit | null } | undefined {
    const p = this.itemMap.get(id)?.placement;
    return p ? { layer: p.layer ?? null, split: p.split ?? null } : undefined;
  }
  /**
   * Draws an item at a place in the main model's render order, or on a side
   * (`'front'`, `'behind'`), and split or whole. A place whose art mesh the
   * main model lacks is kept: Mochi2D draws the item on its side until a
   * model has that art mesh.
   */
  setItemSort(id: string, layer: ItemDepth, split: ItemSplit | null): void {
    const item = this.itemMap.get(id);
    if (!item) return;
    if (layer === 'front' || layer === 'behind')
      item.place({ front: layer === 'front', layer: null, split });
    else item.place({ layer, split });
  }
  /** Where an item is pinned: the art mesh, triangle vertices and weights. */
  itemPin(
    id: string,
  ): { drawable: string; vertices: readonly number[]; weights: readonly number[] } | undefined {
    const p = this.itemMap.get(id)?.pin;
    return p ? { drawable: p.drawable, vertices: p.vertices, weights: p.weights } : undefined;
  }
  /** Pins an item to a triangle of an art mesh of the main model; false when it cannot be. */
  pinItemTo(id: string, drawable: string, triangle: number, weights: readonly number[]): boolean {
    const item = this.itemMap.get(id);
    if (!item) return false;
    const e = item.exportLayout();
    return item.applyLayout({
      placement: e.placement,
      opacity: e.opacity,
      visible: e.visible,
      pin: { drawable, triangle, weights: [...weights] },
    });
  }
  /** The triangle list (vertex indices) of a main-model art mesh, or undefined. */
  meshTriangles(id: string): ArrayLike<number> | undefined {
    const moc = this.model?.runtime.model;
    const i = moc?.meshes.ids.indexOf(id) ?? -1;
    return i >= 0 ? moc!.meshes.triangles[i] : undefined;
  }
  /** A main-model art mesh's vertices now (model units, x, y pairs), or undefined. */
  meshVertices(id: string): Float32Array | undefined {
    const m = this.model;
    const i = m?.runtime.model.meshes.ids.indexOf(id) ?? -1;
    return i >= 0 ? m!.runtime.instance.drawableVertices[i] : undefined;
  }
  /** A main-model art mesh's own opacity now (0 when hidden), or undefined. */
  meshOpacity(id: string): number | undefined {
    const m = this.model;
    const i = m?.runtime.model.meshes.ids.indexOf(id) ?? -1;
    return i >= 0 ? m!.runtime.instance.drawableOpacity[i] : undefined;
  }
  /** An item's own art meshes. */
  itemArtMeshIds(id: string): string[] {
    const item = this.itemMap.get(id);
    return item ? [...item.runtime.model.meshes.ids] : [];
  }
  /** Page coordinates to the main model's units (y up), and back. */
  pageToModel(x: number, y: number): { x: number; y: number } | undefined {
    return this.view?.toModel(x, y) ?? undefined;
  }
  modelToPage(x: number, y: number): { x: number; y: number } | undefined {
    return this.view?.toPage(x, y) ?? undefined;
  }
  /**
   * The bounding-box corners of the visible art meshes, in page coordinates
   * (for the model's outline: corners rather than centres, so that a model
   * of one or two meshes has an outline too).
   */
  meshBoxCorners(): Array<{ x: number; y: number }> {
    const m = this.model;
    if (!m || !this.view) return [];
    const moc = m.runtime.model;
    const inst = m.runtime.instance;
    const out: Array<{ x: number; y: number }> = [];
    moc.meshes.ids.forEach((_id, i) => {
      if (!inst.drawableVisible[i] || !(inst.drawableOpacity[i]! > 0)) return;
      const v = inst.drawableVertices[i];
      if (!v || v.length < 2) return;
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (let k = 0; k + 1 < v.length; k += 2) {
        x0 = Math.min(x0, v[k]!);
        x1 = Math.max(x1, v[k]!);
        y0 = Math.min(y0, v[k + 1]!);
        y1 = Math.max(y1, v[k + 1]!);
      }
      for (const [x, y] of [
        [x0, y0],
        [x1, y0],
        [x1, y1],
        [x0, y1],
      ] as const) {
        const p = this.view!.toPage(x, y);
        if (p) out.push(p);
      }
    });
    return out;
  }
  itemAt(clientX: number, clientY: number): string | undefined {
    const id = this.view?.itemAt(clientX, clientY)?.id;
    return id !== undefined && this.itemMap.has(id) ? id : undefined;
  }

  /**
   * Mochi2D's item layout: entries carry the items' ids (Mochi Studio's), in
   * drawing order, which applying it restores (Mochi2D 0.12.0).
   */
  exportItemLayout(): unknown {
    const layout = this.view?.exportItemLayout();
    // Collaborators' avatars (ids "collab:…") are never part of the saved layout.
    if (layout && Array.isArray((layout as { items?: unknown }).items))
      return {
        ...layout,
        items: (layout as { items: { id?: string }[] }).items.filter(
          (e) => !e.id?.startsWith(COLLAB_ITEM_PREFIX),
        ),
      };
    return layout;
  }

  // --- collaborators' avatars ------------------------------------

  /** Base values for an item's parameters (a collaborator's avatar). */
  setItemParameters(id: string, values: Readonly<Record<string, number>>): void {
    const item = this.itemMap.get(id);
    if (!item) return;
    for (const [p, v] of Object.entries(values)) item.setParameter(p, v);
  }

  setItemExpression(id: string, file: string, on: boolean): void {
    const item = this.itemMap.get(id);
    if (!item) return;
    void Promise.resolve(on ? item.addExpression(file) : item.removeExpression(file)).catch(
      () => undefined,
    );
  }

  startItemMotion(id: string, file: string): void {
    void this.itemMap
      .get(id)
      ?.startMotionFile(file)
      .catch(() => undefined);
  }

  /** Draws the items in this order, bottom to top, over the other items. */
  raiseItems(ids: readonly string[]): void {
    for (const id of ids) this.itemMap.get(id)?.raise();
  }

  /**
   * How tall the main model's canvas rectangle is on screen, in canvas
   * heights: what another app needs to draw this model at the same size.
   */
  modelAspect(): number | undefined {
    const c = this.model?.canvas;
    return c && c.top > c.bottom ? (c.right - c.left) / (c.top - c.bottom) : undefined;
  }

  stageHeight(): number | undefined {
    const m = this.model;
    const c = this.canvas;
    const vt = this.view?.viewTransform;
    if (!m || !c || !vt || !c.clientHeight) return undefined;
    return (vt.pixelsPerUnit * (m.canvas.top - m.canvas.bottom)) / c.clientHeight;
  }

  /**
   * Places an item where another app shows its model: the canvas centre at
   * `x`, `y` (canvas heights from this canvas's centre, y down), its canvas
   * rectangle `height` canvas heights tall, turned `rotation` degrees
   * clockwise on screen, in front of the main model or behind it.
   */
  placeItemOnStage(
    id: string,
    s: { x: number; y: number; height: number; rotation: number; front: boolean },
  ): void {
    const item = this.itemMap.get(id);
    const m = this.model;
    const c = this.canvas;
    const view = this.view;
    if (!item || !m || !c || !view) return;
    const r = c.getBoundingClientRect();
    const at = view.toModel(
      r.left + r.width / 2 + s.x * r.height,
      r.top + r.height / 2 + s.y * r.height,
    );
    const mainPpu = m.runtime.model.canvas.pixelsPerUnit;
    const itemPx = item.runtime.model.canvas.height;
    const screenPpu = view.viewTransform.pixelsPerUnit;
    if (!at || !(itemPx > 0) || !(screenPpu > 0) || !(mainPpu > 0)) return;
    // On screen: itemPx · scale / mainPpu main units, × screenPpu pixels per unit.
    const scale = (s.height * r.height * mainPpu) / (itemPx * screenPpu);
    item.place({
      x: at.x,
      y: at.y,
      scale,
      rotation: this.transform.rotation - s.rotation,
      front: s.front,
    });
  }
  applyItemLayout(layout: unknown): void {
    if (!this.view || !layout || typeof layout !== 'object') return;
    try {
      const { mochiStudioOrder: order, ...rest } = layout as { mochiStudioOrder?: unknown };
      this.view.applyItemLayout(layoutWithIds(rest as ItemLayout));
      // Layouts saved before Mochi2D 0.12.0 listed items as added, with the order beside them.
      if (Array.isArray(order))
        this.stackItems(order.filter((id): id is string => typeof id === 'string'));
    } catch (e) {
      console.warn('Could not apply the item layout:', e);
    }
  }

  // --- lip sync ---------------------------------------------------------------

  get lipSyncParameter(): string | undefined {
    if (!this.files) return undefined;
    const ids = this.files.manifest.groups.LipSync;
    return ids?.length
      ? ids[0]
      : this.defaults.has('ParamMouthOpenY')
        ? 'ParamMouthOpenY'
        : undefined;
  }

  /**
   * Starts live lip sync from the microphone (`deviceId`, or the browser's
   * choice). Mochi2D opens it; it keeps running while the page is hidden, as
   * a streaming setup needs. Without a model it starts with the next one.
   */
  async startLipSync(deviceId?: string, opts: LiveAudioOptions = {}): Promise<void> {
    this.micDevice = deviceId ?? '';
    this.micOptions = opts;
    const m = this.model;
    if (!m) return;
    const control = await m.startLiveLipSync({
      ...(opts.stream ? { stream: opts.stream } : deviceId ? { deviceId } : {}),
      ...(opts.voiceProcessing !== undefined ? { voiceProcessing: opts.voiceProcessing } : {}),
      releaseWhenHidden: false,
      mix: this.lipMix,
    });
    control.settings.gain = DEFAULT_LIVE_GAIN * this.lipGain;
    control.settings.gate = this.lipGate;
  }

  // --- motion sync and voice calibration ---------------------------

  /** The settings of the model's motion-sync file (ID, name, whether they run). */
  motionSyncSettings(): ReadonlyArray<{ id: string; name: string; usable: boolean }> {
    return this.model?.motionSyncSettings ?? [];
  }

  /**
   * Live motion sync from `stream` through a setting of the model's file:
   * its own shapes move the mouth (Mochi2D's analysis). Live lip sync stops.
   */
  async startMotionSync(setting: string, stream: MediaStream): Promise<void> {
    const m = this.model;
    if (!m) return;
    this.micDevice = undefined;
    m.stopLiveLipSync();
    // Mochi2D's default: the file's per-parameter smoothing (`Smooth`) off; the analysis's own
    // smoothing and the file's dead band apply.
    await m.startLiveMotionSync({ setting, stream, releaseWhenHidden: false });
  }

  stopMotionSync(): void {
    this.model?.stopLiveMotionSync();
  }

  /** The latest live motion-sync analysis, or undefined when none runs. */
  motionSyncTick(): MotionSyncTick | undefined {
    const c = this.model?.liveMotionSync;
    return c && c.state !== 'stopped' ? (c.tick ?? undefined) : undefined;
  }

  /** The voice profile the model's motion sync analyzes with (null: Mochi2D's neutral voice). */
  setVoiceProfile(profile: StoredVoiceProfile | null): void {
    this.voiceProfile = profile as VoiceProfile | null;
    this.model?.setVoiceProfile(this.voiceProfile);
  }

  /** Records a clip of the microphone (or `stream`), mono, for voice calibration. */
  recordAudio(
    seconds: number,
    opts: LiveAudioOptions & { deviceId?: string } = {},
  ): Promise<{
    sampleRate: number;
    channels: [Float32Array];
  }> {
    return this.v.recordAudio(seconds, {
      ...(opts.stream ? { stream: opts.stream } : opts.deviceId ? { deviceId: opts.deviceId } : {}),
      ...(opts.voiceProcessing !== undefined ? { voiceProcessing: opts.voiceProcessing } : {}),
    });
  }

  setLipSyncMix(mix: 'add' | 'max'): void {
    this.lipMix = mix;
    const c = this.model?.liveLipSync;
    if (c && c.mix !== mix) c.mix = mix;
  }

  setLipSyncGate(db: number): void {
    this.lipGate = db;
    const c = this.model?.liveLipSync;
    if (c) c.settings.gate = db;
  }

  stopLipSync(): void {
    this.micDevice = undefined;
    this.micOptions = {};
    this.model?.stopLiveLipSync();
  }

  setLipSyncGain(gain: number): void {
    this.lipGain = gain;
    const c = this.model?.liveLipSync;
    if (c) c.settings.gain = DEFAULT_LIVE_GAIN * gain;
  }

  lipSyncValue(): number | undefined {
    const c = this.model?.liveLipSync;
    return c && c.state !== 'stopped' ? c.value : undefined;
  }

  lipSyncLevel(): number | undefined {
    const c = this.model?.liveLipSync;
    if (!c || c.state === 'stopped') return undefined;
    // Mochi2D's level is a linear RMS; in dBFS, 20·log10(level) (docs/api.md).
    return c.level > 0 ? 20 * Math.log10(c.level) : -Infinity;
  }

  // --- frame ------------------------------------------------------------------

  async speak(audio: Uint8Array, volume: number, play = true): Promise<void> {
    const m = this.model;
    if (!m) return;
    await m.speak(audio, { volume, play });
  }

  screenshot(): Promise<Blob> {
    return this.v.screenshot();
  }

  render(dtMs: number, draw = true): void {
    const view = this.view;
    if (!view) return;
    this.applyWind();
    view.advance(Math.max(0, dtMs) / 1000, { draw });
    this.keepIdle();
    // Mochi2D names a motion sound that won't play when it was to play.
    const warnings = this.model?.warnings;
    if (warnings && warnings.length > this.warningsSeen) {
      for (const text of warnings.slice(this.warningsSeen))
        this.events.emit('modelNotice', { text });
      this.warningsSeen = warnings.length;
    }
    if (this.pixelsPerUnit === undefined && this.model) this.applyTransform();
  }

  on<K extends keyof RuntimeEvents>(type: K, fn: (p: RuntimeEvents[K]) => void): () => void {
    return this.events.on(type, fn);
  }
}

/** Mochi2D's default live lip-sync gain (docs/api.md); Mochi Studio's gain 1. */
const DEFAULT_LIVE_GAIN = LIVE_LIP_SYNC_DEFAULTS.gain;

/** Barycentric weights of (x, y) in a triangle, or undefined outside it. */
function barycentric(
  x: number,
  y: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): number[] | undefined {
  const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
  if (Math.abs(d) < 1e-12) return undefined;
  const w1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / d;
  const w2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / d;
  const w3 = 1 - w1 - w2;
  const e = -1e-6;
  return w1 >= e && w2 >= e && w3 >= e ? [w1, w2, w3] : undefined;
}

/** A tint (RGBA 0–1, none: white) times the light's color. */
function lit(rgba: readonly number[] | undefined, light: readonly number[]): number[] {
  const t = rgba ?? [1, 1, 1, 1];
  return [(t[0] ?? 1) * light[0]!, (t[1] ?? 1) * light[1]!, (t[2] ?? 1) * light[2]!, t[3] ?? 1];
}
