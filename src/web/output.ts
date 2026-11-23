import { backgroundCss } from '../core/background';
import { FrameLimiter } from '../core/frameCap';
import { MemoryFileSet, RootedFileSet, openModel, type ModelFileSet } from '../core/modelFiles';
import { SYNC_CHANNEL, channelTransport, itemFilesOwner, type SyncMessage } from '../core/sync';
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
/**
 * The stage's cap, and the desktop app's for a page it draws out of sight (Spout2, the virtual
 * camera): lowered while the app's window answers slowly (src/core/frameGovernor.ts). The page
 * draws at no more than the lower of the two.
 */
let stageCap = 60;
let hostCap = 0;
const applyCap = (): void => {
  limiter.fps = hostCap > 0 && (stageCap <= 0 || hostCap < stageCap) ? hostCap : stageCap;
};
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
/** The items this view shows, and the version of their files. */
const itemIds = new Map<string, number>();

/**
 * The items the control window lists, in its order, each with what this
 * view loads it from: the files a message carried (kept, as the window
 * sends an item's files once), or none yet.
 */
interface WantedItem {
  id: string;
  label: string;
  visible: boolean;
  version: number;
  files?: () => ModelFileSet;
}
let wanted: WantedItem[] = [];
/**
 * A view that misses a file once (a slow bridge, a busy computer) tries
 * again: after these pauses, then gives up until it is opened again, and
 * says so in the control window's log. `?retry=<ms>` sets every pause (for
 * tests).
 */
const RETRY_PAUSES_MS = query.get('retry')
  ? Array<number>(4).fill(Number(query.get('retry')))
  : [2000, 5000, 15_000, 30_000];
const TRIES = RETRY_PAUSES_MS.length + 1;
/** Failed loads of an item's files (of this version), by id, and when it may try next. */
const itemTries = new Map<string, { version: number; n: number; at: number }>();
let itemRetry: ReturnType<typeof setTimeout> | undefined;
/** The latest item layout, applied again to an item that loads on a later try. */
let lastLayout: Extract<SyncMessage, { type: 'itemLayout' }>['layout'] | undefined;
/** Says in the control window's log that this view is behind (not limited like errors). */
const behind = (text: string, kind: 'info' | 'error' = 'error'): void =>
  transport.post({ type: 'viewLog', viewId, text, kind });
const seconds = (ms: number): string => `${Math.round(ms / 100) / 10} s`;

/**
 * Takes the window's list: an entry without files (the window sent them
 * before) keeps those this view got for that version.
 */
function setWanted(next: WantedItem[]): void {
  const known = new Map(wanted.map((i) => [i.id, i]));
  wanted = next.map((i) => {
    const k = known.get(i.id);
    return i.files || !k || k.version !== i.version ? i : { ...i, files: k.files };
  });
}

/**
 * Brings this view's items to the window's list: removes those it no
 * longer lists, loads those it lacks or has other files of. A load that
 * fails is tried again later; the others go on. Items wait for the model.
 */
