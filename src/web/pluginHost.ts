/**
 * The page's side of the plugin API (for plugins made for VTube Studio):
 * it answers the requests the bridge forwards (model, hotkeys, expressions,
 * parameters, tints), applies injected values to the tracking inputs, and
 * sends the events. The bridge's side is bridge/src/plugins.ts; the
 * protocol is src/core/plugins/protocol.ts.
 *
 * Privacy (policy 3): tracked input values, and model
 * parameters that tracking drives, read as their defaults unless the person
 * has allowed that plugin to read tracking data. A plugin may always read
 * what it injects itself, whether a face is found, and custom parameters.
 */
import { parseExpression, parseMotion, parseUserData } from 'mochi2d/headless';
import type { Hotkey } from '../core/hotkeys';
import {
  easeTransform,
  expressionNameFromFile,
  fromProtocolPosition,
  hotkeyType,
  isModelId,
  matchArtMeshes,
  modelIdFor,
  moveTarget,
  tagsFromUserData,
  tintColor,
  toProtocolPosition,
  type Tint,
} from '../core/plugins/helpers';
import { InjectionState, type ResolvedParameter } from '../core/plugins/injection';
import { DEFAULT_PARAMETERS, defaultParameter, pluginInputId } from '../core/plugins/inputs';
import {
  APP_NAME,
  APP_VERSION,
  E,
  expressionFadeTime,
  type BridgeToHostPlugin,
  type CustomParameter,
  type PluginAnswer,
  type PluginCaller,
  type PluginInfo,
} from '../core/plugins/protocol';
import type { SceneTransform } from '../core/scene';
import { Emitter } from '../core/events';
import { setExtraInputs } from '../core/tracking';
import { physicsFpsSetting } from '../core/physicsTuning';
import { overlayInfo } from '../core/lightOverlay';
import { apiKeyCombination } from '../core/apiKeyNames';
import type { AgentLink } from './agentLink';
import { desktopApi, desktopSourcePath, openRecentFolder, type RecentModel } from './desktopFiles';
import type { MochiRuntime } from './mochiRuntime';
import { displayNameFor } from './displayNames';
import { PluginItems } from './pluginItems';
import type { Studio } from './studio';
import { convexHull, pageToWindow, windowToPage } from '../core/plugins/items';
import {
  atEdge,
  boundaryLoops,
  pointOn,
  resampleLoop,
  ringArea,
  triangleFrame,
  type EdgePoint,
  type TrackedPoint,
} from '../core/plugins/meshGeometry';

/** One hotkey leaves the queue every 5 frames; the queue holds 32. */
const HOTKEY_QUEUE = 32;
const HOTKEY_EVERY_FRAMES = 5;
/** A hotkey runs at most once per 5 frames (the README's reading; not documented). */
const HOTKEY_COOLDOWN_FRAMES = 5;
const MODEL_LOAD_COOLDOWN_MS = 2000;

export type PluginHostEvents = {
  /** The server's state or the allowed plugins changed. */
  changed: undefined;
  /** A plugin asks to be allowed; answer with `approve`. */
  approval: {
    requestId: string;
    name: string;
    developer: string;
    icon: string;
    permission?: string;
  };
  approvalCancelled: { requestId: string };
  /** A plugin asks the person to pick art meshes; answer with `answerSelection`. */
  selection: {
    id: string;
    pluginName: string;
    text: string;
    help: string;
    count: number;
    meshes: string[];
    active: string[];
  };
  selectionEnd: { id: string };
  /** The person clicked the model while choosing: the art meshes under the pointer. */
  selectionFilter: { meshes: string[] };
  /** Whether to draw the model's outline (a plugin asked), and its points in page pixels. */
  outline: { points: Array<{ x: number; y: number }> | undefined };
  /** ArtMeshAtPositionRequest's `visualize`: a dot at a page point for a few seconds. */
  marker: { x: number; y: number; seconds: number };
};

/** The default text of the art-mesh selection. */
const SELECTION_TEXT = 'A plugin asks you to choose parts of the model (art meshes).';
const SELECTION_HELP =
  'Tick the art meshes in the list, or click the model to list only the ones under the pointer. OK sends your choice to the plugin; Cancel sends nothing chosen.';

/** A subscription to a beta event computed per session. */
interface MeshJob {
  session: string;
  name: string;
  config: Record<string, unknown>;
  json: string;
  nextAt: number;
  sentNoModel: boolean;
  /** The model the references and shapes below belong to. */
  modelID: string;
  /** Tracking points: their triangle's angle and length when first seen. */
  refs: Map<string, { angle: number; length: number }>;
  /** Outlines: each mesh's rings, as points on edges. */
  shapes: Map<string, EdgePoint[][]>;
}

interface ModelMeta {
  id: string;
  /** The display name, or the file name. */
  name: string;
  /** The folder or zip name. */
  fileName: string;
  loadMs: number;
  loadedAt: number;
  textureResolution: number;
  tags: Map<string, string[]>;
}

export class PluginHost {
  readonly events = new Emitter<PluginHostEvents>();
  on = false;
  port: number | null = null;
  problem: string | undefined;
  plugins: PluginInfo[] = [];
  parameters: CustomParameter[] = [];
  readonly injection = new InjectionState();
  private queue: Array<{ id: string }> = [];
  private lastRun = new Map<string, number>();
  private frame = 0;
  private firingFromApi = false;
  private move: { from: SceneTransform; to: SceneTransform; start: number; ms: number } | undefined;
  /** Tints by art-mesh index: which session set them, latest last. */
  private tintBy = new Map<number, { session: string; tint: Tint }>();
  private meta: ModelMeta | undefined;
  private loadStarted = 0;
  private lastModelLoad = -Infinity;
  private loading = false;
  private lastConfig = '';
  private lastHotkeys = '';
  private configTimer: ReturnType<typeof setTimeout> | undefined;
  private lastBackground = '';
  private lastItems = new Map<string, string>();
  private motionStarts = new Map<string, number>();
  private motionLengths = new Map<string, number>();
  readonly items: PluginItems;
  /** Events some plugin subscribes to, and whether one wants the outline drawn. */
  private subscribed = new Set<string>();
  private drawOutline = false;
  private lastMoved = '';
  private lastOutline = 0;
  /** The beta events computed per subscription (ArtMeshTrackingEvent, ArtMeshOutlineEvent). */
  private meshJobs = new Map<string, MeshJob>();
  /** The expressions that were on, for ExpressionToggledEvent. */
  private lastExpressions = new Set<string>();
  private lastNdiSet = -Infinity;
  private selection:
    | {
        id: string;
        session: string;
        meshes: string[];
        answer: (active: string[] | undefined) => void;
      }
    | undefined;
  private fpsFrames = 0;
  private fpsAt = performance.now();
  framerate = 0;

