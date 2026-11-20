/**
 * Mochi Studio's commands: every user action the UI offers, as a typed
 * command for the UI and for agents. Names, argument style and error
 * messages follow Mochi2D's own agent tools (snake_case names, a message
 * that says what to do) where the two overlap.
 *
 * Privacy: no command returns camera or microphone data. Parameter values
 * that tracking drives are not readable (`get_parameters` returns ranges,
 * defaults and the values agents set); tracking shows only as status.
 */
import type { Background } from '../background';
import type { Hotkey, MotionRef } from '../hotkeys';
import type { ItemEntry, ItemPlacement } from '../items';
import { MAX_SCENE_FADE_S, type ItemScene } from '../itemScenes';
import { LIP_SYNC_MODES, GATE_MAX_DB, GATE_MIN_DB, type LipSyncSettings } from '../lipSync';
import { makeRule, SMOOTHER_KINDS, type MappingRule } from '../mapping';
import type { LoadedModelFiles } from '../modelFiles';
import type { ParameterInfo } from '../runtime';
import { ZOOM_MAX, ZOOM_MIN, type SceneTransform } from '../scene';
import { DERIVED_INPUTS } from '../tracking';
import type { AppSettings, ModelSettings } from '../settings';
import { DEFAULT_FREQUENCY_WEIGHTS, parseFrequencyWeights } from '../voice';
import {
  CommandError,
  command,
  type CommandDef,
  type CommandRegistry,
  type LogEntry,
} from './registry';
import { s } from './schema';
import {
  SPOUT_MAX_OUTPUTS,
  SPOUT_MAX_SIZE,
  SPOUT_MIN_SIZE,
  parseSpout,
  spoutSenderName,
  type SpoutOutputState,
  type SpoutSettings,
} from '../spout';
import { COLLAB_OFF, type CollabApi } from '../collab/api';
import {
  CAMERA_NAME,
  CAMERA_RATES,
  CAMERA_SIZES,
  parseVirtualCamera,
  type VirtualCameraSettings,
  type VirtualCameraState,
} from '../virtualCamera';

/** What the commands need from the app (implemented by `Studio`). */
export interface StudioApi {
  readonly model: LoadedModelFiles | undefined;
  readonly parameters: readonly ParameterInfo[];
  /** Parameters physics overwrites -> the parameter that drives each. */
  readonly physicsDrivers: Readonly<Record<string, { from: string; reflect: boolean }>>;
  readonly settings: ModelSettings | undefined;
  readonly app: AppSettings;
  /** Spout2 output: the settings, whether it can run here, and each sender's state. */
  spoutStatus(): {
    available: boolean;
    problem?: string;
    settings: SpoutSettings;
    outputs: SpoutOutputState[];
  };
  setSpout(settings: SpoutSettings): void;
  /** The virtual camera: the settings, whether it can run here, and its state. */
  virtualCameraStatus(): VirtualCameraState & { settings: VirtualCameraSettings };
  setVirtualCamera(settings: VirtualCameraSettings): void;
  /** Collaboration, when this app has it. */
  readonly collab?: CollabApi;
  readonly stage: { background: Background; fpsCap: number };
  readonly activeExpressions: ReadonlySet<string>;
  readonly overrides: Readonly<Record<string, number>>;
  readonly cameraOn: boolean;
  /** Something tracks the face: this computer's camera, or a phone. */
  readonly trackingOn: boolean;
  readonly faceVisible: boolean;
  readonly microphoneOn: boolean;
  readonly items: readonly ItemEntry[];
  isItemVisible(id: string): boolean;
  isItemPinned(id: string): boolean;
  itemPlacement(id: string): ItemPlacement | undefined;
  loadModelFromUrl(url: string): Promise<void>;
  unloadModel(): void;
  updateSettings(patch: Partial<ModelSettings>): void;
  setStage(patch: { background?: Background; fpsCap?: number }): void;
  setExpression(name: string, on: boolean): void;
  playMotion(ref: MotionRef, mode: 'once' | 'hold'): void;
  stopMotions(): void;
  setItemVisible(id: string, visible: boolean): void;
  /** Item scenes: whether one is on, turning one on or off, making and removing them. */
  isItemSceneOn(id: string): boolean;
  setItemScene(id: string, on: boolean, fade?: number): void;
  createItemScene(name: string, group: string, itemIds: readonly string[]): ItemScene;
  removeItemScene(id: string): void;
  placeItem(id: string, p: Partial<ItemPlacement>): void;
  pinItem(id: string, pinned: boolean): boolean;
  fireHotkey(id: string): void;
  releaseHotkey(id: string): void;
  calibrate(): Promise<boolean>;
  /** Agent parameter overrides; they win over tracking. `ttlMs` makes them expire. */
  setOverrides(values: Record<string, number>, ttlMs?: number): void;
  clearOverrides(ids?: string[]): void;
  speak(audio: Uint8Array, volume: number): Promise<void>;
  /** A PNG of the avatar with a transparent background. */
  screenshot(): Promise<Uint8Array>;
  /** Restores settings captured for undo. */
  restore(snapshot: Snapshot): void;
  /** The connected agents, for get_state. */
  readonly agents: ReadonlyArray<{ name: string; scopes: readonly string[] }>;
  /** The command registry (for undo, redo, log and replay). */
  readonly commands: CommandRegistry<StudioApi>;
}

export interface Snapshot {
  settings?: ModelSettings;
  app: AppSettings;
  overrides: Record<string, number>;
}

const snapshot = (c: StudioApi): Snapshot => ({
  ...(c.settings ? { settings: structuredClone(c.settings) } : {}),
  app: structuredClone(c.app),
  overrides: { ...c.overrides },
});
/** Undo by restoring the settings as they were before the command. */
const restoreSettings = (c: StudioApi): (() => void) => {
  const snap = snapshot(c);
  return () => c.restore(snap);
};

function sceneView(c: StudioApi, x: ItemScene) {
  return {
    id: x.id,
    name: x.name,
    ...(x.group ? { group: x.group } : {}),
    items: x.items.map((i) => i.id),
    on: c.isItemSceneOn(x.id),
  };
}

