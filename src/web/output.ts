import { backgroundCss } from '../core/background';
import { FrameLimiter } from '../core/frameCap';
import { MemoryFileSet, RootedFileSet, openModel, type ModelFileSet } from '../core/modelFiles';
import { SYNC_CHANNEL, channelTransport, type SyncMessage } from '../core/sync';
import { COLLAB_ITEM_PREFIX } from '../core/collab/stage';
import { MochiRuntime } from './mochiRuntime';
import { prefetchedFiles, viewBridgeTransport } from './viewBridge';
import { errorText, guard } from '../core/appLog';

/**
 * The clean output view for OBS: only the avatar, on the chosen background.
 * It renders with its own Mochi2D view and is driven by the control window
 * over a BroadcastChannel. It never opens the camera or microphone: the
 * mouth arrives already mixed with lip sync.
 */
const canvas = document.getElementById('stage') as HTMLCanvasElement;
const bg = document.getElementById('bg') as HTMLDivElement;
const runtime = new MochiRuntime();
runtime.attach(canvas);
const limiter = new FrameLimiter(60);
const viewId = crypto.randomUUID();
// With ?bridge=…&view=… (the address from the Output tab, for OBS), the
// view follows the control window through the bridge; otherwise over a
// BroadcastChannel, which works only in the same browser profile.
const query = new URLSearchParams(location.search);
const bridgeUrl = query.get('bridge');
const viewKey = query.get('view');
const bridge =
  bridgeUrl && viewKey
    ? viewBridgeTransport({
        bridge: bridgeUrl,
        key: viewKey,
        viewId,
        onStatus: (s) => (document.body.dataset.bridge = s),
      })
    : undefined;
const transport = bridge ?? channelTransport(new BroadcastChannel(SYNC_CHANNEL));
/**
 * A Spout2 output renders this page with ?transparent=1 (always
 * a transparent background, whatever the stage's) and ?mirror=1 (flipped).
 */
const forceTransparent = query.get('transparent') === '1';
if (query.get('mirror') === '1') canvas.style.transform = 'scaleX(-1)';
if (query.get('spout')) document.body.dataset.spout = query.get('spout')!;
/**
 * A collaboration's video-only avatar: this app's own model
 * alone, framed by its canvas (no stage offset or zoom), on a transparent
 * background, without the collaborators' avatars, and drawn when the
 * control window says (it runs this page in a frame, even while minimized).
 */
const avatarMode = query.get('avatar') === '1';
const isCollab = (id: string) => id.startsWith(COLLAB_ITEM_PREFIX);

/** Load timings of the latest model, for the control window and for tests. */
const loadStats: { bytes: number; fetchMs: number; loadMs: number } = {
  bytes: 0,
  fetchMs: 0,
  loadMs: 0,
};

/** Tells the control window how loading goes (the view itself shows nothing: OBS captures it). */
function status(
  state: 'loading' | 'ready' | 'failed',
  loaded: number,
  total: number,
  ms: number,
  message?: string,
): void {
  transport.post({
    type: 'viewStatus',
    viewId,
    state,
    loaded,
    total,
    ms: Math.round(ms),
    ...(message ? { message } : {}),
  });
}

/** Model or item files from the bridge, prefetched in parallel, with progress. */
function remoteFiles(
  scope: 'model' | 'item',
  owner: string,
  label: string,
  paths: string[],
  sizes: number[] | undefined,
  progress?: { t0: number },
): ReturnType<typeof prefetchedFiles> {
  const total = sizes?.reduce((a, b) => a + b, 0) ?? 0;
  let loaded = 0;
  let last = 0;
  return prefetchedFiles(
    (p) => bridge!.fileUrl(scope, owner, p),
    label,
    paths,
    (n) => {
      loaded += n;
      if (!progress) return;
      const now = performance.now();
      if (now - last > 200) {
        last = now;
        status('loading', loaded, total, now - progress.t0);
      }
    },
  );
}
let loadedKey: string | undefined;
let loading: Promise<void> = Promise.resolve();
let modelReady = false;
const itemIds = new Set<string>();
const params: Record<string, number> = {};
/** Parameter messages from the control window (for tests: they keep their rate while it is hidden). */
let paramsReceived = 0;
/** Collaborator frames from the control window (for tests and debugging). */
let collabFrames = 0;
const clearParams = (): void => {
  for (const k of Object.keys(params)) delete params[k];
};

/** Runs after the model (and items) queued so far are loaded; logs failures. */
function then(fn: () => void | Promise<void>): void {
  loading = loading.then(fn).catch((e) => console.error(e));
}