  constructor(
    private studio: Studio,
    private runtime: MochiRuntime,
    private link: AgentLink,
    private canvas: HTMLCanvasElement,
  ) {
    this.items = new PluginItems(studio, runtime, canvas, () => this.meta?.id ?? '');
    link.events.on('plugin', (m) => this.onBridge(m));
    studio.plugins = {
      active: (t) => this.on && this.injection.active(t),
      apply: (inputs, t) => this.injection.apply(inputs, t),
      faceFound: (t) => this.on && this.injection.faceFound(t),
      injectedInputs: (t) => (this.on ? this.injection.injectedInputs(t) : new Map()),
    };
    this.watchStudio();
    const tick = (): void => {
      this.tick();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // --- the bridge ----------------------------------------------------------------

  private onBridge(m: BridgeToHostPlugin): void {
    switch (m.type) {
      case 'plugins':
        this.on = m.on;
        this.port = m.port;
        this.problem = m.problem;
        this.plugins = m.plugins;
        this.parameters = m.parameters;
        this.subscribed = new Set(m.subscribed ?? []);
        this.drawOutline = m.on && m.drawOutline === true;
        this.syncMeshJobs(m.sessionEvents ?? []);
        if (m.on) this.sendExpressionList();
        if (!this.drawOutline) this.events.emit('outline', { points: undefined });
        for (const p of this.plugins) if (!p.sessions) this.injection.endPlugin(p.id);
        this.updateInputs();
        this.events.emit('changed', undefined);
        return;
      case 'plugin_approval_request':
        return this.events.emit('approval', m);
      case 'plugin_approval_cancel':
        return this.events.emit('approvalCancelled', m);
      case 'plugin_session_end':
        this.injection.endSession(m.session);
        this.endTints(m.session);
        this.studio.endPhysicsOverrides(m.session);
        this.items.sessionEnded(m.session);
        if (this.selection?.session === m.session) this.selection.answer(undefined);
        return;
      case 'plugin_request':
        void this.answer(m.plugin, m.messageType, m.data)
          .catch((e): PluginAnswer => ({ errorID: E.internal, message: (e as Error).message }))
          .then((a) => this.link.sendPlugin({ type: 'plugin_result', id: m.id, ...a }));
        return;
    }
  }

  /** The person's answer to a plugin asking to be allowed. */
  approve(requestId: string, allow: boolean): void {
    this.link.sendPlugin({ type: 'plugin_approval', requestId, allow });
  }
  revoke(pluginId: string): void {
    this.injection.endPlugin(pluginId);
    this.link.sendPlugin({ type: 'plugin_revoke', pluginId });
  }
  /** The person takes a permission back (for example LoadCustomImagesAsItems). */
  revokePermission(pluginId: string, permission: string): void {
    this.link.sendPlugin({ type: 'plugin_permission', pluginId, permission, granted: false });
  }
  setTrackingData(pluginId: string, on: boolean): void {
    this.link.sendPlugin({ type: 'plugin_grant', pluginId, trackingData: on });
  }

  get connectedPlugins(): PluginInfo[] {
    return this.plugins.filter((p) => p.sessions > 0);
  }

  /** Plugin inputs for the mapping editor: custom parameters, and default ones Mochi Studio does not track. */
  private updateInputs(): void {
    setExtraInputs([
      ...this.parameters.map((p) => ({
        id: pluginInputId(p.name),
        label: `${p.name} (from the plugin ${p.pluginName})`,
        kind: 'centered' as const,
        min: p.min,
        max: p.max,
      })),
      ...DEFAULT_PARAMETERS.filter((p) => !p.tracked).map((p) => ({
        id: p.input,
        label: `${p.name} (from plugins)`,
        kind: 'closed' as const,
        min: p.min,
        max: p.max,
      })),
    ]);
  }

  // --- each frame ----------------------------------------------------------------

  private tick(): void {
    this.frame++;
    this.fpsFrames++;
    const now = performance.now();
    if (now - this.fpsAt >= 1000) {
      this.framerate = Math.round((this.fpsFrames * 1000) / (now - this.fpsAt));
      this.fpsFrames = 0;
      this.fpsAt = now;
    }
    if (this.frame % HOTKEY_EVERY_FRAMES === 0) {
      const next = this.queue.shift();
      if (next) {
        this.lastRun.set(next.id, this.frame);
        this.firingFromApi = true;
        try {
          this.studio.fireHotkey(next.id);
        } finally {
          this.firingFromApi = false;
        }
      }
    }
    this.items.tick(now);
    this.geometryEvents(now);
    this.meshEvents(now);
    const mv = this.move;
    if (mv && this.studio.settings) {
      const t = mv.ms > 0 ? (now - mv.start) / mv.ms : 1;
      this.studio.updateSettings({ transform: easeTransform(mv.from, mv.to, Math.min(1, t)) });
      if (t >= 1) this.move = undefined;
    }
  }

  // --- requests ------------------------------------------------------------------

  private async answer(
    caller: PluginCaller,
    type: string,
    data: Record<string, unknown>,
  ): Promise<PluginAnswer> {
    const s = this.studio;
    const ok = (d: Record<string, unknown>): PluginAnswer => ({ data: d });
    const fail = (errorID: number, message: string): PluginAnswer => ({ errorID, message });
    const model = s.model;
    const meta = this.meta;
    const head = {
      modelLoaded: !!model,
      modelName: model ? (meta?.name ?? '') : '',
      modelID: model ? (meta?.id ?? '') : '',
    };
    switch (type) {
      case 'StatisticsRequest':
        return ok({
          uptime: Math.round(performance.now()),
          framerate: this.framerate,
          vTubeStudioVersion: APP_VERSION,
          allowedPlugins: this.plugins.length,
          connectedPlugins: this.connectedPlugins.length,
          startedWithSteam: false,
          windowWidth: this.canvas.clientWidth,
          windowHeight: this.canvas.clientHeight,
          windowIsFullscreen: !!document.fullscreenElement,
        });

      case 'CurrentModelRequest': {
        const t = s.settings?.transform;
        return ok({
          modelLoaded: !!model,
          modelName: head.modelName,
          modelID: head.modelID,
          vtsModelName: '',
          vtsModelIconName: '',
          live2DModelName: model ? (model.manifest.file.split('/').pop() ?? '') : '',
          modelLoadTime: model ? Math.round(meta?.loadMs ?? 0) : 0,
          timeSinceModelLoaded: model ? Math.round(performance.now() - (meta?.loadedAt ?? 0)) : 0,
          numberOfLive2DParameters: model ? (s.info?.parameters.length ?? 0) : 0,
          numberOfLive2DArtmeshes: model ? this.runtime.artMeshIds().length : 0,
          numberOfTextures: model ? model.manifest.textures.length : 0,
          hasPhysicsFile: !!model?.manifest.physics,
          textureResolution: model ? (meta?.textureResolution ?? 0) : 0,
          modelPosition:
            model && t
              ? toProtocolPosition(t, this.canvas.clientWidth, this.canvas.clientHeight)
              : { positionX: 0, positionY: 0, rotation: 0, size: 0 },
        });
      }

      case 'AvailableModelsRequest': {
        const list = await this.availableModels();
        return ok({
          numberOfModels: list.length,
          availableModels: list.map((m) => ({
            modelLoaded: m.id === head.modelID && !!model,
            modelName: m.name,
            modelID: m.id,
            vtsModelName: '',
            vtsModelIconName: '',
          })),
        });
      }

      case 'ModelLoadRequest': {
        if (!('modelID' in data) || data.modelID === undefined || data.modelID === null)
          return fail(E.modelIdMissing, 'modelID is missing.');
        const id = data.modelID;
        if (typeof id !== 'string' || (id !== '' && !isModelId(id)))
          return fail(E.modelIdInvalid, 'modelID must be 32 hexadecimal characters, or empty.');
        if (this.loading) return fail(E.modelCannotChange, 'A model is loading now.');
        const now = performance.now();
        if (now - this.lastModelLoad < MODEL_LOAD_COOLDOWN_MS)
          return fail(E.modelLoadCooldown, 'Wait 2 seconds between model loads.');
        if (id === '') {
          if (model) {
            this.lastModelLoad = now;
            s.unloadModel();
          }
          return ok({ modelID: '' });
        }
        if (model && id.toLowerCase() === head.modelID) return ok({ modelID: head.modelID });
        const target = (await this.availableModels()).find((m) => m.id === id.toLowerCase());
        if (!target?.recent) return fail(E.modelNotFound, 'No available model has this ID.');
        const disk = this.link.diskAccess;
        if (!disk) return fail(E.modelCannotChange, 'The app’s bridge is not ready.');
        this.lastModelLoad = now;
        this.loading = true;
        // The answer comes at once; ModelLoadedEvent says when it is shown.
        void openRecentFolder(target.recent, disk.http, disk.token)
          .then((files) => s.loadModel(files))
          .catch((e) => console.warn('Plugin model load:', e))
          .finally(() => (this.loading = false));
        return ok({ modelID: target.id });
      }

      case 'MoveModelRequest': {
        if (!model || !s.settings) return fail(E.moveNoModel, 'No model is loaded.');
        const w = this.canvas.clientWidth;
        const h = this.canvas.clientHeight;
        const current = toProtocolPosition(s.settings.transform, w, h);
        // Relative moves count from where the model is now (a running move stops).
        const r = moveTarget(data, current);
        if ('errorID' in r) return fail(r.errorID, r.message);
        const from = s.settings.transform;
        const to = fromProtocolPosition(r.target, w, h);
        // Rotation: from the current angle the short way to the target, unless relative.
        to.rotation =
          data.valuesAreRelativeToModel === true
            ? from.rotation + (r.target.rotation - current.rotation)
            : from.rotation + ((((r.target.rotation - from.rotation) % 360) + 540) % 360) - 180;
        this.move = { from, to, start: performance.now(), ms: r.seconds * 1000 };
        if (r.seconds === 0) this.tick();
        return ok({});
      }

      case 'HotkeysInCurrentModelRequest': {
        const wanted = data.modelID;
        const item = data.live2DItemFileName;
        if (typeof wanted === 'string' && wanted) {
          if (wanted.toLowerCase() === head.modelID && model)
            return ok({ ...head, availableHotkeys: this.hotkeyList() });
          const known = (await this.availableModels()).find((m) => m.id === wanted.toLowerCase());
          if (!known) return fail(E.modelNotFound, 'No model has this ID.');
          // Another model's hotkeys are in its own settings, read when it loads.
          return ok({
            modelLoaded: false,
            modelName: known.name,
            modelID: known.id,
            availableHotkeys: [],
          });
        }
        if (typeof item === 'string' && item)
          return ok({ ...head, modelLoaded: false, availableHotkeys: [] });
        return ok({ ...head, availableHotkeys: model ? this.hotkeyList() : [] });
      }

      case 'HotkeyTriggerRequest': {
        const key = data.hotkeyID;
        if (typeof data.itemInstanceID === 'string' && data.itemInstanceID) {
          const exists = s.items.some((i) => i.id === data.itemInstanceID);
          return exists
            ? fail(E.hotkeyItemUnsupported, 'Items in Mochi Studio have no hotkeys of their own.')
            : fail(E.hotkeyItemNotFound, 'No item has this instance ID.');
        }
        if (!model) return fail(E.hotkeyNoModel, 'No model is loaded.');
        const list = s.settings?.hotkeys ?? [];
        const k = typeof key === 'string' ? key : '';
        const h =
          list.find((x) => x.id === k) ??
          list.find((x) => x.label && x.label.toLowerCase() === k.toLowerCase());
        if (!k || !h) return fail(E.hotkeyNotFound, `No hotkey "${k}".`);
        if (this.queue.length >= HOTKEY_QUEUE)
          return fail(E.hotkeyQueueFull, 'The hotkey queue is full.');
        const last = this.lastRun.get(h.id);
        const queued = this.queue.some((q) => q.id === h.id);
        if (queued || (last !== undefined && this.frame - last < HOTKEY_COOLDOWN_FRAMES))
          return fail(E.hotkeyCooldown, 'This hotkey just ran; try again in a moment.');
        this.queue.push({ id: h.id });
        return ok({ hotkeyID: h.id });
      }

      case 'ExpressionStateRequest': {
        const file = data.expressionFile;
        const details = data.details === true;
        let list = model?.manifest.expressions ?? [];
        if (typeof file === 'string' && file) {
          if (!/\.exp3\.json$/i.test(file))
            return fail(E.expressionStateInvalidFile, 'expressionFile must end in .exp3.json.');
          list = list.filter((e) => sameFile(e.file, file));
          if (!list.length)
            return fail(E.expressionStateNotFound, `The model has no expression ${file}.`);
        }
        const expressions = await Promise.all(
          list.map(async (e) => ({
            name: expressionNameFromFile(e.file),
            file: e.file,
            active: s.activeExpressions.has(e.name),
            deactivateWhenKeyIsLetGo: false,
            autoDeactivateAfterSeconds: false,
            secondsRemaining: 0,
            usedInHotkeys: details
              ? (s.settings?.hotkeys ?? [])
                  .filter((h) => h.action.type === 'expression' && h.action.expression === e.name)
                  .map((h) => ({ name: h.label, id: h.id }))
              : [],
            parameters: details ? await this.expressionParameters(e.file) : [],
          })),
        );
        return ok({ ...head, expressions: model ? expressions : [] });
      }

      case 'ExpressionActivationRequest': {
        const file = data.expressionFile;
        if (typeof file !== 'string' || !/\.exp3\.json$/i.test(file))
          return fail(E.expressionInvalidFile, 'expressionFile must end in .exp3.json.');
        if (!model) return fail(E.expressionNoModel, 'No model is loaded.');
        const e = model.manifest.expressions.find((x) => sameFile(x.file, file));
        if (!e) return fail(E.expressionNotFound, `The model has no expression ${file}.`);
        // fadeTime: 0 to 2 seconds, 0.25 by default, when switching on; switching off reuses it
        // Mochi2D keeps the fade-out given with the expression.
        if (data.active === true) s.setExpression(e.name, true, expressionFadeTime(data.fadeTime));
        else s.setExpression(e.name, false);
        return ok({});
      }

      case 'FaceFoundRequest':
        return ok({ found: s.faceVisible || this.injection.faceFound(performance.now()) });

      case 'InputParameterListRequest': {
        const now = performance.now();
        return ok({
          ...head,
          customParameters: this.parameters.map((p) => this.customEntry(p, now)),
          defaultParameters: DEFAULT_PARAMETERS.map((p) => this.defaultEntry(caller, p.name, now)),
        });
      }

      case 'ParameterValueRequest': {
        const name = typeof data.name === 'string' ? data.name : '';
        const now = performance.now();
        const custom = this.parameters.find((p) => p.name === name);
        if (custom) return ok(this.customEntry(custom, now));
        if (defaultParameter(name)) return ok(this.defaultEntry(caller, name, now));
        return fail(E.parameterNotFound, `No input parameter "${name}".`);
      }

      case 'Live2DParameterListRequest': {
        const driven = new Set(
          (s.settings?.mapping ?? [])
            .filter((r) => r.enabled && !r.input.startsWith('plugin.'))
            .map((r) => r.output),
        );
        return ok({
          ...head,
          parameters: model
            ? (s.info?.parameters ?? []).map((p) => {
                const hidden = !caller.trackingData && driven.has(p.id);
                return {
                  name: p.id,
                  value: hidden
                    ? (p.default ?? 0)
                    : (this.runtime.parameterValue(p.id) ?? p.default ?? 0),
                  min: p.min ?? 0,
                  max: p.max ?? 1,
                  defaultValue: p.default ?? 0,
                };
              })
            : [],
        });
      }

      case 'InjectParameterDataRequest':
        return this.injection.inject(caller, data, (n) => this.resolve(n), performance.now());

      case 'ArtMeshListRequest': {
        const ids = model ? this.runtime.artMeshIds() : [];
        const tags = [...new Set(ids.flatMap((id) => meta?.tags.get(id) ?? []))];
        return ok({
          modelLoaded: !!model,
          numberOfArtMeshNames: ids.length,
          artMeshNames: ids,
          numberOfArtMeshTags: tags.length,
          artMeshTags: tags,
          numberOfArtMeshGroups: 0,
          artMeshGroups: [],
        });
      }

      case 'ColorTintRequest': {
        if (!model) return fail(E.tintNoModel, 'No model is loaded.');
        const c = tintColor(data);
        if ('errorID' in c) return fail(c.errorID, c.message);
        const ids = this.runtime.artMeshIds();
        const matched = matchArtMeshes(
          ids.map((id) => ({ id, tags: meta?.tags.get(id) ?? [] })),
          data.artMeshMatcher as Record<string, unknown>,
        );
        const white = c.tint.r === 255 && c.tint.g === 255 && c.tint.b === 255 && c.tint.a === 255;
        for (const i of matched) {
          // Between plugins the latest request wins.
          this.tintBy.delete(i);
          if (!white) this.tintBy.set(i, { session: caller.session, tint: c.tint });
        }
        this.applyTints();
        return ok({ matchedArtMeshes: matched.length });
      }
      // --- priority 2 ---
      case 'ItemListRequest':
        return this.items.list(data);
      case 'ItemLoadRequest':
        return this.items.load(caller, data);
      case 'ItemUnloadRequest':
        return this.items.unload(caller, data);
      case 'ItemMoveRequest':
        return this.items.move(data);
      case 'ItemPinRequest':
        return this.items.pin(data);
      case 'ItemAnimationControlRequest':
        return this.items.animation(data);
      case 'ArtMeshSelectionRequest':
        return this.selectArtMeshes(caller, data);
      case 'SceneColorOverlayInfoRequest':
        // The display light overlay as it is: white while it is off.
        return ok(overlayInfo(s.lightOverlay, s.app.lightOverlay));
      // --- priority 3 and beta ---
      case 'PostProcessingListRequest': {
        const filter = data.effectIDFilter;
        if (Array.isArray(filter) && filter.length > 512)
          return fail(E.postListFilterTooLong, 'effectIDFilter may list at most 512 effects.');
        // Mochi Studio has no post-processing effects (the documented answer: say so).
        return ok({
          postProcessingSupported: false,
          postProcessingActive: false,
          canSendPostProcessingUpdateRequestRightNow: false,
          restrictedEffectsAllowed: false,
          presetIsActive: false,
          activePreset: '',
          presetCount: 0,
          activeEffectCount: 0,
          effectCountBeforeFilter: 0,
          configCountBeforeFilter: 0,
          effectCountAfterFilter: 0,
          configCountAfterFilter: 0,
          postProcessingEffects: [],
          postProcessingPresets: [],
        });
      }
      case 'PostProcessingUpdateRequest': {
        const fade = data.postProcessingFadeTime;
        if (fade !== undefined && !(typeof fade === 'number' && fade >= 0 && fade <= 2))
          return fail(E.postUpdateInvalidFade, 'postProcessingFadeTime must be 0 to 2 seconds.');
        if (data.setPostProcessingPreset === true && data.setPostProcessingValues === true)
          return fail(
            E.postUpdatePresetAndValues,
            'Load a preset or set values, not both in one request.',
          );
        if (data.setPostProcessingPreset === true)
          return fail(E.postUpdatePresetNotFound, 'Mochi Studio has no post-processing presets.');
        if (data.setPostProcessingValues === true) {
          const vals = data.postProcessingValues;
          if (
            !Array.isArray(vals) ||
            vals.some((v) => typeof v?.configID !== 'string' || typeof v?.configValue !== 'string')
          )
            return fail(
              E.postUpdateInvalidValues,
              'postProcessingValues must list configID and configValue strings.',
            );
          const ids = vals.map((v) => String(v.configID).toLowerCase().replace(/[_-]/g, ''));
          if (new Set(ids).size !== ids.length)
            return fail(E.postUpdateDuplicateKeys, 'A config ID is listed twice.');
          if (vals.length)
            return fail(
              E.postUpdateInvalidValues,
              'Mochi Studio has no post-processing effects, so no config ID is known.',
            );
        }
        return ok({
          postProcessingActive: false,
          presetIsActive: false,
          activePreset: '',
          activeEffectCount: 0,
        });
      }
      case 'NDIConfigRequest': {
        // Mochi Studio has no NDI output: off, and it cannot be switched on.
        if (data.setNewConfig === true) {
          const now = performance.now();
          if (now - this.lastNdiSet < 3000)
            return fail(E.ndiCooldown, 'Wait 3 seconds between NDI changes.');
          this.lastNdiSet = now;
          const w = data.customWidthNDI;
          const h = data.customHeightNDI;
          const bad = (v: unknown, step: number): boolean =>
            v !== undefined &&
            v !== -1 &&
            !(
              typeof v === 'number' &&
              Number.isInteger(v) &&
              v >= 256 &&
              v <= 8192 &&
              v % step === 0
            );
          if (bad(w, 16) || bad(h, 8))
            return fail(
              E.ndiInvalidResolution,
              'The NDI size must be 256 to 8192 pixels, the width a multiple of 16 and the height of 8.',
            );
        }
        return ok({
          setNewConfig: data.setNewConfig === true,
          ndiActive: false,
          useNDI5: false,
          useCustomResolution: false,
          customWidthNDI: -1,
          customHeightNDI: -1,
        });
      }
      case 'ItemSortRequest':
        return this.items.sort(data, head);
      case 'ArtMeshAtPositionRequest': {
        const n = (v: unknown, lo: number, hi: number): number =>
          typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : 0;
        const x = n(data.x, -1000, 1000);
        const y = n(data.y, -1000, 1000);
        const seconds = n(data.visualize, 0, 5);
        const r = this.canvas.getBoundingClientRect();
        const page = windowToPage(x, y, r);
        const hits = model ? this.runtime.artMeshHits(page.x, page.y) : [];
        if (seconds > 0) this.events.emit('marker', { x: page.x, y: page.y, seconds });
        return ok({
          modelLoaded: !!model,
          loadedModelID: head.modelID,
          loadedModelName: head.modelName,
          modelWasHit: hits.length > 0,
          checkedPosition: { x: round(x), y: round(y) },
          windowSize: { x: Math.round(r.width), y: Math.round(r.height) },
          artMeshHitCount: hits.length,
          artMeshHits: this.hitEntries(hits),
        });
      }

      case 'GetCurrentModelPhysicsRequest': {
        // The person's settings; plugins' overrides are not shown.
        const groups = model ? s.physicsGroups() : [];
        const t = s.settings?.physicsTuning;
        const by = model ? s.physicsOverrides.controller(performance.now()) : undefined;
        return ok({
          ...head,
          modelHasPhysics: !!model?.manifest.physics && groups.length > 0,
          physicsSwitchedOn: s.settings?.physics ?? false,
          usingLegacyPhysics: false,
          // The rate chosen in the Model tab; the file's own as the protocol can say it.
          physicsFPSSetting: physicsFpsSetting(t?.rate, this.runtime.physicsRate().file),
          baseStrength: t?.strength ?? 50,
          baseWind: t?.wind ?? 0,
          apiPhysicsOverrideActive: !!by,
          apiPhysicsOverridePluginName: by?.name ?? '',
          physicsGroups: groups.map((g) => ({
            groupID: g.id,
            // Empty for a setting the physics file does not name (Mochi2D 0.12.0's `named`).
            groupName: g.named ? g.name : '',
            strengthMultiplier: t?.groups[g.id] ?? 1,
            // The person's share of the wind for the group (Mochi2D 0.13.0 applies it).
            windMultiplier: t?.windGroups?.[g.id] ?? 1,
          })),
        });
      }
      case 'SetCurrentModelPhysicsRequest': {
        if (!model) return fail(E.physicsNoModel, 'No model is loaded.');
        if (!model.manifest.physics || !s.physicsGroups().length)
          return fail(E.physicsNoPhysics, 'This model has no physics.');
        const refused = s.overridePhysics(
          { id: caller.id, name: caller.name, session: caller.session },
          data,
        );
        return refused ? fail(refused.errorID, refused.message) : ok({});
      }
    }
    return fail(E.unknownMessageType, `${type} is not supported by Mochi Studio yet.`);
  }

  // --- art-mesh selection -----------------------------------------------

  private selectArtMeshes(
    caller: PluginCaller,
    d: Record<string, unknown>,
  ): Promise<PluginAnswer> | PluginAnswer {
    if (!this.studio.model) return { errorID: E.selectionNoModel, message: 'No model is loaded.' };
    if (this.selection)
      return {
        errorID: E.selectionWindowsOpen,
        message: 'The person is already choosing art meshes.',
      };
    const meshes = this.runtime.artMeshIds();
    const pre = Array.isArray(d.activeArtMeshes)
      ? d.activeArtMeshes.filter((x): x is string => typeof x === 'string')
      : [];
    if (pre.length > meshes.length)
      return {
        errorID: E.selectionListTooLong,
        message: 'activeArtMeshes is longer than the model’s art-mesh list.',
      };
    const unknown = pre.find((x) => !meshes.includes(x));
    if (unknown !== undefined)
      return {
        errorID: E.selectionUnknownMesh,
        message: `The model has no art mesh "${unknown}".`,
      };
    const text = (v: unknown, def: string): string =>
      typeof v === 'string' && v.length >= 4 && v.length <= 1024 ? v : def;
    const count =
      typeof d.requestedArtMeshCount === 'number' && d.requestedArtMeshCount > 0
        ? Math.floor(d.requestedArtMeshCount)
        : 0;
    const id = crypto.randomUUID();
    return new Promise<PluginAnswer>((resolve) => {
      this.selection = {
        id,
        session: caller.session,
        meshes,
        answer: (active) => {
          this.selection = undefined;
          this.events.emit('selectionEnd', { id });
          const on = active ?? pre;
          resolve({
            data: {
              success: active !== undefined,
              activeArtMeshes: on,
              inactiveArtMeshes: meshes.filter((m) => !on.includes(m)),
            },
          });
        },
      };
      this.events.emit('selection', {
        id,
        pluginName: caller.name,
        text: text(d.textOverride, SELECTION_TEXT),
        help: text(d.helpOverride, SELECTION_HELP),
        count,
        meshes,
        active: pre,
      });
    });
  }

  /** The person's answer: the chosen art meshes (OK), or undefined (Cancel). */
  answerSelection(id: string, active: string[] | undefined): void {
    if (this.selection?.id !== id) return;
    this.selection.answer(
      active ? active.filter((m) => this.selection!.meshes.includes(m)) : undefined,
    );
  }

  // --- geometry events ---------------------------------------------------

  private geometryEvents(now: number): void {
    const s = this.studio;
    if (!this.on || !s.model || !s.settings || !this.meta) return;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    // ModelMovedEvent: in every frame the position, size or rotation changes (the
    // bridge keeps the last one for new subscribers).
    const pos = toProtocolPosition(s.settings.transform, w, h);
    const key = JSON.stringify(pos);
    if (key !== this.lastMoved) {
      this.lastMoved = key;
      this.event('ModelMovedEvent', {
        modelID: this.meta.id,
        modelName: this.meta.name,
        modelPosition: pos,
      });
    }
    // ModelOutlineEvent: 15 times a second, only while someone listens.
    if (
      (this.subscribed.has('ModelOutlineEvent') || this.drawOutline) &&
      now - this.lastOutline >= 1000 / 15
    ) {
      this.lastOutline = now;
      const page = convexHull(this.runtime.meshBoxCorners());
      if (this.drawOutline) this.events.emit('outline', { points: page });
      if (!this.subscribed.has('ModelOutlineEvent') || page.length < 3) return;
      const r = this.canvas.getBoundingClientRect();
      const hull = page.map((p) => {
        const q = pageToWindow(p.x, p.y, r);
        return { x: round(q.x), y: round(q.y) };
      });
      this.event('ModelOutlineEvent', {
        modelName: this.meta.name,
        modelID: this.meta.id,
        convexHull: hull,
        convexHullCenter: {
          x: round(hull.reduce((a, p) => a + p.x, 0) / hull.length),
          y: round(hull.reduce((a, p) => a + p.y, 0) / hull.length),
        },
        windowSize: { x: Math.round(r.width), y: Math.round(r.height) },
      });
    }
  }

  // --- helpers for the answers ----------------------------------------------------------

  private hotkeyList(): Array<Record<string, unknown>> {
    const s = this.studio;
    const buttons = (s.settings?.hotkeys ?? []).filter((h) => h.button);
    return (s.settings?.hotkeys ?? []).map((h) => {
      const { type, description } = hotkeyType(h);
      const b = buttons.indexOf(h);
      return {
        name: h.label,
        type,
        description,
        file: this.hotkeyFile(h),
        hotkeyID: h.id,
        // Its keys under the API's key names.
        keyCombination: apiKeyCombination(h.keys),
        onScreenButtonID: b >= 0 && b < 8 ? b + 1 : -1,
      };
    });
  }

  private hotkeyFile(h: Hotkey): string {
    const m = this.studio.model?.manifest;
    const a = h.action;
    if (a.type === 'expression')
      return m?.expressions.find((e) => e.name === a.expression)?.file ?? '';
    if (a.type === 'motion')
      return (
        m?.motions.find((x) => x.group === a.motion.group && x.index === a.motion.index)?.file ?? ''
      );
    // An item scene is known by its name.
    if (a.type === 'itemScene')
      return this.studio.itemScenes.find((x) => x.id === a.scene)?.name ?? '';
    return '';
  }

  private async expressionParameters(
    file: string,
  ): Promise<Array<{ name: string; value: number }>> {
    const files = this.studio.model?.files;
    if (!files?.has(file)) return [];
    try {
      return parseExpression(await files.read(file), file).parameters.map((p) => ({
        name: p.id,
        value: p.value,
      }));
    } catch {
      return [];
    }
  }

  private resolve(name: string): ResolvedParameter | undefined {
    const d = defaultParameter(name);
    if (d && d.name === name)
      return {
        input: d.input,
        scale: d.scale,
        offset: d.offset,
        rest: d.scale * d.defaultValue + d.offset,
      };
    const c = this.parameters.find((p) => p.name === name);
    if (c) return { input: pluginInputId(c.name), scale: 1, offset: 0, rest: c.defaultValue };
    return undefined;
  }

  private defaultEntry(caller: PluginCaller, name: string, now: number): Record<string, unknown> {
    const d = defaultParameter(name)!;
    const own = this.injection.ownValue(caller.id, d.input, now);
    let value = d.defaultValue;
    if (own !== undefined) value = own;
    else if (caller.trackingData || !d.tracked) {
      const v = this.studio.lastInputs[d.input];
      if (v !== undefined) value = (v - d.offset) / d.scale;
    }
    return {
      name: d.name,
      addedBy: APP_NAME,
      value: round(value),
      min: round(d.min),
      max: round(d.max),
      defaultValue: round(d.defaultValue),
    };
  }

  private customEntry(p: CustomParameter, _now: number): Record<string, unknown> {
    const v = this.studio.lastInputs[pluginInputId(p.name)];
    return {
      name: p.name,
      addedBy: p.pluginName,
      value: round(v ?? p.defaultValue),
      min: p.min,
      max: p.max,
      defaultValue: p.defaultValue,
    };
  }

  /** Draws the plugins' tints (Mochi2D's `setTint`), here and in output views. */
  private applyTints(): void {
    this.runtime.setTints(new Map([...this.tintBy].map(([i, t]) => [i, t.tint])));
    this.studio.setModelTints(this.runtime.modelTintsById());
  }

  /** A session ended: the art meshes it tinted return to white. */
  private endTints(session: string): void {
    for (const [i, t] of this.tintBy) if (t.session === session) this.tintBy.delete(i);
    this.applyTints();
  }

  /** The models a plugin may load: the current one, and in the desktop app the recent ones. */
  private async availableModels(): Promise<
    Array<{ id: string; name: string; recent?: RecentModel }>
  > {
    const out: Array<{ id: string; name: string; recent?: RecentModel }> = [];
    if (this.studio.model && this.meta) out.push({ id: this.meta.id, name: this.meta.name });
    const recent = (await desktopApi()?.recentModels()) ?? [];
    for (const r of recent) {
      if (r.state !== 'ok') continue;
      const id = modelIdFor(`path:${r.path}`);
      if (out.some((m) => m.id === id)) continue;
      out.push({ id, name: displayNameFor(r.path) ?? r.label.replace(/\.zip$/i, ''), recent: r });
    }
    return out;
  }

  // --- events --------------------------------------------------------------------

  private event(name: string, data: Record<string, unknown>): void {
    if (this.on) this.link.sendPlugin({ type: 'plugin_event', name, data });
  }

  private watchStudio(): void {
    const s = this.studio;
    s.events.on('modelFiles', () => (this.loadStarted = performance.now()));
    s.events.on('modelLoaded', ({ label }) => {
      const model = s.model!;
      const path = desktopSourcePath(model.files);
      const now = performance.now();
      // A new model has no tints (and its art-mesh indices are its own).
      this.tintBy.clear();
      this.runtime.setTints(new Map());
      const fileName = label
        .split('/')
        .pop()!
        .replace(/\.zip$/i, '');
      this.meta = {
        id: modelIdFor(path ? `path:${path}` : `key:${model.key}`),
        name: s.settings?.displayName ?? fileName,
        fileName,
        loadMs: this.loadStarted ? now - this.loadStarted : 0,
        loadedAt: now,
        textureResolution: 0,
        tags: new Map(),
      };
      void this.readModelExtras(this.meta);
      this.lastConfig = configKey(s);
      this.lastHotkeys = JSON.stringify(s.settings?.hotkeys ?? []);
      this.lastItems = new Map(s.items.map((i) => [i.id, i.label]));
      this.event('ModelLoadedEvent', {
        modelLoaded: true,
        modelName: this.meta.name,
        modelID: this.meta.id,
      });
      // ExpressionToggledEvent: one event per expression when a model loads.
      this.expressionEvents(true);
    });
    s.events.on('expressionsChanged', () => this.expressionEvents(false));
    // The expression editor added, changed or removed one: the bridge's list follows.
    s.events.on('expressionListChanged', () => this.sendExpressionList());
    s.events.on('modelUnloaded', () => {
      const m = this.meta;
      this.meta = undefined;
      this.tintBy.clear();
      this.runtime.setTints(new Map());
      this.queue = [];
      this.move = undefined;
      this.event('ModelLoadedEvent', {
        modelLoaded: false,
        modelName: m?.name ?? '',
        modelID: m?.id ?? '',
      });
      this.lastExpressions = new Set();
      this.sendExpressionList();
    });
    const tracking = (): void =>
      this.event('TrackingStatusChangedEvent', {
        faceFound: s.faceVisible,
        leftHandFound: s.handsFound.left,
        rightHandFound: s.handsFound.right,
      });
    s.events.on('trackingFound', tracking);
    s.events.on('trackingLost', tracking);
    // Hand tracking: a hand found or lost changes the status too.
    s.events.on('handsChanged', tracking);
    s.events.on('hotkeyFired', ({ hotkey }) => {
      this.event('HotkeyTriggeredEvent', {
        hotkeyID: hotkey.id,
        hotkeyName: hotkey.label,
        hotkeyAction: hotkeyType(hotkey).type,
        hotkeyFile: this.hotkeyFile(hotkey),
        hotkeyTriggeredByAPI: this.firingFromApi,
        modelID: this.meta?.id ?? '',
        modelName: this.meta?.name ?? '',
        isLive2DItem: false,
      });
    });
    const background = (): void => {
      const b = s.stage.background;
      const name =
        b.kind === 'transparent'
          ? 'Transparent background'
          : b.kind === 'image'
            ? 'Image'
            : `${b.kind === 'chroma' ? 'Chroma key' : 'Color'} ${b.color}`;
      if (name === this.lastBackground) return;
      const first = !this.lastBackground;
      this.lastBackground = name;
      if (!first) this.event('BackgroundChangedEvent', { backgroundName: name });
    };
    background();
    s.events.on('appSettingsChanged', background);
    s.events.on('settingsChanged', () => {
      background();
      if (this.meta) this.meta.name = s.settings?.displayName ?? this.meta.fileName;
      // Settings changes by hand (not the position), once they settle.
      if (this.configTimer) clearTimeout(this.configTimer);
      this.configTimer = setTimeout(() => {
        const key = configKey(s);
        if (!s.model || key === this.lastConfig) return;
        this.lastConfig = key;
        const hotkeys = JSON.stringify(s.settings?.hotkeys ?? []);
        const hotkeyConfigChanged = hotkeys !== this.lastHotkeys;
        this.lastHotkeys = hotkeys;
        this.event('ModelConfigChangedEvent', {
          modelID: this.meta?.id ?? '',
          modelName: this.meta?.name ?? '',
          hotkeyConfigChanged,
        });
      }, 500);
    });
    s.events.on('itemsChanged', ({ items }) => {
      const now = new Map(items.map((i) => [i.id, i.label]));
      for (const [id, label] of now)
        if (!this.lastItems.has(id)) this.itemEvent('Added', id, label);
      for (const [id, label] of this.lastItems)
        if (!now.has(id)) this.itemEvent('Removed', id, label);
      this.lastItems = now;
    });
    this.runtime.on('itemMoved', ({ id }) => {
      const label = this.lastItems.get(id) ?? id;
      this.itemEvent(s.isItemPinned(id) ? 'DroppedPinned' : 'DroppedUnpinned', id, label);
    });
    this.runtime.on('motionStarted', ({ file, idle }) => {
      this.motionStarts.set(file, performance.now());
      void this.animationEvent('Start', file, idle, 'Anim_Start');
    });
    this.runtime.on(
      'motionEnded',
      ({ file, idle }) => void this.animationEvent('End', file, idle, 'Anim_End'),
    );
    this.runtime.on('motionUserEvent', ({ value }) => {
      // The motion playing longest ago is the likeliest owner of the marker.
      const file = [...this.motionStarts.keys()].at(-1) ?? '';
      void this.animationEvent('Custom', file, false, value.slice(0, 256));
    });
    // Clicks on the stage (not drags).
    let down: { x: number; y: number } | undefined;
    this.canvas.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
    this.canvas.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
      down = undefined;
      this.click(e);
    });
  }