/** A scene of the loaded model by id, or else by name (ignoring case). */
function findScene(c: StudioApi, key: string): ItemScene {
  const scenes = needModel(c).settings.itemScenes;
  const x =
    scenes.find((y) => y.id === key) ??
    scenes.find((y) => y.name.toLowerCase() === key.trim().toLowerCase());
  if (!x)
    throw new CommandError(
      'unknown_scene',
      `Unknown item scene "${key}". list_item_scenes gives them: ${scenes.map((y) => y.name).join(', ') || 'there are none'}.`,
    );
  return x;
}

function needModel(c: StudioApi): LoadedModelFiles & { settings: ModelSettings } {
  if (!c.model || !c.settings)
    throw new CommandError(
      'no_model',
      'No model is loaded: load one first with load_model, or in the Model tab.',
    );
  return { ...c.model, settings: c.settings };
}

/** Parameters with `drivenByPhysicsFrom` where physics overwrites them (as Mochi2D's tools say it). */
function withDrivers(c: StudioApi, ps: readonly ParameterInfo[] = c.parameters) {
  return ps.map((p) =>
    c.physicsDrivers[p.id]
      ? {
          ...p,
          drivenByPhysicsFrom: c.physicsDrivers[p.id]!.from,
          ...(c.physicsDrivers[p.id]!.reflect ? { drivenReflected: true } : {}),
        }
      : { ...p },
  );
}

function motionList(c: StudioApi) {
  return (c.model?.manifest.motions ?? []).map((m) => ({
    group: m.group,
    index: m.index,
    name: m.name,
    file: m.file,
  }));
}

function itemView(c: StudioApi, i: ItemEntry) {
  return {
    id: i.id,
    name: i.label,
    visible: c.isItemVisible(i.id),
    pinned: c.isItemPinned(i.id),
    placement: c.itemPlacement(i.id) ?? i.placement ?? null,
  };
}

function hotkeyView(h: Hotkey) {
  return {
    id: h.id,
    label: h.label,
    keys: h.keys,
    button: h.button,
    action: h.action,
    release: h.release ?? 'toggle',
    ...(h.seconds !== undefined ? { seconds: h.seconds } : {}),
  };
}

const hex = s.string({ maxLength: 7, description: 'A color as #rrggbb.' });
const optNum = (o: Parameters<typeof s.number>[0] = {}) => s.optional(s.number(o));

const ruleSchema = s.object({
  id: s.optional(s.string({ maxLength: 50 })),
  input: s.string({
    maxLength: 200,
    description: 'A tracking input id (see describe_model.inputs) or bs.<blendshape>.',
  }),
  output: s.string({ maxLength: 100, description: 'A model parameter id.' }),
  enabled: s.optional(s.boolean()),
  inMin: optNum(),
  inMax: optNum(),
  outMin: optNum(),
  outMax: optNum(),
  invert: s.optional(s.boolean()),
  clamp: s.optional(s.boolean()),
  smoothing: optNum({ min: 0, max: 1 }),
  followPhysics: s.optional(
    s.boolean('When physics overwrites the output, write its driver instead (default true).'),
  ),
  smoother: s.optional(
    s.string({
      enum: SMOOTHER_KINDS,
      description:
        'How smoothing works: "rate" (a rate limit, rising faster than falling) or "exponential". Default: rate for the voice inputs, exponential for the rest.',
    }),
  ),
});