async function syncItems(): Promise<void> {
  if (!modelReady) return;
  const ids = new Set(wanted.map((i) => i.id));
  for (const id of itemIds.keys())
    if (!ids.has(id)) {
      runtime.removeItem(id);
      itemIds.delete(id);
    }
  for (const id of itemTries.keys()) if (!ids.has(id)) itemTries.delete(id);
  let retryIn: number | undefined;
  const failed: string[] = [];
  const gaveUp: string[] = [];
  const recovered: string[] = [];
  let askAgain = false;
  /** The shortest pause of the items that failed now. */
  let nextPause = Infinity;
  for (const i of wanted) {
    // An item this view has, with these files: nothing to load. New files replace its
    // old ones, which stay drawn until the new ones have loaded.
    if (itemIds.get(i.id) === i.version || (avatarMode && isCollab(i.id))) continue;
    const t = itemTries.get(i.id);
    const n = t?.version === i.version ? t.n : 0;
    if (n >= TRIES) continue;
    // Not before its pause is over (another message from the window comes sooner).
    if (n && t!.at > performance.now()) {
      retryIn = Math.min(retryIn ?? Infinity, t!.at - performance.now());
      continue;
    }
    try {
      // No files for it here (a message without them came first): ask the window for all.
      if (!i.files) throw new Error('its files did not come');
      await runtime.addItem(i.id, i.files(), { visible: i.visible });
      itemIds.set(i.id, i.version);
      if (n) {
        itemTries.delete(i.id);
        recovered.push(`“${i.label}” (try ${n + 1})`);
      }
    } catch (e) {
      console.error(e);
      const pause = RETRY_PAUSES_MS[n] ?? 0;
      itemTries.set(i.id, { version: i.version, n: n + 1, at: performance.now() + pause });
      if (n + 1 >= TRIES) {
        gaveUp.push(`“${i.label}” (${errorText(e)})`);
        continue;
      }
      failed.push(`“${i.label}” (${errorText(e)})`);
      if (!i.files) askAgain = true;
      nextPause = Math.min(nextPause, pause);
      retryIn = Math.min(retryIn ?? pause, pause);
    }
  }
  // One line for the window's log (the bridge passes one a second).
  const said = [
    failed.length && `could not load ${failed.join(', ')}; it tries again in ${seconds(nextPause)}`,
    gaveUp.length &&
      `gave up loading ${gaveUp.join(', ')} after ${TRIES} tries, and shows the stage without ` +
        `${gaveUp.length > 1 ? 'them' : 'it'}: open the view again (in OBS, refresh the browser source)`,
    recovered.length && `has loaded ${recovered.join(', ')} now`,
  ].filter(Boolean);
  if (said.length)
    behind(`An output view ${said.join('; ')}.`, failed.length || gaveUp.length ? 'error' : 'info');
  if (askAgain) transport.post({ type: 'hello', viewId, ...(avatarMode ? { avatar: true } : {}) });
  // Placed as the window has it, also when it loaded after the window's layout came.
  if (recovered.length && lastLayout) runtime.applyItemLayout(lastLayout);
  document.body.dataset.items = String(itemIds.size);
  if (retryIn !== undefined) {
    clearTimeout(itemRetry);
    itemRetry = setTimeout(() => then(syncItems), retryIn);
  }
}
const params: Record<string, number> = {};
/** Parameter messages from the control window (for tests: they keep their rate while it is hidden). */
let paramsReceived = 0;
/** Collaborator frames from the control window (for tests and debugging). */
let collabFrames = 0;
const clearParams = (): void => {
  for (const k of Object.keys(params)) delete params[k];
};

/** Failed loads of the model with this key. */
let modelTries = { key: '', n: 0 };
let modelRetry: ReturnType<typeof setTimeout> | undefined;

/**
 * Another model. Its parameters come right after it, so the old ones go
 * now; its items come after it, so the list and the tries go when its load
 * starts (after what was queued for the old one).
 */
function newModel(m: Extract<SyncMessage, { type: 'model' | 'modelRemote' }>): void {
  loadedKey = m.key;
  modelReady = false;
  clearParams();
  then(() => {
    wanted = [];
    itemTries.clear();
    clearTimeout(itemRetry);
    clearTimeout(modelRetry);
    modelTries = { key: m.key, n: 0 };
    return loadModel(m);
  });
}

/**
 * Loads the model (its files from the message, or from the bridge), then
 * the items the window listed meanwhile. A load that fails is tried again
 * later, as an item's is.
 */