  private itemEvent(type: string, id: string, label: string): void {
    const file = this.studio.items.find((i) => i.id === id)?.file ?? label;
    this.event('ItemEvent', {
      itemEventType: type,
      itemInstanceID: id,
      itemFileName: file,
      itemPosition: this.items.itemPosition(id),
    });
  }

  private async animationEvent(
    kind: 'Start' | 'End' | 'Custom',
    file: string,
    idle: boolean,
    data: string,
  ): Promise<void> {
    const length = await this.motionLength(file);
    const started = this.motionStarts.get(file) ?? performance.now();
    const time =
      kind === 'Start'
        ? 0
        : kind === 'End'
          ? length
          : Math.min(length, (performance.now() - started) / 1000);
    this.event('ModelAnimationEvent', {
      animationEventType: kind,
      animationEventTime: round(time),
      animationEventData: data,
      animationName: file.split('/').pop() ?? file,
      animationLength: round(length),
      isIdleAnimation: idle,
      modelID: this.meta?.id ?? '',
      modelName: this.meta?.name ?? '',
      isLive2DItem: false,
    });
  }

  private async motionLength(file: string): Promise<number> {
    const known = this.motionLengths.get(file);
    if (known !== undefined) return known;
    const files = this.studio.model?.files;
    let len = 0;
    if (files?.has(file))
      try {
        len = parseMotion(await files.read(file), file).duration;
      } catch {
        len = 0;
      }
    this.motionLengths.set(file, len);
    return len;
  }