export function studioCommands(): Array<CommandDef<unknown, unknown, StudioApi>> {
  return [
    // --- reading ------------------------------------------------------------
    command({
      name: 'get_state',
      summary:
        'The current state: model, camera and microphone status, expressions, items, stage and history.',
      scope: 'read',
      quiet: true,
      args: s.object({}),
      run: (c) => ({
        model: c.model
          ? {
              loaded: true,
              name: c.model.manifest.file,
              source: c.model.files.label,
              key: c.model.key,
            }
          : { loaded: false },
        camera: { on: c.cameraOn, faceFound: c.cameraOn && c.faceVisible },
        microphone: { on: c.microphoneOn },
        expressions: [...c.activeExpressions],
        items: c.items.map((i) => itemView(c, i)),
        overrides: { ...c.overrides },
        lipSync: c.settings?.lipSync ?? null,
        stage: {
          ...c.stage,
          background:
            c.stage.background.kind === 'image'
              ? { kind: 'image', fit: c.stage.background.fit }
              : c.stage.background,
          perModel: !!c.settings?.stageOverride,
          transform: c.settings?.transform ?? null,
        },
        history: { canUndo: c.commands.canUndo, canRedo: c.commands.canRedo },
        agents: c.agents,
        spout: c.spoutStatus(),
        virtualCamera: c.virtualCameraStatus(),
        collab: c.collab?.state() ?? COLLAB_OFF,
      }),
    }),
    command({
      name: 'describe_model',
      summary:
        'The loaded model: parameters (ids, names, ranges, defaults), expressions, motions, items, hotkeys and tracking inputs.',
      scope: 'read',
      quiet: true,
      args: s.object({}),
      run: (c) => {
        const m = needModel(c);
        return {
          name: m.manifest.file,
          parameters: withDrivers(c),
          expressions: m.manifest.expressions.map((e) => ({ name: e.name, file: e.file })),
          expressionsFoundInFolder: m.manifest.discovered.expressions,
          motions: motionList(c),
          idleMotion: m.settings.idleMotion ?? null,
          items: c.items.map((i) => itemView(c, i)),
          hotkeys: m.settings.hotkeys.map(hotkeyView),
          physics: m.settings.physics,
          inputs: TRACKING_INPUT_IDS,
        };
      },
    }),
    command({
      name: 'get_parameters',
      summary:
        'Parameter ranges and defaults, and the values agents have set (overrides). Tracked values are not readable.',
      scope: 'read',
      quiet: true,
      args: s.object({
        ids: s.optional(s.array(s.string({ maxLength: 100 }), { maxItems: 1000 })),
      }),
      run: (c, a) => {
        needModel(c);
        const want = a.ids ? new Set(a.ids) : undefined;
        const ps = c.parameters.filter((p) => !want || want.has(p.id));
        return {
          parameters: withDrivers(c, ps).map((p) => ({
            ...p,
            override: c.overrides[p.id] ?? null,
          })),
          unknown: a.ids?.filter((id) => !c.parameters.some((p) => p.id === id)) ?? [],
        };
      },
    }),
    command({
      name: 'get_mapping',
      summary: 'The tracking mapping rules (tracking input → model parameter).',
      scope: 'read',
      quiet: true,
      args: s.object({}),
      run: (c) => ({ rules: needModel(c).settings.mapping, mirror: needModel(c).settings.mirror }),
    }),
    command({
      name: 'list_hotkeys',
      summary: 'The model’s hotkeys and what they do.',
      scope: 'read',
      quiet: true,
      args: s.object({}),
      run: (c) => ({ hotkeys: needModel(c).settings.hotkeys.map(hotkeyView) }),
    }),
    command({
      name: 'list_items',
      summary: 'The items (props) of the loaded model, with visibility, placement and pin.',
      scope: 'read',
      quiet: true,
      args: s.object({}),
      run: (c) => ({ items: c.items.map((i) => itemView(c, i)) }),
    }),
    command({
      name: 'get_log',
      summary: 'The latest commands run (by the UI, agents and replays), oldest first.',
      scope: 'read',
      quiet: true,
      args: s.object({ limit: s.optional(s.number({ min: 1, max: 500, integer: true })) }),
      run: (c, a) => ({ entries: c.commands.entries(a.limit ?? 50) }),
    }),
    command({
      name: 'list_commands',
      summary: 'Every command with its scope and argument schema.',
      scope: 'read',
      quiet: true,
      args: s.object({}),
      run: (c) => ({ commands: c.commands.catalog() }),
    }),

    // --- the model ----------------------------------------------------------
    command({
      name: 'load_model',
      summary: 'Loads a model from a URL of a .model3.json file or a .zip (the page fetches it).',
      details:
        'Local folders cannot be opened by an agent: the browser only reads files the user picks.',
      scope: 'control',
      args: s.object({
        url: s.string({ maxLength: 2000, description: 'http(s) URL of a .model3.json or .zip.' }),
      }),
      run: async (c, a) => {
        if (!/^https?:\/\//i.test(a.url))
          throw new CommandError('invalid_arguments', 'url must start with http:// or https://.');
        await c.loadModelFromUrl(a.url);
        return { loaded: c.model?.manifest.file };
      },
    }),
    command({
      name: 'unload_model',
      summary: 'Removes the model from the stage.',
      scope: 'control',
      args: s.object({}),
      run: (c) => {
        c.unloadModel();
        return { loaded: false };
      },
    }),
    command({
      name: 'set_parameters',
      summary:
        'Sets parameter values that win over tracking, until cleared or until ttl_seconds pass.',
      details:
        'Values are kept within each parameter’s range by the renderer. Unknown ids are listed in unknown.',
      scope: 'control',
      args: s.object({
        values: s.record(s.number(), { maxKeys: 500, description: 'Parameter id → value.' }),
        ttl_seconds: s.optional(
          s.number({
            min: 0.05,
            max: 3600,
            description: 'Clear these values after this many seconds.',
          }),
        ),
      }),
      undo: (c) => {
        const before = { ...c.overrides };
        return () => c.restore({ ...snapshot(c), overrides: before });
      },
      run: (c, a) => {
        needModel(c);
        const known = new Set(c.parameters.map((p) => p.id));
        const values = Object.fromEntries(Object.entries(a.values).filter(([k]) => known.has(k)));
        c.setOverrides(values, a.ttl_seconds === undefined ? undefined : a.ttl_seconds * 1000);
        const driven = Object.fromEntries(
          Object.keys(values)
            .filter((k) => c.physicsDrivers[k])
            .map((k) => [k, c.physicsDrivers[k]!.from]),
        );
        return {
          set: values,
          unknown: Object.keys(a.values).filter((k) => !known.has(k)),
          ...(Object.keys(driven).length
            ? {
                drivenByPhysics: driven,
                note: `Physics overwrites ${Object.keys(driven).join(', ')} every frame, so these values have no visible effect. Set ${Object.entries(
                  driven,
                )
                  .map(([k, v]) => `${v} (for ${k})`)
                  .join(', ')} instead.`,
              }
            : {}),
        };
      },
    }),
    command({
      name: 'clear_parameters',
      summary:
        'Removes parameter values set with set_parameters (all, or the ids given), so tracking drives them again.',
      scope: 'control',
      args: s.object({
        ids: s.optional(s.array(s.string({ maxLength: 100 }), { maxItems: 1000 })),
      }),
      undo: (c) => {
        const before = { ...c.overrides };
        return () => c.restore({ ...snapshot(c), overrides: before });
      },
      run: (c, a) => {
        c.clearOverrides(a.ids);
        return { overrides: { ...c.overrides } };
      },
    }),
    command({
      name: 'set_expression',
      summary: 'Turns an expression on or off (by name, or by .exp3.json path).',
      scope: 'control',
      args: s.object({
        expression: s.string({ maxLength: 300 }),
        on: s.optional(s.boolean('Default true.')),
      }),
      undo: (c, a) => {
        const was = c.activeExpressions.has(a.expression);
        return () => c.setExpression(a.expression, was);
      },
      run: (c, a) => {
        const m = needModel(c);
        const e = m.manifest.expressions.find(
          (x) => x.name === a.expression || x.file === a.expression,
        );
        if (!e)
          throw new CommandError(
            'unknown_expression',
            `Unknown expression "${a.expression}". describe_model lists them: ${m.manifest.expressions.map((x) => x.name).join(', ') || 'this model has none'}.`,
          );
        c.setExpression(e.name, a.on ?? true);
        return { expressions: [...c.activeExpressions] };
      },
    }),
    command({
      name: 'clear_expressions',
      summary: 'Turns every expression off.',
      scope: 'control',
      args: s.object({}),
      undo: (c) => {
        const was = [...c.activeExpressions];
        return () => was.forEach((e) => c.setExpression(e, true));
      },
      run: (c) => {
        for (const e of [...c.activeExpressions]) c.setExpression(e, false);
        return { expressions: [] };
      },
    }),
    command({
      name: 'play_motion',
      summary:
        'Plays a motion once, or holds its last frame (hold again to release). Name it by group and index, or by name or file.',
      scope: 'control',
      args: s.object({
        group: s.optional(s.string({ maxLength: 200 })),
        index: s.optional(s.number({ min: 0, integer: true })),
        name: s.optional(
          s.string({
            maxLength: 300,
            description: 'The motion’s name or .motion3.json path, as describe_model lists it.',
          }),
        ),
        mode: s.optional(s.string({ enum: ['once', 'hold'], description: 'Default once.' })),
      }),
      run: (c, a) => {
        needModel(c);
        const list = motionList(c);
        const m = a.name
          ? list.find((x) => x.name === a.name || x.file === a.name)
          : list.find((x) => x.group === (a.group ?? '') && x.index === (a.index ?? 0));
        if (!m)
          throw new CommandError(
            'unknown_motion',
            `No such motion. describe_model lists the motions: ${list.map((x) => x.name).join(', ') || 'this model has none'}.`,
          );
        c.playMotion({ group: m.group, index: m.index }, (a.mode as 'once' | 'hold') ?? 'once');
        return { started: { group: m.group, index: m.index, name: m.name } };
      },
    }),
    command({
      name: 'stop_motions',
      summary: 'Stops the playing motion and releases a held one.',
      scope: 'control',
      args: s.object({}),
      run: (c) => {
        c.stopMotions();
        return { stopped: true };
      },
    }),
    command({
      name: 'list_item_scenes',
      summary:
        'The item scenes of the loaded model: id, name, group, their items, and whether each is on.',
      scope: 'read',
      quiet: true,
      args: s.object({}),
      run: (c) => ({
        scenes: (c.settings?.itemScenes ?? []).map((x) => sceneView(c, x)),
      }),
    }),
    command({
      name: 'set_item_scene',
      summary:
        'Turns an item scene on (its items show where the scene has them; the other scenes of its group turn off) or off.',
      details: 'The scene by id or name. fade: seconds the items take to fade in or out.',
      scope: 'control',
      args: s.object({
        scene: s.string({ maxLength: 100 }),
        on: s.optional(s.boolean('Default: the opposite of now.')),
        fade: optNum({ min: 0, max: MAX_SCENE_FADE_S }),
      }),
      run: (c, a) => {
        const x = findScene(c, a.scene);
        const on = a.on ?? !c.isItemSceneOn(x.id);
        c.setItemScene(x.id, on, a.fade ?? 0);
        return { scene: sceneView(c, x) };
      },
    }),
    command({
      name: 'create_item_scene',
      summary:
        'Makes an item scene from items as they are placed now: by default every item shown now.',
      scope: 'control',
      args: s.object({
        name: s.string({ maxLength: 100 }),
        group: s.optional(
          s.string({
            maxLength: 64,
            description: 'Turning one scene of a group on turns the group’s others off.',
          }),
        ),
        items: s.optional(s.array(s.string({ maxLength: 100 }), { maxItems: 500 })),
      }),
      undo: (c) => restoreSettings(c),
      run: (c, a) => {
        needModel(c);
        const ids = a.items ?? c.items.filter((i) => c.isItemVisible(i.id)).map((i) => i.id);
        const unknown = ids.filter((id) => !c.items.some((i) => i.id === id));
        if (unknown.length)
          throw new CommandError(
            'unknown_item',
            `Unknown item ${unknown.map((u) => `"${u}"`).join(', ')}. list_items gives the ids.`,
          );
        if (!a.name.trim()) throw new CommandError('invalid_arguments', 'The scene needs a name.');
        const x = c.createItemScene(a.name.trim(), (a.group ?? '').trim(), ids);
        return { scene: sceneView(c, x) };
      },
    }),
    command({
      name: 'remove_item_scene',
      summary: 'Removes an item scene (by id or name); its items stay as they are.',
      scope: 'control',
      args: s.object({ scene: s.string({ maxLength: 100 }) }),
      undo: (c) => restoreSettings(c),
      run: (c, a) => {
        const x = findScene(c, a.scene);
        c.removeItemScene(x.id);
        return { removed: x.id };
      },
    }),
    command({
      name: 'set_item',
      summary:
        'Shows or hides an item, places it (main-model units, degrees), puts it in front or behind, or pins it.',
      scope: 'control',
      args: s.object({
        id: s.string({ maxLength: 50 }),
        visible: s.optional(s.boolean()),
        x: optNum(),
        y: optNum(),
        scale: optNum({ min: 0.01, max: 100 }),
        rotation: optNum(),
        front: s.optional(s.boolean()),
        pinned: s.optional(s.boolean('Pin to the part of the model under the item’s anchor.')),
      }),
      undo: (c) => restoreSettings(c),
      run: (c, a) => {
        if (!c.items.some((i) => i.id === a.id))
          throw new CommandError(
            'unknown_item',
            `Unknown item "${a.id}". list_items gives the ids: ${c.items.map((i) => i.id).join(', ') || 'there are none'}.`,
          );
        const place: Partial<ItemPlacement> = {};
        for (const k of ['x', 'y', 'scale', 'rotation', 'front'] as const)
          if (a[k] !== undefined) (place as Record<string, unknown>)[k] = a[k];
        if (Object.keys(place).length) c.placeItem(a.id, place);
        if (a.visible !== undefined) c.setItemVisible(a.id, a.visible);
        let pinOk = true;
        if (a.pinned !== undefined) pinOk = c.pinItem(a.id, a.pinned);
        const item = c.items.find((i) => i.id === a.id)!;
        return {
          item: itemView(c, item),
          ...(pinOk
            ? {}
            : { note: 'Nothing of the model lies under the item’s anchor to pin to.' }),
        };
      },
    }),
    command({
      name: 'fire_hotkey',
      summary:
        'Fires a hotkey as if its keys were pressed. For "while held" hotkeys, call release_hotkey to let go.',
      scope: 'control',
      args: s.object({ id: s.string({ maxLength: 50 }) }),
      run: (c, a) => {
        const h = needModel(c).settings.hotkeys.find((x) => x.id === a.id);
        if (!h)
          throw new CommandError(
            'unknown_hotkey',
            `Unknown hotkey "${a.id}". list_hotkeys gives the ids.`,
          );
        c.fireHotkey(a.id);
        return { fired: hotkeyView(h) };
      },
    }),
    command({
      name: 'release_hotkey',
      summary: 'Releases a "while held" hotkey fired with fire_hotkey.',
      scope: 'control',
      args: s.object({ id: s.string({ maxLength: 50 }) }),
      run: (c, a) => {
        c.releaseHotkey(a.id);
        return { released: a.id };
      },
    }),

    // --- tracking and lip sync ----------------------------------------------
    command({
      name: 'set_mapping',
      summary:
        'Replaces the tracking mapping rules (tracking input → model parameter, with ranges, invert, clamp and smoothing).',
      scope: 'control',
      args: s.object({
        rules: s.array(ruleSchema, { maxItems: 500 }),
        mirror: s.optional(s.boolean()),
      }),
      undo: (c) => restoreSettings(c),
      run: (c, a) => {
        needModel(c);
        const rules = a.rules.map((r) =>
          makeRule(stripUndefined(r) as Parameters<typeof makeRule>[0]),
        );
        c.updateSettings({
          mapping: rules,
          ...(a.mirror === undefined ? {} : { mirror: a.mirror }),
        });
        return { rules };
      },
    }),
    command({
      name: 'update_mapping_rule',
      summary: 'Changes some fields of one mapping rule (by id; get_mapping lists them).',
      scope: 'control',
      args: s.object({
        id: s.string({ maxLength: 50 }),
        input: s.optional(s.string({ maxLength: 200 })),
        output: s.optional(s.string({ maxLength: 100 })),
        enabled: s.optional(s.boolean()),
        inMin: optNum(),
        inMax: optNum(),
        outMin: optNum(),
        outMax: optNum(),
        invert: s.optional(s.boolean()),
        clamp: s.optional(s.boolean()),
        smoothing: optNum({ min: 0, max: 1 }),
        followPhysics: s.optional(s.boolean()),
        smoother: s.optional(s.string({ enum: SMOOTHER_KINDS })),
      }),
      undo: (c) => restoreSettings(c),
      run: (c, a) => {
        const m = needModel(c);
        const rule = m.settings.mapping.find((r) => r.id === a.id);
        if (!rule)
          throw new CommandError(
            'unknown_rule',
            `Unknown mapping rule "${a.id}". get_mapping lists the rules.`,
          );
        const { id, ...patch } = a;
        const next: MappingRule = { ...rule, ...(stripUndefined(patch) as Partial<MappingRule>) };
        c.updateSettings({ mapping: m.settings.mapping.map((r) => (r.id === id ? next : r)) });
        return { rule: next };
      },
    }),
    command({
      name: 'calibrate',
      summary:
        'Calibrates the neutral pose: the person looks straight ahead for about 4.5 s. Needs the camera on (or a phone tracking).',
      scope: 'control',
      args: s.object({}),
      undo: (c) => restoreSettings(c),
      run: async (c) => {
        needModel(c);
        if (!c.trackingOn)
          throw new CommandError(
            'camera_off',
            'The camera is off and no phone is tracking. Only the person at the computer can start them, in the Tracking tab.',
          );
        return { calibrated: await c.calibrate() };
      },
    }),
    command({
      name: 'set_lip_sync',
      summary:
        'How the microphone’s lip sync combines with the tracked mouth, its sensitivity and its noise gate.',
      details:
        'Modes: tracking (camera only), microphone, max, add, blend (weight 0 = camera, 1 = microphone).',
      scope: 'control',
      args: s.object({
        type: s.optional(
          s.string({
            enum: ['simple', 'advanced'],
            description: 'simple: the volume opens the mouth; advanced: vowels too (motion sync).',
          }),
        ),
        motionSync: s.optional(
          s.string({
            description:
              'Advanced: a setting of the model’s motion-sync file whose shapes move the mouth; empty for the vowel inputs only.',
          }),
        ),
        voiceProcessing: s.optional(
          s.boolean('Advanced: the browser’s echo cancellation and noise suppression.'),
        ),
        vowelForm: s.optional(
          s.boolean(
            'Advanced: the vowels shape the mouth form (I and E widen it, U and O round it).',
          ),
        ),
        frequencyWeights: s.optional(
          s.object(
            {
              A: optNum({ min: -1, max: 1 }),
              I: optNum({ min: -1, max: 1 }),
              U: optNum({ min: -1, max: 1 }),
              E: optNum({ min: -1, max: 1 }),
              O: optNum({ min: -1, max: 1 }),
            },
            'Advanced: how much each vowel moves the VoiceFrequency input (an approximation), −1 to 1; it rests at 0.5. Missing vowels keep their weight.',
          ),
        ),
        mode: s.optional(s.string({ enum: LIP_SYNC_MODES })),
        weight: optNum({ min: 0, max: 1 }),
        gain: optNum({ min: 0, max: 10, description: 'Sensitivity; 1 is Mochi2D’s default.' }),
        gate: optNum({ min: GATE_MIN_DB, max: GATE_MAX_DB, description: 'Noise gate in dBFS.' }),
      }),
      undo: (c) => restoreSettings(c),
      run: (c, a) => {
        const m = needModel(c);
        const { motionSync, frequencyWeights, ...rest } = stripUndefined(
          a,
        ) as Partial<LipSyncSettings>;
        const { motionSync: _old, ...current } = m.settings.lipSync;
        const keep = motionSync === undefined ? m.settings.lipSync.motionSync : motionSync;
        const lipSync: LipSyncSettings = {
          ...current,
          ...rest,
          ...(keep ? { motionSync: keep.slice(0, 100) } : {}),
          ...(frequencyWeights
            ? {
                frequencyWeights: parseFrequencyWeights({
                  ...(current.frequencyWeights ?? DEFAULT_FREQUENCY_WEIGHTS),
                  ...stripUndefined(frequencyWeights),
                }),
              }
            : {}),
        };
        c.updateSettings({ lipSync });
        return { lipSync };
      },
    }),

    // --- output -------------------------------------------------------------
    command({
      name: 'set_background',
      summary:
        'Sets the background: transparent, chroma (key color), color, or image (a data: URL).',
      details: 'Applies app-wide, or to the model when it has its own background (per_model).',
      scope: 'control',
      args: s.object({
        kind: s.string({ enum: ['transparent', 'chroma', 'color', 'image'] }),
        color: s.optional(hex),
        image: s.optional(
          s.string({ maxLength: 12_000_000, description: 'data:image/png|jpeg|webp|gif;base64,…' }),
        ),
        fit: s.optional(s.string({ enum: ['cover', 'contain'] })),
        per_model: s.optional(s.boolean('Give this model its own background and frame cap.')),
      }),
      undo: (c) => restoreSettings(c),
      run: (c, a) => {
        let b: Background;
        if (a.kind === 'transparent') b = { kind: 'transparent' };
        else if (a.kind === 'image') {
          if (!a.image || !/^data:image\/(png|jpeg|webp|gif);base64,/.test(a.image))
            throw new CommandError(
              'invalid_arguments',
              'image must be a data:image/(png|jpeg|webp|gif);base64 URL.',
            );
          b = { kind: 'image', src: a.image, fit: (a.fit as 'cover' | 'contain') ?? 'cover' };
        } else {
          const color = a.color ?? (a.kind === 'chroma' ? '#00ff00' : '#202028');
          if (!/^#[0-9a-f]{6}$/i.test(color))
            throw new CommandError('invalid_arguments', 'color must be #rrggbb.');
          b = { kind: a.kind as 'chroma' | 'color', color };
        }
        if (a.per_model !== undefined && c.settings)
          c.updateSettings({ stageOverride: a.per_model });
        c.setStage({ background: b });
        return { background: a.kind === 'image' ? { kind: 'image' } : b };
      },
    }),
    command({
      name: 'set_transform',
      summary:
        'Places the model: x, y (canvas heights from the centre, y down), zoom (1 = fitted) and rotation (degrees, clockwise).',
      scope: 'control',
      args: s.object({
        x: optNum({ min: -10, max: 10 }),
        y: optNum({ min: -10, max: 10 }),
        zoom: optNum({ min: ZOOM_MIN, max: ZOOM_MAX }),
        rotation: optNum({ min: -180, max: 180 }),
      }),
      undo: (c) => restoreSettings(c),
      run: (c, a) => {
        const m = needModel(c);
        const transform: SceneTransform = {
          ...m.settings.transform,
          ...(stripUndefined(a) as Partial<SceneTransform>),
        };
        c.updateSettings({ transform });
        return { transform };
      },
    }),
    command({
      name: 'set_frame_cap',
      summary: 'Caps the frame rate (0 = uncapped).',
      scope: 'control',
      args: s.object({ fps: s.number({ min: 0, max: 240, integer: true }) }),
      undo: (c) => restoreSettings(c),
      run: (c, a) => {
        c.setStage({ fpsCap: a.fps });
        return { fps: a.fps };
      },
    }),
    command({
      name: 'set_spout',
      summary:
        'Spout2 output in the desktop app on Windows: up to four outputs, each sent as MochiStudio, MochiStudio2, …',
      details:
        'Each output is on or off, can be mirrored, and has the stage size unless width and height are given (16 to 7680). get_state shows each sender.',
      scope: 'control',
      args: s.object({
        outputs: s.array(
          s.object({
            enabled: s.boolean(),
            mirror: s.optional(s.boolean()),
            width: optNum({ min: SPOUT_MIN_SIZE, max: SPOUT_MAX_SIZE, integer: true }),
            height: optNum({ min: SPOUT_MIN_SIZE, max: SPOUT_MAX_SIZE, integer: true }),
          }),
          { maxItems: SPOUT_MAX_OUTPUTS },
        ),
      }),
      undo: (c) => restoreSettings(c),
      run: (c, a) => {
        const st = c.spoutStatus();
        if (!st.available)
          throw new CommandError('unavailable', st.problem ?? 'Spout2 is not available here.');
        if (a.outputs.some((o) => (o.width === undefined) !== (o.height === undefined)))
          throw new CommandError('invalid_arguments', 'Give both width and height, or neither.');
        const settings = parseSpout({
          outputs: a.outputs.map((o) => ({
            enabled: o.enabled,
            mirror: o.mirror ?? false,
            ...(o.width !== undefined ? { size: { width: o.width, height: o.height } } : {}),
          })),
        });
        c.setSpout(settings);
        return {
          outputs: settings.outputs.map((o, i) => ({ name: spoutSenderName(i), ...o })),
        };
      },
    }),
    command({
      name: 'set_virtual_camera',
      summary: `The virtual camera in the desktop app (Linux for now): the avatar as a camera named "${CAMERA_NAME}" that other apps open.`,
      details: `Fields left out keep their value. Sizes: ${CAMERA_SIZES.map((z) => `${z.width}×${z.height}`).join(', ')}; rates: ${CAMERA_RATES.join(' or ')}. The background is "stage" (the stage's own) or a #rrggbb color under the avatar (video apps show no transparency). Mirror is off by default: call apps mirror only the person's own preview. get_state.virtualCamera shows the device and what to install when it is missing.`,
      scope: 'control',
      args: s.object({
        enabled: s.optional(s.boolean()),
        width: optNum({ min: 960, max: 1920, integer: true }),
        height: optNum({ min: 540, max: 1080, integer: true }),
        fps: optNum({ min: 30, max: 60, integer: true }),
        mirror: s.optional(s.boolean()),
        background: s.optional(
          s.string({ maxLength: 7, description: '"stage", or a color as #rrggbb.' }),
        ),
      }),
      undo: (c) => restoreSettings(c),
      run: (c, a) => {
        const st = c.virtualCameraStatus();
        if (!st.available)
          throw new CommandError(
            'unavailable',
            st.problem ?? 'The virtual camera is not available here.',
          );
        if ((a.width === undefined) !== (a.height === undefined))
          throw new CommandError('invalid_arguments', 'Give both width and height, or neither.');
        const size = a.width === undefined ? st.settings : { width: a.width, height: a.height! };
        if (!CAMERA_SIZES.some((z) => z.width === size.width && z.height === size.height))
          throw new CommandError(
            'invalid_arguments',
            `The camera offers ${CAMERA_SIZES.map((z) => `${z.width}×${z.height}`).join(', ')}.`,
          );
        if (a.fps !== undefined && !CAMERA_RATES.some((r) => r === a.fps))
          throw new CommandError('invalid_arguments', `The rate is ${CAMERA_RATES.join(' or ')}.`);
        if (
          a.background !== undefined &&
          a.background !== 'stage' &&
          !/^#[0-9a-fA-F]{6}$/.test(a.background)
        )
          throw new CommandError('invalid_arguments', 'The background is "stage" or #rrggbb.');
        const settings = parseVirtualCamera({
          ...st.settings,
          ...(a.enabled !== undefined ? { enabled: a.enabled } : {}),
          width: size.width,
          height: size.height,
          ...(a.fps !== undefined ? { fps: a.fps } : {}),
          ...(a.mirror !== undefined ? { mirror: a.mirror } : {}),
          ...(a.background !== undefined
            ? {
                background:
                  a.background === 'stage'
                    ? { kind: 'stage' }
                    : { kind: 'color', color: a.background },
              }
            : {}),
        });
        c.setVirtualCamera(settings);
        return settings;
      },
    }),
    ...collabCommands(),
    command({
      name: 'speak',
      summary:
        'Plays a sound (WAV, MP3, Ogg…, base64) and moves the mouth with it. Resolves when it ends.',
      details: 'Text-to-speech is not built in: send the audio of your own speech. At most 10 MB.',
      scope: 'control',
      args: s.object({
        audio: s.string({ maxLength: 14_000_000, description: 'The audio file, base64.' }),
        volume: optNum({ min: 0, max: 1 }),
      }),
      run: async (c, a) => {
        needModel(c);
        let bytes: Uint8Array;
        try {
          bytes = base64ToBytes(a.audio);
        } catch {
          throw new CommandError('invalid_arguments', 'audio must be base64.');
        }
        await c.speak(bytes, a.volume ?? 1);
        return { spoke: true, bytes: bytes.length };
      },
    }),
    command({
      name: 'screenshot',
      summary: 'A PNG of the avatar as it is now, with a transparent background.',
      scope: 'screenshot',
      quiet: true,
      args: s.object({}),
      run: async (c) => {
        needModel(c);
        const png = await c.screenshot();
        return { mimeType: 'image/png', data: bytesToBase64(png) };
      },
    }),

    // --- history ------------------------------------------------------------
    command({
      name: 'undo',
      summary: 'Undoes the latest change of settings, expressions or parameter values.',
      scope: 'control',
      args: s.object({}),
      run: (c) => ({ undone: c.commands.undo() ?? null }),
    }),
    command({
      name: 'redo',
      summary: 'Runs the latest undone command again.',
      scope: 'control',
      args: s.object({}),
      run: async (c) => ({ redone: (await c.commands.redo()) ?? null }),
    }),
    command({
      name: 'replay_log',
      summary:
        'Runs logged commands again, in order (control commands only), as get_log returns them.',
      scope: 'control',
      args: s.object({
        entries: s.array(
          s.object({
            name: s.string({ maxLength: 100 }),
            args: s.optional(s.any()),
            time: optNum(),
            ok: s.optional(s.boolean()),
            seq: optNum(),
            origin: s.optional(s.any()),
            error: s.optional(s.any()),
          }),
          { maxItems: 1000 },
        ),
        keep_timing: s.optional(
          s.boolean('Wait between commands as they were spaced (at most 5 s each).'),
        ),
      }),
      run: (c, a) =>
        c.commands.replay(a.entries as Array<Pick<LogEntry, 'name' | 'args'>>, {
          keepTiming: a.keep_timing ?? false,
        }),
    }),
  ];
}

/** Tracking input ids that mapping rules can use (besides bs.<blendshape> and mean(…)). */
const TRACKING_INPUT_IDS = DERIVED_INPUTS.map((i) => i.id);

function stripUndefined(o: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

export function bytesToBase64(b: Uint8Array): string {
  let out = '';
  for (let i = 0; i < b.length; i += 0x8000)
    out += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(out);
}
export function base64ToBytes(s: string): Uint8Array {
  const bin = atob(s.replace(/^data:[^,]*,/, '').replace(/\s/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Collaboration: host, join, the door, leave, hide and block. */
function collabCommands(): Array<CommandDef<unknown, unknown, StudioApi>> {
  const need = (c: StudioApi): CollabApi => {
    if (!c.collab) throw new CommandError('unavailable', 'Collaboration is not available here.');
    return c.collab;
  };
  const inSession = (c: StudioApi): CollabApi => {
    const api = need(c);
    const st = api.state().status;
    if (st === 'off' || st === 'ended')
      throw new CommandError('no_session', 'There is no session.');
    return api;
  };
  const host = (c: StudioApi): CollabApi => {
    const api = inSession(c);
    if (!api.state().isHost) throw new CommandError('not_host', 'Only the host can do that.');
    return api;
  };
  const person = (api: CollabApi, peer: string) => {
    const p = api.state().people.find((x) => x.id === peer || x.name === peer);
    if (!p || p.me) throw new CommandError('unknown_participant', `No participant ${peer}.`);
    return p.id;
  };
  const peerArg = s.string({
    maxLength: 64,
    description: 'A participant’s id (or nickname), from get_state.collab.',
  });
  return [
    command({
      name: 'collab_host',
      summary:
        'Opens a collaboration session with the app’s Collab settings, and returns the invitation link and its code.',
      details:
        'The link and the code (the same invitation, to read aloud) are private: share them only with the people you invite. They are never in get_state. With a password, people also need it to ask to join; it never leaves this app. People who ask appear in get_state.collab.knocks; let them in with collab_answer.',
      scope: 'control',
      args: s.object({ password: s.optional(s.string({ maxLength: 200 })) }),
      run: async (c, a) => {
        const api = need(c);
        try {
          return await api.host(a.password ? { password: a.password } : {});
        } catch (e) {
          throw new CommandError('unavailable', (e as Error).message);
        }
      },
    }),
    command({
      name: 'collab_join',
      summary: 'Asks to join a collaboration session from its invitation link or code.',
      details:
        'A code uses the app’s Signaling server setting. The host decides; get_state.collab.status is "waiting" until then, then "member", or "ended" with a message.',
      scope: 'control',
      args: s.object({
        link: s.string({ maxLength: 500, description: 'The invitation link, or its code.' }),
        password: s.optional(s.string({ maxLength: 200 })),
      }),
      run: (c, a) => {
        if (!need(c).join(a.link, a.password))
          throw new CommandError('invalid_arguments', 'That isn’t an invitation link or code.');
        return { asked: true };
      },
    }),
    command({
      name: 'collab_new_link',
      summary:
        'The host makes a new invitation: the old link and code stop working; people already in stay.',
      scope: 'control',
      args: s.object({}),
      run: (c) => {
        const r = host(c).newLink();
        if (!r) throw new CommandError('unavailable', 'No invitation yet.');
        return r;
      },
    }),
    command({
      name: 'collab_chat',
      summary:
        'Sends a chat message to everyone in the session (text only, at most 500 characters).',
      details:
        'At most 5 messages in 10 seconds. get_state.collab.chat has the last 50; nothing is kept after the session.',
      scope: 'control',
      args: s.object({ text: s.string({ maxLength: 500 }) }),
      run: (c, a) => {
        if (!inSession(c).chat(a.text))
          throw new CommandError(
            'invalid_arguments',
            'Empty, too long, or too many messages at once.',
          );
        return { sent: true };
      },
    }),
    command({
      name: 'collab_leave',
      summary: 'Leaves the session (the host ends it for everyone).',
      scope: 'control',
      args: s.object({}),
      run: (c) => {
        inSession(c).leave();
        return { left: true };
      },
    }),
    command({
      name: 'collab_answer',
      summary: 'The host lets someone in who asked to join, or declines.',
      scope: 'control',
      args: s.object({ peer: peerArg, admit: s.boolean() }),
      run: (c, a) => {
        const api = host(c);
        const k = api.state().knocks.find((x) => x.id === a.peer || x.name === a.peer);
        if (!k) throw new CommandError('unknown_participant', `No one called ${a.peer} is asking.`);
        if (a.admit && !k.valid)
          throw new CommandError(
            'invalid_arguments',
            'They don’t have the invitation (their name didn’t decrypt).',
          );
        if (a.admit) api.admit(k.id);
        else api.decline(k.id);
        return { peer: k.id, admitted: a.admit };
      },
    }),
    command({
      name: 'collab_remove',
      summary: 'The host removes a participant; their app can’t ask again in this session.',
      scope: 'control',
      args: s.object({ peer: peerArg }),
      run: (c, a) => {
        const api = host(c);
        const id = person(api, a.peer);
        api.remove(id);
        return { removed: id };
      },
    }),
    command({
      name: 'collab_lock',
      summary: 'The host locks the session (no one else can ask to join), or opens it again.',
      scope: 'control',
      args: s.object({ locked: s.boolean() }),
      run: (c, a) => {
        host(c).lock(a.locked);
        return { locked: a.locked };
      },
    }),
    command({
      name: 'collab_hide',
      summary:
        'Hides a participant’s avatar on this screen (and its output views) only, or shows it again.',
      scope: 'control',
      args: s.object({ peer: peerArg, hidden: s.boolean() }),
      run: (c, a) => {
        const api = inSession(c);
        const id = person(api, a.peer);
        api.hide(id, a.hidden);
        return { peer: id, hidden: a.hidden };
      },
    }),
    command({
      name: 'collab_place',
      summary:
        'Places a participant’s avatar on this screen by hand: it stays where it is (or where it is dragged) instead of where they stand, and with pinned, follows this app’s model.',
      details:
        'Only on this screen and its output views. here: false puts it back where they stand.',
      scope: 'control',
      args: s.object({ peer: peerArg, here: s.boolean(), pinned: s.optional(s.boolean()) }),
      run: (c, a) => {
        const api = inSession(c);
        const id = person(api, a.peer);
        api.placeHere(id, a.here, a.pinned ?? false);
        return { peer: id, here: a.here, pinned: a.here && (a.pinned ?? false) };
      },
    }),
    command({
      name: 'collab_order',
      summary:
        'Sets this screen’s own front-to-back order of everyone (ids or nicknames, back first), or with none, the shared order again.',
      details:
        'Only on this screen and its output views; people left out keep the shared order, in front.',
      scope: 'control',
      args: s.object({
        order: s.optional(s.array(peerArg, { maxItems: 6 })),
      }),
      run: (c, a) => {
        const api = inSession(c);
        if (!a.order) {
          api.setLocalOrder(undefined);
          return { order: api.state().order, local: false };
        }
        const st = api.state();
        const ids = a.order.map((x) => {
          const p = st.people.find((q) => q.id === x || q.name === x);
          if (!p) throw new CommandError('unknown_participant', `No participant ${x}.`);
          return p.id;
        });
        api.setLocalOrder(ids);
        return { order: api.state().order, local: true };
      },
    }),
    command({
      name: 'collab_block',
      summary:
        'Blocks a participant on this screen: hidden, and what they send (expressions, motions) is ignored. They aren’t told.',
      scope: 'control',
      args: s.object({ peer: peerArg, blocked: s.boolean() }),
      run: (c, a) => {
        const api = inSession(c);
        const id = person(api, a.peer);
        api.block(id, a.blocked);
        return { peer: id, blocked: a.blocked };
      },
    }),
  ];
}