function handle(m: SyncMessage): void {
  switch (m.type) {
    case 'model':
      if (m.key === loadedKey) return;
      loadedKey = m.key;
      modelReady = false;
      // The old model's values go now; those that come while this one loads are its own
      // (the control window sends them once, right after the model), so they stay.
      clearParams();
      then(async () => {
        for (const id of itemIds) runtime.removeItem(id);
        itemIds.clear();
        const model = await openModel(new MemoryFileSet(m.label, m.files));
        await runtime.load(model);
        modelReady = true;
        document.body.dataset.model = m.key;
      });
      break;
    case 'modelRemote':
      if (!bridge || m.key === loadedKey) return;
      loadedKey = m.key;
      modelReady = false;
      clearParams();
      then(async () => {
        for (const id of itemIds) runtime.removeItem(id);
        itemIds.clear();
        const t0 = performance.now();
        const total = m.sizes?.reduce((a, b) => a + b, 0) ?? 0;
        status('loading', 0, total, 0);
        try {
          const remote = remoteFiles('model', m.key, m.label, m.paths, m.sizes, { t0 });
          const model = await openModel(remote.files);
          await runtime.load(model);
          await remote.done.catch(() => undefined);
          loadStats.bytes = total;
          loadStats.fetchMs = Math.round(remote.fetchMs());
          loadStats.loadMs = Math.round(performance.now() - t0);
          status('ready', total, total, performance.now() - t0);
        } catch (e) {
          status('failed', 0, total, performance.now() - t0, (e as Error).message);
          throw e;
        }
        modelReady = true;
        document.body.dataset.model = m.key;
      });
      break;
    case 'itemsRemote':
      if (!bridge) return;
      then(async () => {
        const wanted = new Set(m.items.map((i) => i.id));
        for (const id of itemIds)
          if (!wanted.has(id)) {
            runtime.removeItem(id);
            itemIds.delete(id);
          }
        for (const i of m.items) {
          if (itemIds.has(i.id) || (avatarMode && isCollab(i.id))) continue;
          await runtime.addItem(i.id, remoteFiles('item', i.id, i.label, i.paths, i.sizes).files, {
            visible: i.visible,
          });
          itemIds.add(i.id);
        }
        document.body.dataset.items = String(itemIds.size);
      });
      break;
    case 'unload':
      loadedKey = undefined;
      modelReady = false;
      then(() => {
        for (const id of itemIds) runtime.removeItem(id);
        itemIds.clear();
        runtime.unload();
        for (const k of Object.keys(params)) delete params[k];
        delete document.body.dataset.model;
      });
      break;
    case 'stage':
      bg.removeAttribute('style');
      if (!forceTransparent)
        for (const [k, v] of Object.entries(backgroundCss(m.background)))
          bg.style.setProperty(k, v);
      document.body.dataset.background = forceTransparent ? 'transparent' : m.background.kind;
      if (!avatarMode) {
        runtime.setTransform(m.transform);
        limiter.fps = m.fpsCap;
      }
      break;
    case 'params':
      paramsReceived++;
      Object.assign(params, m.values);
      for (const k of m.removed ?? []) delete params[k];
      break;
    case 'expression':
      then(() => runtime.setExpression(m.name, m.on, m.fade));
      break;
    case 'motion':
      then(() => runtime.playMotion(m.motion, m.mode));
      break;
    case 'item':
      then(() => runtime.setItemVisible(m.item, m.visible));
      break;
    case 'items':
      then(async () => {
        const wanted = new Set(m.items.map((i) => i.id));
        for (const id of itemIds)
          if (!wanted.has(id)) {
            runtime.removeItem(id);
            itemIds.delete(id);
          }
        for (const i of m.items) {
          if (itemIds.has(i.id) || (avatarMode && isCollab(i.id))) continue;
          await runtime.addItem(i.id, new MemoryFileSet(i.label, i.files), {
            visible: i.visible,
          });
          itemIds.add(i.id);
        }
        document.body.dataset.items = String(itemIds.size);
      });
      break;
    case 'stopMotions':
      then(() => runtime.stopMotions());
      break;
    case 'speak':
      // The control window plays the sound; here only the mouth moves.
      void runtime.speak(m.audio, 0, false).catch((e) => console.warn(e));
      break;
    case 'effects':
      runtime.setEffect('eyeBlink', m.eyeBlink);
      break;
    case 'itemLayout':
      then(() => runtime.applyItemLayout(m.layout));
      break;
    case 'toggles':
      then(() => {
        for (const e of m.expressions) runtime.setExpression(e, true);
        for (const i of m.items) runtime.setItemVisible(i, true);
      });
      break;
    case 'idle':
      then(() => runtime.setIdleMotion(m.file));
      break;
    case 'idleWeights':
      then(() => {
        if (m.all) runtime.resetIdleWeights();
        runtime.setIdleWeights(m.weights);
      });
      break;
    case 'light':
      then(() => runtime.setLight(m.rgb ?? undefined, m.items, m.strengths));
      break;
    case 'physics':
      then(() => runtime.setPhysicsValues(m.values));
      break;
    case 'ownExpressions':
      then(() =>
        runtime.setOwnExpressions(
          m.list.map((o) => ({
            name: o.name,
            file: o.file,
            bytes: new TextEncoder().encode(o.json),
          })),
        ),
      );
      break;
    case 'itemTexture':
      // A web item's frame: the control window renders the page.
      then(async () => {
        const bin = Uint8Array.from(atob(m.webp), (c) => c.charCodeAt(0));
        const bmp = await createImageBitmap(new Blob([bin], { type: 'image/webp' }), {
          premultiplyAlpha: 'none',
        });
        runtime.updateItemTexture(m.id, bmp);
      });
      break;
    case 'collabFrame':
      // The collaborators' avatars: where they stand, how they move, the order.
      if (avatarMode) break;
      collabFrames++;
      for (const a of m.avatars) {
        if (!itemIds.has(a.id)) continue;
        // One avatar's trouble never stops the others.
        guard(report, 'Output view, a collaborator', () => {
          runtime.setItemVisible(a.id, a.visible);
          if (!a.visible) return;
          if (a.params) runtime.setItemParameters(a.id, a.params);
          if (a.placement) runtime.placeItem(a.id, a.placement);
          else runtime.placeItemOnStage(a.id, { ...a.place, front: a.front });
        });
      }
      runtime.raiseItems(m.avatars.filter((a) => itemIds.has(a.id)).map((a) => a.id));
      break;
    case 'itemFrames':
      // Shown at once; an item that is still loading gets its frame when it is added.
      for (const [id, f] of m.frames) runtime.setItemFrame(id, f);
      break;
    case 'tints':
      then(() => {
        runtime.setModelTints(m.model);
        // Items that arrive later get theirs when they are added.
        const tinted = new Map(m.items);
        for (const id of itemIds) if (!tinted.has(id)) runtime.setItemTint(id, undefined);
        for (const [id, rgba] of tinted) runtime.setItemTint(id, rgba);
      });
      break;
  }
}
transport.onMessage(handle);
transport.post({ type: 'hello', viewId, ...(avatarMode ? { avatar: true } : {}) });
addEventListener('pagehide', () => transport.post({ type: 'bye', viewId }));