  private click(e: PointerEvent): void {
    const r = this.canvas.getBoundingClientRect();
    const hits = this.studio.model ? this.runtime.artMeshHits(e.clientX, e.clientY) : [];
    if (this.selection) this.events.emit('selectionFilter', { meshes: hits.map((h) => h.id) });
    this.event('ModelClickedEvent', {
      modelLoaded: !!this.studio.model,
      loadedModelID: this.meta?.id ?? '',
      loadedModelName: this.meta?.name ?? '',
      modelWasClicked: hits.length > 0,
      mouseButtonID: e.button === 2 ? 1 : e.button === 1 ? 2 : 0,
      clickPosition: {
        x: round(((e.clientX - r.left) / r.width) * 2 - 1),
        y: round(1 - ((e.clientY - r.top) / r.height) * 2),
      },
      windowSize: { x: Math.round(r.width), y: Math.round(r.height) },
      clickedArtMeshCount: hits.length,
      artMeshHits: this.hitEntries(hits),
    });
  }

  /** Art-mesh hits in the click event's format (also ArtMeshAtPositionRequest's). */
  private hitEntries(
    hits: ReturnType<MochiRuntime['artMeshHits']>,
  ): Array<Record<string, unknown>> {
    return hits.map((h) => ({
      artMeshOrder: h.order,
      isMasked: h.masked,
      hitInfo: {
        modelID: this.meta?.id ?? '',
        artMeshID: h.id,
        angle: 0,
        size: 0,
        vertexID1: h.vertices[0],
        vertexID2: h.vertices[1],
        vertexID3: h.vertices[2],
        vertexWeight1: round(h.weights[0]!, 6),
        vertexWeight2: round(h.weights[1]!, 6),
        vertexWeight3: round(h.weights[2]!, 6),
      },
    }));
  }