async function loadModel(
  m: Extract<SyncMessage, { type: 'model' | 'modelRemote' }>,
): Promise<void> {
  for (const id of itemIds.keys()) runtime.removeItem(id);
  itemIds.clear();
  const t0 = performance.now();
  const total = m.type === 'modelRemote' ? (m.sizes?.reduce((a, b) => a + b, 0) ?? 0) : 0;
  if (m.type === 'modelRemote') status('loading', 0, total, 0);
  try {
    if (m.type === 'model') {
      await runtime.load(await openModel(new MemoryFileSet(m.label, m.files)));
    } else {
      const remote = remoteFiles('model', m.key, m.label, m.paths, m.sizes, { t0 });
      await runtime.load(await openModel(remote.files));
      await remote.done.catch(() => undefined);
      loadStats.bytes = total;
      loadStats.fetchMs = Math.round(remote.fetchMs());
      loadStats.loadMs = Math.round(performance.now() - t0);
    }
  } catch (e) {
    status('failed', 0, total, performance.now() - t0, (e as Error).message);
    const n = ++modelTries.n;
    const why = errorText(e);
    if (n >= TRIES) {
      behind(
        `An output view could not load the model (${why}) after ${TRIES} tries. Open the view ` +
          `again (in OBS: refresh the browser source).`,
      );
    } else {
      const pause = RETRY_PAUSES_MS[n - 1]!;
      behind(
        `An output view could not load the model (${why}). It tries again in ${seconds(pause)} ` +
          `(try ${n + 1} of ${TRIES}).`,
      );
      clearTimeout(modelRetry);
      modelRetry = setTimeout(() => {
        if (loadedKey === m.key && !modelReady) then(() => loadModel(m));
      }, pause);
    }
    throw e;
  }
  if (modelTries.n)
    behind(`An output view has loaded the model now (try ${modelTries.n + 1}).`, 'info');
  modelTries.n = 0;
  modelReady = true;
  document.body.dataset.model = m.key;
  status('ready', total, total, m.type === 'modelRemote' ? performance.now() - t0 : 0);
  await syncItems();
}

/** Runs after the model (and items) queued so far are loaded; logs failures. */
function then(fn: () => void | Promise<void>): void {
  loading = loading.then(fn).catch((e) => console.error(e));
}

function handle(m: SyncMessage): void {
  switch (m.type) {
    case 'modelAvailable':
      // A control window that doesn't know this view yet: ask for everything, or (with this
      // model already) say it is here.
      if (m.key === loadedKey) status('ready', 0, 0, 0);
      else transport.post({ type: 'hello', viewId, ...(avatarMode ? { avatar: true } : {}) });
      break;
    case 'model':
      // Says it is here, also to a control window that (re)loaded after it said hello: items
      // go only to views the control window knows of.
      if (m.key === loadedKey) return status('ready', 0, 0, 0);
      newModel(m);
      break;
    case 'modelRemote':
      if (!bridge || m.key === loadedKey) return;
      newModel(m);
      break;
    case 'itemsRemote':
      if (!bridge) return;
      then(() => {
        setWanted(
          m.items.map((i) => ({
            id: i.id,
            label: i.label,
            visible: i.visible,
            version: i.version ?? 0,
            ...(i.paths.length
              ? {
                  files: () =>
                    remoteFiles('item', itemFilesOwner(i.id, i.version), i.label, i.paths, i.sizes)
                      .files,
                }
              : {}),
          })),
        );
        return syncItems();
      });
      break;
    case 'unload':
      loadedKey = undefined;
      modelReady = false;
      wanted = [];
      itemTries.clear();
      clearTimeout(itemRetry);
      clearTimeout(modelRetry);
      then(() => {
        for (const id of itemIds.keys()) runtime.removeItem(id);
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
        stageCap = m.fpsCap;
        applyCap();
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
      then(() => {
        setWanted(
          m.items.map((i) => ({
            id: i.id,
            label: i.label,
            visible: i.visible,
            version: i.version ?? 0,
            ...(i.files.length ? { files: () => new MemoryFileSet(i.label, i.files) } : {}),
          })),
        );
        return syncItems();
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
      lastLayout = m.layout;
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
        for (const id of itemIds.keys()) if (!tinted.has(id)) runtime.setItemTint(id, undefined);
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
  /** The desktop app's cap for this page (0: none). */
  setHostCap: (fps: number) => {
    hostCap = Number.isFinite(fps) && fps > 0 ? fps : 0;
    applyCap();
  },
  get fpsCap() {
    return limiter.fps;
  },
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