let last = 0;
let framesDrawn = 0;
/**
 * An error never stops the view: it goes to the control
 * window's log (scrubbed there), at most one a second, the same one once a
 * minute.
 */
let reportedAt = 0;
const reported = new Map<string, number>();
function report(where: string, e: unknown): void {
  const text = `${where}: ${errorText(e)}`;
  const now = Date.now();
  if (now - reportedAt < 1000 || now - (reported.get(text) ?? -Infinity) < 60_000) return;
  reportedAt = now;
  reported.set(text, now);
  if (reported.size > 100) reported.clear();
  transport.post({ type: 'viewLog', viewId, text });
}
addEventListener('error', (e) => report('Output view', e.error ?? e.message));
addEventListener('unhandledrejection', (e) => report('Output view', e.reason));

function tick(now: number): void {
  if (!avatarMode) requestAnimationFrame(tick);
  if (!avatarMode && !limiter.shouldRender(now)) return;
  if (modelReady) guard(report, 'Output view, parameters', () => runtime.setParameters(params));
  guard(report, 'Output view, drawing', () =>
    runtime.render(last ? Math.min(100, now - last) : 16),
  );
  last = now;
  framesDrawn++;
}
if (!avatarMode) requestAnimationFrame(tick);

// For tests and debugging; `step` draws a frame (the avatar mode's control window calls it).
(window as unknown as { mochiOutput: unknown }).mochiOutput = {
  runtime,
  params,
  loadStats,
  step: (now: number) => tick(now),
  get modelReady() {
    return modelReady;
  },
  get framesDrawn() {
    return framesDrawn;
  },
  get paramsReceived() {
    return paramsReceived;
  },
  get collabFrames() {
    return collabFrames;
  },
};