  // --- ExpressionToggledEvent (beta) -------------------------------------------------

  /** One event per expression whose state changed (or every one, `justLoaded`, for a new model). */
  private expressionEvents(justLoaded: boolean): void {
    const m = this.studio.model;
    if (!m || !this.meta) return;
    const now = new Set(this.studio.activeExpressions);
    for (const e of m.manifest.expressions) {
      const active = now.has(e.name);
      if (!justLoaded && active === this.lastExpressions.has(e.name)) continue;
      this.event('ExpressionToggledEvent', {
        modelID: this.meta.id,
        modelName: this.meta.name,
        isLive2DItem: false,
        itemInstanceID: '',
        justLoaded,
        expressionFile: e.file,
        expressionName: expressionNameFromFile(e.file),
        active,
      });
    }
    this.lastExpressions = now;
    this.sendExpressionList();
  }

  /** Every expression and its state, for the bridge's snapshot when a plugin subscribes. */
  private sendExpressionList(): void {
    if (!this.on) return;
    const m = this.studio.model;
    const on = this.studio.activeExpressions;
    this.link.sendPlugin({
      type: 'plugin_expressions',
      modelID: m ? (this.meta?.id ?? '') : '',
      modelName: m ? (this.meta?.name ?? '') : '',
      expressions: (m?.manifest.expressions ?? []).map((e) => ({
        expressionFile: e.file,
        expressionName: expressionNameFromFile(e.file),
        active: on.has(e.name),
      })),
    });
  }

  // --- ArtMeshTrackingEvent and ArtMeshOutlineEvent (beta) ---------------------------

  private syncMeshJobs(
    list: Array<{ session: string; name: string; config: Record<string, unknown> }>,
  ): void {
    const keep = new Set<string>();
    for (const e of list) {
      const key = `${e.session}/${e.name}`;
      keep.add(key);
      const json = JSON.stringify(e.config);
      const known = this.meshJobs.get(key);
      // A new subscription (a new config) starts afresh: counters, references and shapes.
      if (known?.json === json) continue;
      this.meshJobs.set(key, {
        session: e.session,
        name: e.name,
        config: e.config,
        json,
        nextAt: 0,
        sentNoModel: false,
        modelID: '',
        refs: new Map(),
        shapes: new Map(),
      });
    }
    for (const k of [...this.meshJobs.keys()]) if (!keep.has(k)) this.meshJobs.delete(k);
  }

  private meshEvents(now: number): void {
    if (!this.on || !this.meshJobs.size) return;
    const r = this.canvas.getBoundingClientRect();
    const windowSize = { x: Math.round(r.width), y: Math.round(r.height) };
    for (const j of this.meshJobs.values()) {
      const tracking = j.name === 'ArtMeshTrackingEvent';
      const f = j.config.frequency;
      const freq = typeof f === 'number' && f > 0 ? f : tracking ? 30 : 15;
      if (now < j.nextAt) continue;
      j.nextAt = now + 1000 / freq;
      if (!this.studio.model || !this.meta) {
        // No model: one event saying so, then silence until one loads.
        if (j.sentNoModel) continue;
        j.sentNoModel = true;
        this.link.sendPlugin({
          type: 'plugin_event',
          name: j.name,
          session: j.session,
          data: tracking
            ? {
                modelLoaded: false,
                modelID: '',
                windowSize,
                subscribedPointsCount:
                  (j.config.trackingPoints as unknown[] | undefined)?.length ?? 0,
                foundPointsCount: 0,
                trackingPoints: [],
              }
            : {
                modelLoaded: false,
                modelID: '',
                windowSize,
                subscribedArtMeshCount: (j.config.artMeshes as unknown[] | undefined)?.length ?? 0,
                foundArtMeshCount: 0,
                artMeshOutlines: [],
              },
        });
        continue;
      }
      j.sentNoModel = false;
      if (j.modelID !== this.meta.id) {
        j.modelID = this.meta.id;
        j.refs.clear();
        j.shapes.clear();
      }
      const data = tracking
        ? this.trackingData(j, r, windowSize)
        : this.outlineData(j, r, windowSize);
      this.link.sendPlugin({ type: 'plugin_event', name: j.name, session: j.session, data });
    }
  }

  /** Where a mesh's vertex is: page pixels, and the protocol's window coordinates. */
  private meshPositions(
    id: string,
    r: DOMRect,
  ):
    | {
        page: (v: number) => { x: number; y: number };
        win: (v: number) => { x: number; y: number };
        count: number;
      }
    | undefined {
    const verts = this.runtime.meshVertices(id);
    if (!verts) return undefined;
    const page = (v: number): { x: number; y: number } =>
      this.runtime.modelToPage(verts[2 * v]!, verts[2 * v + 1]!) ?? { x: 0, y: 0 };
    return {
      page,
      win: (v) => {
        const p = page(v);
        return pageToWindow(p.x, p.y, r);
      },
      count: verts.length / 2,
    };
  }

  private trackingData(
    j: MeshJob,
    r: DOMRect,
    windowSize: { x: number; y: number },
  ): Record<string, unknown> {
    const points = (j.config.trackingPoints as Array<Record<string, unknown>>) ?? [];
    const found: Array<Record<string, unknown>> = [];
    const num = (v: unknown, d: number): number =>
      typeof v === 'number' && Number.isFinite(v) ? v : d;
    for (const p of points) {
      const c = (p.artMeshCoords ?? {}) as Record<string, unknown>;
      if (typeof c.modelID === 'string' && c.modelID && c.modelID.toLowerCase() !== this.meta!.id)
        continue;
      const id = String(c.artMeshID);
      const at = this.meshPositions(id, r);
      const v = [num(c.vertexID1, -1), num(c.vertexID2, -1), num(c.vertexID3, -1)] as const;
      if (!at || v.some((x) => x < 0 || x >= at.count)) continue;
      const tp: TrackedPoint = {
        vertices: v,
        weights: [num(c.vertexWeight1, 0), num(c.vertexWeight2, 0), num(c.vertexWeight3, 0)],
      };
      const pos = pointOn(tp, at.win);
      // Turned and scaled as its triangle, on screen, since the subscription.
      const frame = triangleFrame(tp, at.page);
      const key = String(p.trackingPointID);
      if (frame && !j.refs.has(key)) j.refs.set(key, frame);
      const ref = j.refs.get(key);
      const angle = num(c.angle, 0) + (frame && ref ? frame.angle - ref.angle : 0);
      const size = num(c.size, 1) * (frame && ref ? frame.length / ref.length : 1);
      found.push({
        trackingPointID: key,
        artMeshVisible: (this.runtime.meshOpacity(id) ?? 0) !== 0,
        position: { x: round(pos.x), y: round(pos.y) },
        rotation: round(((angle % 360) + 360) % 360),
        size: round(size),
      });
    }
    return {
      modelLoaded: true,
      modelID: this.meta!.id,
      windowSize,
      subscribedPointsCount: points.length,
      foundPointsCount: found.length,
      trackingPoints: found,
    };
  }

  private outlineData(
    j: MeshJob,
    r: DOMRect,
    windowSize: { x: number; y: number },
  ): Record<string, unknown> {
    const list = (j.config.artMeshes as Array<Record<string, unknown>>) ?? [];
    const outlines: Array<Record<string, unknown>> = [];
    for (const m of list) {
      if (typeof m.modelID === 'string' && m.modelID && m.modelID.toLowerCase() !== this.meta!.id)
        continue;
      const id = String(m.artMeshID);
      const at = this.meshPositions(id, r);
      const tris = this.runtime.meshTriangles(id);
      if (!at || !tris) continue;
      // The shape is found once per subscription (and model); only the positions update.
      let shape = j.shapes.get(id);
      if (!shape) {
        shape = boundaryLoops(tris).map((loop) => resampleLoop(loop, at.page, 20));
        j.shapes.set(id, shape);
      }
      const rings = shape.map((ring) => ring.map((e) => atEdge(e, at.win)));
      outlines.push({
        artMeshID: id,
        artMeshVisible: (this.runtime.meshOpacity(id) ?? 0) !== 0,
        outlineCount: rings.length,
        outlineArea: round(rings.reduce((a, ring) => a + ringArea(ring), 0)),
        outlinePoints: rings.map((ring) => ({
          points: ring.flatMap((q) => [round(q.x), round(q.y)]),
        })),
      });
    }
    return {
      modelLoaded: true,
      modelID: this.meta!.id,
      windowSize,
      subscribedArtMeshCount: list.length,
      foundArtMeshCount: outlines.length,
      artMeshOutlines: outlines,
    };
  }

  /** The texture size (from the first texture's header) and the art meshes' tags (user data). */
  private async readModelExtras(meta: ModelMeta): Promise<void> {
    const model = this.studio.model;
    if (!model) return;
    const tex = model.manifest.textures[0];
    try {
      if (tex && model.files.has(tex)) {
        const b = await model.files.read(tex);
        if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50)
          meta.textureResolution = new DataView(b.buffer, b.byteOffset).getUint32(16);
      }
    } catch {
      /* unreadable: 0 */
    }
    const userData = this.runtime.userDataPath();
    try {
      if (userData && model.files.has(userData)) {
        const u = parseUserData(await model.files.read(userData), userData);
        meta.tags = tagsFromUserData(u.artMeshes);
      }
    } catch {
      /* no tags */
    }
  }
}

/** The settings that count as the model's configuration (not its position). */
function configKey(s: Studio): string {
  if (!s.settings) return '';
  // Where the model and items are is not its configuration (items move all the time).
  const { transform: _t, itemLayout: _l, items, ...rest } = s.settings;
  return JSON.stringify({ ...rest, items: items.map((i) => ({ id: i.id, label: i.label })) });
}

/** Whether a manifest path names the requested file (by path, or by file name), ignoring case. */
function sameFile(path: string, wanted: string): boolean {
  const a = path.toLowerCase();
  const b = wanted.toLowerCase().replace(/^\.?\//, '');
  return a === b || (a.split('/').pop() ?? a) === b;
}

const round = (v: number, digits = 4): number => Number(v.toFixed(digits));
