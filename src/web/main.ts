import './style.css';
import { CHROMA_PRESETS, type Background } from '../core/background';
import { comboLabel } from '../core/hotkeys';
import type { ItemDepth } from '../core/plugins/itemSort';
import {
  GATE_MAX_DB,
  GATE_MIN_DB,
  LIP_SYNC_MODES,
  meterFraction,
  type LipSyncMode,
} from '../core/lipSync';
import { fileSetFromFiles, fileSetFromUrl, MemoryFileSet } from '../core/modelFiles';
import { frameFolderItem, framePaths } from './animatedItems';
import { dragTransform, normalizeRotation, zoomAround, type SceneTransform } from '../core/scene';
import { SettingsError } from '../core/settings';
import { SYNC_CHANNEL, channelTransport, combineTransports } from '../core/sync';
import { downloadText, h, numberInput, readFileBytes, readFileText, select } from './dom';
import {
  framesOf,
  fromDrop,
  fromFolderInput,
  fromZipFile,
  listDrop,
  listFolderInput,
} from './fileInput';
import type { FrameSource } from './animatedItems';
import { hotkeyEditor, installKeyHandler } from './hotkeyEditor';
import { IdbItemFileStore, IdbSettingsStore } from './idbStore';
import { mappingEditor } from './mappingEditor';
import { MochiRuntime, WEBGL_TIPS } from './mochiRuntime';
import { AgentLink, BridgeViewTransport, DEFAULT_BRIDGE_URL, desktopMode } from './agentLink';
import { desktopApi, desktopSourcePath, openDesktopZip, openDiskFolder } from './desktopFiles';
import { rememberDisplayName } from './displayNames';
import { GlobalHotkeysUi, RecentModelsUi } from './desktopFeatures';
import { PluginHost } from './pluginHost';
import { pluginsUi } from './pluginsUi';
import { phonePanel } from './phoneUi';
import { Guide } from './guide';
import { cameraErrorMessage, mediaContext, microphoneErrorMessage } from '../core/mediaErrors';
import { Studio } from './studio';
import { HANDOVER_MAX_MS } from '../core/idleHandover';
import { addImageItem, installStageItems, isImageFile } from './stageItems';
import { physicsSection, updatePhysicsOverrideNote } from './physicsPanel';
import { expressionEditor } from './expressionEditorUi';
import { itemScenesPanel } from './itemScenesUi';
import { voicePanel } from './voiceUi';
import { handsPanel } from './handsUi';
import { otherInputsPanel } from './otherInputsUi';
import { lightOverlayPanel } from './lightOverlayUi';
import { lightStrengthSection } from './lightStrengthUi';
import { WEB_ITEM_DEFAULTS, WEB_ITEM_MAX_FPS } from '../core/webItems';
import { AppLog, bugReport, errorText } from '../core/appLog';
import { APP_VERSION } from '../core/plugins/protocol';
import { spoutSection } from './spoutUi';
import { virtualCameraSection } from './virtualCameraUi';
import { CollabStage } from './collab/collabStage';
import { collabSection } from './collabUi';

/** When this script started (startup timing). */
const scriptStart = Math.round(performance.now());
const params = new URLSearchParams(location.search);
const devMode = params.has('dev');

const runtime = new MochiRuntime();
// Output views: in this browser profile over a BroadcastChannel, and (for
// OBS) through the bridge.
const bridgeViews = new BridgeViewTransport();
const studio = new Studio(
  runtime,
  new IdbSettingsStore(),
  combineTransports(channelTransport(new BroadcastChannel(SYNC_CHANNEL)), bridgeViews),
  new IdbItemFileStore(),
);
(window as unknown as { mochiStudio: Studio }).mochiStudio = studio;

// ---------------------------------------------------------------------------
// Layout

const canvas = h('canvas', { id: 'stage', 'aria-label': 'Avatar preview' });
const stageWrap = h('div', { class: 'stage-wrap', 'data-bg': 'transparent' }, canvas);
const buttonsBar = h('div', { class: 'hotkey-buttons', 'aria-label': 'Hotkey buttons' });
const toast = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite' });
const camChip = h('span', { class: 'chip', id: 'cam-indicator' });
const micChip = h('span', { class: 'chip', id: 'mic-indicator' });
const viewsChip = h('span', { class: 'chip', id: 'views-indicator' });
const agentChip = h('span', { class: 'chip', id: 'agent-indicator', hidden: true });
const undoBtn = h(
  'button',
  {
    class: 'icon',
    id: 'undo',
    title: 'Undo (Ctrl+Z)',
    'aria-label': 'Undo',
    disabled: true,
    onclick: () => void studio.run('undo').catch(() => undefined),
  },
  '↶',
);
const redoBtn = h(
  'button',
  {
    class: 'icon',
    id: 'redo',
    title: 'Redo (Ctrl+Shift+Z)',
    'aria-label': 'Redo',
    disabled: true,
    onclick: () => void studio.run('redo').catch(() => undefined),
  },
  '↷',
);
const faceChip = h('span', { class: 'chip', id: 'face-indicator' });

/**
 * The sections of the interface. Each one sits in a tab of the settings
 * screen, except Items, which opens over the stage from the main menu.
 */
const tabs = [
  'Model',
  'Tracking',
  'Mapping',
  'Audio',
  'Items',
  'Hotkeys',
  'Output',
  'Agents',
  'Collab',
] as const;
type Tab = (typeof tabs)[number];
const panels = Object.fromEntries(
  tabs.map((t) => [t, h('section', { class: 'panel', id: `panel-${t.toLowerCase()}` })]),
) as Record<Tab, HTMLElement>;

/** The settings screen's tabs, in the familiar order. */
const SETTINGS = [
  {
    id: 'general',
    label: 'General',
    title: 'General settings & connections',
    sections: ['Audio', 'Agents'],
  },
  {
    id: 'camera',
    label: 'Camera',
    title: 'Camera, tracking & output',
    sections: ['Tracking', 'Output'],
  },
  { id: 'model', label: 'Model', title: 'Model settings', sections: ['Model', 'Mapping'] },
  { id: 'hotkeys', label: 'Hotkeys', title: 'Hotkeys & expressions', sections: ['Hotkeys'] },
  { id: 'collab', label: 'Collab', title: 'Collaboration', sections: ['Collab'] },
] as const satisfies ReadonlyArray<{
  id: string;
  label: string;
  title: string;
  sections: readonly Tab[];
}>;
type SettingsTab = (typeof SETTINGS)[number]['id'];

const sheetHead = (title: string, id: string): HTMLElement =>
  h(
    'div',
    { class: 'sheet-head' },
    h('h1', {}, title),
    h(
      'button',
      {
        class: 'icon',
        id: `${id}-close`,
        'aria-label': `Close ${title.toLowerCase()}`,
        title: 'Close (Esc)',
        onclick: () => closeOverlays(),
      },
      '×',
    ),
  );
const settingsTabButtons = SETTINGS.map((t) =>
  h(
    'button',
    {
      role: 'tab',
      class: 'tab',
      id: `tab-${t.id}`,
      'data-tab': t.id,
      title: t.title,
      onclick: () => openSettings(t.id),
    },
    t.label,
  ),
);
const settingsSheet = h(
  'section',
  { class: 'sheet', id: 'settings', role: 'dialog', 'aria-label': 'Settings', hidden: true },
  sheetHead('Settings', 'settings'),
  h('nav', { class: 'tabs', role: 'tablist' }, settingsTabButtons),
  h(
    'div',
    { class: 'sheet-body', role: 'tabpanel' },
    ...SETTINGS.flatMap((t) => t.sections.map((x) => panels[x])),
  ),
);
const itemsSheet = h(
  'section',
  { class: 'sheet', id: 'items-sheet', role: 'dialog', 'aria-label': 'Items', hidden: true },
  sheetHead('Items', 'items'),
  h('div', { class: 'sheet-body' }, panels.Items),
);

/**
 * Recent messages (toasts, errors, load reports), newest last: users look
 * here first. Scrubbed of personal data, repeats folded (src/core/appLog.ts).
 */
const appLog = new AppLog();
const logList = h('ol', { class: 'log-list', id: 'log-list' });
function log(text: string, kind: 'info' | 'error' = 'info'): boolean {
  const isNew = appLog.add(text, kind);
  if (!logSheet.hidden) renderLog();
  return isNew;
}
function renderLog(): void {
  const entries = appLog.entries;
  logList.replaceChildren(
    ...(entries.length
      ? entries
          .slice()
          .reverse()
          .map((e) =>
            h(
              'li',
              { 'data-kind': e.kind },
              h('time', {}, new Date(e.time).toLocaleTimeString()),
              ' ',
              e.text,
              ...(e.count > 1 ? [h('span', { class: 'log-count' }, ` (×${e.count})`)] : []),
            ),
          )
      : [h('li', { class: 'hint' }, 'Nothing yet.')]),
  );
}
/** The log as a text file for a bug report: the app, a few counts, and the messages. */
function saveBugReport(): void {
  const text = bugReport(appLog, {
    version: APP_VERSION,
    userAgent: navigator.userAgent,
    desktop: !!desktopApi(),
    facts: {
      model: studio.model ? 'loaded' : 'none',
      items: studio.items.length,
      outputViews: studio.outputViewCount,
      camera: studio.trackingOn,
      framesDrawn: studio.framesDrawn,
    },
  });
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const a = h('a', {
    href: url,
    download: `mochi-studio-log-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.txt`,
  });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
const logSheet = h(
  'section',
  { class: 'sheet sheet-small', id: 'log', role: 'dialog', 'aria-label': 'Log', hidden: true },
  sheetHead('Log', 'log'),
  h(
    'div',
    { class: 'sheet-body' },
    h(
      'p',
      { class: 'hint' },
      'Recent messages, newest first. When a model will not load, the reason is here. Names, addresses and file paths are left out, and no camera picture is ever logged.',
    ),
    h(
      'div',
      { class: 'row' },
      h(
        'button',
        {
          onclick: () =>
            void navigator.clipboard
              ?.writeText(appLog.lines().join('\n'))
              .then(() => notify('Copied.')),
        },
        'Copy',
      ),
      h('button', { id: 'log-save', onclick: saveBugReport }, 'Save for a bug report…'),
      h(
        'button',
        {
          onclick: () => {
            appLog.clear();
            renderLog();
          },
        },
        'Clear',
      ),
    ),
    logList,
  ),
);

/** The model selection bar: recent models, and opening another. */
const modelBarList = h('div', { class: 'model-bar-list', id: 'model-bar-list' });
const modelBar = h(
  'section',
  { class: 'model-bar', id: 'model-bar', 'aria-label': 'Change model', hidden: true },
  h('strong', {}, 'Change model'),
  modelBarList,
  h(
    'div',
    { class: 'row' },
    h(
      'button',
      { class: 'primary', onclick: () => (closeOverlays(), openFolder()) },
      'Open folder…',
    ),
    h('button', { onclick: () => (closeOverlays(), openZip()) }, 'Open zip…'),
    h(
      'button',
      {
        class: 'icon',
        'aria-label': 'Close',
        title: 'Close (Esc)',
        onclick: () => closeOverlays(),
      },
      '×',
    ),
  ),
);

/** Lock model position: the stage cannot drag, zoom or turn the model (tracking goes on). */
let modelLocked = false;
const lockModelBtn = h(
  'button',
  {
    id: 'menu-lock-model',
    'aria-pressed': 'false',
    onclick: () => {
      modelLocked = !modelLocked;
      lockModelBtn.setAttribute('aria-pressed', String(modelLocked));
      notify(modelLocked ? 'Model position locked.' : 'Model position unlocked.');
      closeOverlays();
    },
  },
  'Lock model position',
);
const lockItemsBtn = h(
  'button',
  {
    id: 'menu-lock-items',
    'aria-pressed': 'false',
    onclick: () => {
      itemsLocked = !itemsLocked;
      lockItemsBtn.setAttribute('aria-pressed', String(itemsLocked));
      notify(itemsLocked ? 'All items locked.' : 'Items unlocked.');
      closeOverlays();
    },
  },
  'Lock items',
);
/** All items locked from the main menu (each item can also be locked on its own). */
let itemsLocked = false;
const menuEntry = (id: string, label: string, fn: () => void): HTMLElement =>
  h('button', { id: `menu-${id}`, role: 'menuitem', onclick: fn }, label);
const mainMenu = h(
  'nav',
  { class: 'main-menu', id: 'main-menu', role: 'menu', 'aria-label': 'Main menu', hidden: true },
  menuEntry('model', 'Change model', () => openModelBar()),
  menuEntry('screenshot', 'Screenshot', () => {
    closeOverlays();
    void takeScreenshot();
  }),
  menuEntry('background', 'Background', () => showTab('Output', 'background')),
  menuEntry('items', 'Items', () => showTab('Items')),
  // Item scenes: the Items sheet, at its scenes.
  menuEntry('scenes', 'Item scenes', () => {
    showTab('Items');
    scenes.el.scrollIntoView({ block: 'start' });
  }),
  lockModelBtn,
  lockItemsBtn,
  menuEntry('settings', 'Settings', () => openSettings(lastSettingsTab())),
  menuEntry('log', 'Log', () => openLog()),
);
const menuButton = h(
  'button',
  {
    class: 'menu-button',
    id: 'menu-button',
    'aria-label': 'Menu',
    'aria-expanded': 'false',
    'aria-controls': 'main-menu',
    title: 'Menu (or double-click the stage)',
    onclick: () => (mainMenu.hidden ? openMenu() : closeOverlays()),
  },
  '☰',
);

const overlays = [mainMenu, modelBar, settingsSheet, itemsSheet, logSheet];
function closeOverlays(): void {
  for (const o of overlays) o.hidden = true;
  menuButton.setAttribute('aria-expanded', 'false');
  document.getElementById('hud-guide')?.classList.remove('under-menu');
}
function openMenu(): void {
  closeOverlays();
  mainMenu.hidden = false;
  // The guide card shares the corner with the menu: it steps aside while the menu is open.
  document.getElementById('hud-guide')?.classList.add('under-menu');
  menuButton.setAttribute('aria-expanded', 'true');
  (mainMenu.querySelector('button') as HTMLButtonElement | null)?.focus();
}
function openModelBar(): void {
  closeOverlays();
  renderModelBar();
  modelBar.hidden = false;
}
function openLog(): void {
  closeOverlays();
  renderLog();
  logSheet.hidden = false;
}
function lastSettingsTab(): SettingsTab {
  try {
    const t = localStorage.getItem('mochi-studio.settingsTab');
    if (SETTINGS.some((x) => x.id === t)) return t as SettingsTab;
  } catch {
    /* storage unavailable */
  }
  return 'general';
}
function openSettings(tab: SettingsTab, section?: Tab, anchor?: string): void {
  closeOverlays();
  settingsSheet.hidden = false;
  const group = SETTINGS.find((x) => x.id === tab)!;
  for (const b of settingsTabButtons)
    b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  for (const t of SETTINGS) for (const x of t.sections) panels[x].hidden = t.id !== tab;
  try {
    localStorage.setItem('mochi-studio.settingsTab', tab);
  } catch {
    /* storage unavailable */
  }
  const target =
    (anchor && document.getElementById(anchor)) || (section ? panels[section] : undefined);
  if (target && group) target.scrollIntoView({ block: 'start' });
}
/** The current model, and the recent ones where Mochi Studio keeps them (the desktop app). */
function renderModelBar(): void {
  const m = studio.model;
  modelBarList.replaceChildren(
    m
      ? h(
          'p',
          { class: 'hint' },
          'Now: ',
          h('strong', {}, studio.settings?.displayName ?? safeDecode(m.files.label)),
        )
      : h('p', { class: 'hint' }, 'No model loaded.'),
    recentUi
      ? recentUi.bar
      : h(
          'p',
          { class: 'hint' },
          'The desktop app keeps your recent models here. In the browser, open a folder or a zip.',
        ),
  );
  void recentUi?.refresh();
}
/** Saves a PNG of the stage (the avatar and its background, without the controls). */
async function takeScreenshot(): Promise<void> {
  try {
    const png = await studio.screenshot();
    const a = h('a', {
      href: URL.createObjectURL(new Blob([png as Uint8Array<ArrayBuffer>], { type: 'image/png' })),
      download: `mochi-studio-${new Date().toISOString().replace(/[:.]/g, '-')}.png`,
    });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    notify('Screenshot saved.');
  } catch (e) {
    fail(e);
  }
}
/** Opens the place a section lives: its settings tab, or the items overlay. */
function showTab(t: Tab, anchor?: string): void {
  if (t === 'Items') {
    closeOverlays();
    itemsSheet.hidden = false;
    return;
  }
  const g = SETTINGS.find((x) => (x.sections as readonly Tab[]).includes(t))!;
  openSettings(g.id, t, anchor);
}
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && overlays.some((o) => !o.hidden)) {
    e.preventDefault();
    closeOverlays();
  }
});

// The first-run guide (its actions are defined further down, and run later).
const guide = new Guide({
  openFolder: () => openFolder(),
  openZip: () => openZip(),
  trySample: () => trySample(),
  startCamera: () => startCamera(),
  calibrate: () => calibrateNow(),
  setUpOutput: () => setUpOutput(),
});
/** The stage before a model is loaded: what to do, with the same buttons. */
const stageEmpty = h(
  'div',
  { class: 'stage-empty', id: 'stage-empty' },
  h('strong', {}, 'No model loaded yet'),
  h(
    'p',
    {},
    'Open a model folder (the one with the .model3.json file, for models made with Live2D Cubism) or a zip of it, or drop it here.',
  ),
  h(
    'div',
    { class: 'row' },
    h('button', { class: 'primary', onclick: () => openFolder() }, 'Open folder…'),
    h('button', { onclick: () => openZip() }, 'Open zip…'),
  ),
  h(
    'p',
    {},
    'No model yet? ',
    h(
      'button',
      { class: 'link', id: 'try-sample', onclick: () => trySample() },
      'Try the sample model',
    ),
    ' «Mochi», which comes with Mochi Studio.',
  ),
  h('p', { class: 'hint' }, 'Double-click the stage, or use ☰, for the main menu.'),
);
stageWrap.append(stageEmpty);
/** The item trash target: shown only while an item is dragged. */
const trash = h(
  'div',
  { class: 'item-trash', id: 'item-trash', hidden: true, 'aria-hidden': 'true' },
  'Drop here to remove',
);

document.body.append(
  stageWrap,
  h(
    'div',
    { class: 'hud hud-left' },
    menuButton,
    h(
      'span',
      { class: 'brand' },
      h('span', { class: 'logo', 'aria-hidden': 'true' }),
      'Mochi Studio',
    ),
  ),
  h(
    'div',
    { class: 'hud hud-right status', id: 'status' },
    guide.toggle,
    undoBtn,
    redoBtn,
    agentChip,
    faceChip,
    camChip,
    micChip,
    viewsChip,
  ),
  h('div', { class: 'hud hud-guide', id: 'hud-guide' }, guide.element),
  buttonsBar,
  trash,
  mainMenu,
  modelBar,
  settingsSheet,
  itemsSheet,
  logSheet,
  toast,
);

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function notify(msg: string, kind: 'info' | 'error' = 'info'): void {
  log(msg, kind);
  toastOnly(msg, kind);
}
/** A toast that is not logged (when the log already has a fuller entry). */
function toastOnly(msg: string, kind: 'info' | 'error' = 'info'): void {
  toast.textContent = msg;
  toast.dataset.kind = kind;
  toast.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), kind === 'error' ? 6000 : 2500);
}
const fail = (e: unknown): void => notify(e instanceof Error ? e.message : String(e), 'error');

// ---------------------------------------------------------------------------
// Model panel

const folderInput = h('input', {
  id: 'model-folder',
  type: 'file',
  webkitdirectory: true,
  multiple: true,
  hidden: true,
});
const zipInput = h('input', {
  type: 'file',
  id: 'model-zip',
  accept: '.zip,application/zip',
  hidden: true,
});
const urlInput = h('input', {
  type: 'url',
  placeholder: 'https://…/model.model3.json or .zip',
  'aria-label': 'Model URL',
});
const modelInfo = h('div', { class: 'model-info' });
const importBox = h('div', { class: 'import', id: 'vts-import' });
const includeItems = h('input', {
  type: 'checkbox',
  id: 'export-items',
  onchange: () => {
    const note = document.getElementById('item-terms-note');
    if (note) note.hidden = !includeItems.checked;
  },
});
const quick = h('div', { class: 'quick' });

async function load(
  p: Promise<import('../core/modelFiles').ModelFileSet | undefined>,
): Promise<void> {
  let name = 'the model';
  try {
    const files = await p;
    if (!files) return;
    name = safeDecode(files.label);
    notify(`Loading ${name}…`);
    await studio.loadModel(files);
    notify(`Loaded ${name}`);
    // Problems with optional files, for the log (users look there first).
    for (const n of studio.info?.notices ?? []) log(`${name}: ${n}`);
    const missing = studio.model?.missing ?? [];
    if (missing.length)
      log(`${name}: files the model lists but its folder lacks: ${missing.join(', ')}`, 'error');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(
      `Could not load ${name}: ${msg}${e instanceof Error && e.cause ? ` (${String(e.cause)})` : ''}`,
      'error',
    );
    toastOnly(`${msg} The log has the details (main menu → Log).`, 'error');
  }
}
/**
 * The sample model «Mochi» (samples/mochi/, from Mochi Maker), which the
 * build puts beside the pages: something to try before having a model.
 */
export const SAMPLE_MODEL = 'samples/mochi/mochi.model3.json';
function trySample(): void {
  void load(
    fileSetFromUrl(new URL(SAMPLE_MODEL, document.baseURI).href).then((f) => ({
      ...f,
      label: 'Mochi (sample)',
    })),
  );
}
/**
 * In the desktop app, folders open through the native dialog, so the bridge
 * can serve their files to output views straight from disk.
 */
function openFolder(): void {
  const disk = desktopApi() && link.diskAccess;
  if (disk) void load(openDiskFolder(disk.http, disk.token));
  else folderInput.click();
}
/** In the desktop app, zips open through the native dialog too, so they can be remembered. */
function openZip(): void {
  if (desktopApi()) void load(openDesktopZip());
  else zipInput.click();
}
folderInput.addEventListener(
  'change',
  () => folderInput.files?.length && void load(fromFolderInput(folderInput.files)),
);
zipInput.addEventListener(
  'change',
  () => zipInput.files?.[0] && void load(fromZipFile(zipInput.files[0])),
);
stageWrap.addEventListener('dragover', (e) => {
  e.preventDefault();
  stageWrap.classList.add('drop');
});
stageWrap.addEventListener('dragleave', () => stageWrap.classList.remove('drop'));
stageWrap.addEventListener('drop', (e) => {
  e.preventDefault();
  stageWrap.classList.remove('drop');
  const dt = e.dataTransfer;
  if (!dt) return;
  // Image files become items (in the middle of the stage, ready to be pinned).
  const files = [...dt.files];
  if (files.length && files.every(isImageFile)) {
    if (!studio.model)
      return notify('Load a model first, then drop images on it as items.', 'error');
    for (const f of files)
      void addImageItem(studio, f)
        .then(() => notify(`Added “${f.name}” as an item: drag it onto the model to pin it.`))
        .catch(fail);
    return;
  }
  // A folder of PNG frames (no model in it) becomes an animated item of the loaded model.
  const single = dt.files.length === 1 ? dt.files[0] : undefined;
  if (single && /\.zip$/i.test(single.name)) return void load(fromDrop(dt));
  void listDrop(dt).then((l) => {
    const frames = l && studio.model ? framesOf(l) : undefined;
    if (frames) return addFrameItem(frames);
    return load(l ? fileSetFromFiles(l.label, l.files) : Promise.resolve(undefined));
  });
});

// The desktop app: recent model folders, and hotkeys that work in other apps.
const desktopDeps = {
  studio,
  diskAccess: () => link.diskAccess,
  load,
  notify,
};
const recentUi = desktopApi() ? new RecentModelsUi(desktopDeps) : undefined;
const globalHotkeys = desktopApi() ? new GlobalHotkeysUi(desktopDeps) : undefined;
if (recentUi) stageEmpty.append(recentUi.stageList);

panels.Model.append(
  h('h2', {}, 'Load a model'),
  h(
    'p',
    { class: 'hint' },
    'A folder or a zip with a .model3.json, or a URL. You can also drop it on the stage.',
  ),
  h(
    'div',
    { class: 'row' },
    h('button', { class: 'primary', onclick: () => openFolder() }, 'Open folder…'),
    h('button', { onclick: () => openZip() }, 'Open zip…'),
    folderInput,
    zipInput,
  ),
  h(
    'form',
    {
      class: 'row',
      onsubmit: (e: Event) => {
        e.preventDefault();
        const u = urlInput.value.trim();
        if (u)
          void studio
            .run('load_model', { url: new URL(u, location.href).href })
            .then(() => notify(`Loaded ${safeDecode(u)}`))
            .catch(() => undefined);
      },
    },
    urlInput,
    h('button', { type: 'submit' }, 'Load URL'),
  ),
  recentUi?.panel ?? '',
  modelInfo,
  quick,
  importBox,
  h('h2', {}, 'Settings'),
  h(
    'p',
    { class: 'hint' },
    'Settings are saved per model in this browser. Export them to back up or move them.',
  ),
  h('label', { class: 'check' }, includeItems, 'Include item files (exports a zip)'),
  h(
    'p',
    { class: 'hint', id: 'item-terms-note', hidden: true },
    'Items are models too, and can come with their own terms of use. Check them before you share the file.',
  ),
  h(
    'div',
    { class: 'row' },
    h(
      'button',
      {
        onclick: async () => {
          if (!studio.settings) return notify('Load a model first.', 'error');
          try {
            const zip = includeItems.checked && studio.items.length > 0;
            const data = await studio.exportSettingsFile(zip);
            const base = (studio.model?.manifest.file ?? 'model').replace(/\.model3\.json$/i, '');
            downloadText(
              `${base}.mochi-settings.${zip ? 'zip' : 'json'}`,
              data as Uint8Array<ArrayBuffer>,
              zip ? 'application/zip' : 'application/json',
            );
          } catch (e) {
            fail(e);
          }
        },
      },
      'Export…',
    ),
    h(
      'button',
      {
        onclick: async () => {
          if (!studio.settings) return notify('Load a model first.', 'error');
          const data = await readFileBytes('.json,.zip,application/json,application/zip');
          if (data === undefined) return;
          try {
            await studio.importSettingsFile(data);
            notify('Settings imported.');
          } catch (e) {
            fail(e instanceof SettingsError ? e : new Error('Could not import settings.'));
          }
        },
      },
      'Import…',
    ),
  ),
);

// Settings import from a .vtube.json file (milestone 1b).
function renderImport(result?: import('../core/importers/vtubeStudio').ImportResult): void {
  importBox.replaceChildren();
  if (!studio.model) return;
  const fromFile = async (): Promise<void> => {
    const text = await readFileText('.json,application/json');
    if (text !== undefined) renderImport(await studio.previewVtubeImport(text).catch(failed));
  };
  const failed = (e: unknown): undefined => void fail(e);
  importBox.append(
    h('h3', {}, 'Import settings from another app'),
    h(
      'p',
      { class: 'hint' },
      'Converts a VTube Studio model settings file (.vtube.json): mappings, hotkeys and the idle motion. You see what will change before applying it.',
    ),
    h(
      'div',
      { class: 'row' },
      studio.vtubeSettingsFiles.length
        ? h(
            'button',
            {
              onclick: async () => renderImport(await studio.previewVtubeImport().catch(failed)),
            },
            `Import ${studio.vtubeSettingsFiles[0]!.split('/').pop()}`,
          )
        : '',
      h('button', { onclick: () => void fromFile() }, 'Choose a .vtube.json file…'),
    ),
  );
  if (!result) return;
  const r = result.report;
  const list = (title: string, lines: string[], open = false) =>
    lines.length
      ? h(
          'details',
          open ? { open: true } : {},
          h('summary', {}, `${title} (${lines.length})`),
          h(
            'ul',
            {},
            lines.map((l) => h('li', {}, l)),
          ),
        )
      : '';
  importBox.append(
    h(
      'div',
      { class: 'report' },
      h(
        'p',
        {},
        `${result.patch.mapping?.length ?? 0} mappings and ${result.patch.hotkeys?.length ?? 0} hotkeys will replace the current ones${r.savedBy ? ` (file saved by version ${r.savedBy})` : ''}.`,
      ),
      list('Imported', r.imported, true),
      list(
        'Skipped',
        r.skipped.map((s) => `${s.what}: ${s.reason}`),
      ),
      list('Assumed', r.assumed),
      list('Unknown fields (ignored)', r.unknownFields),
      h(
        'div',
        { class: 'row' },
        h(
          'button',
          {
            class: 'primary',
            onclick: () => {
              studio.applyImport(result);
              notify('Settings imported.');
              renderImport();
              renderAll();
            },
          },
          'Apply',
        ),
        h('button', { onclick: () => renderImport() }, 'Cancel'),
      ),
    ),
  );
}

function safeDecode(s: string): string {
  try {
    return decodeURI(s);
  } catch {
    return s;
  }
}

function renderModelInfo(): void {
  const m = studio.model;
  modelInfo.replaceChildren();
  quick.replaceChildren();
  if (!m || !studio.info) {
    modelInfo.append(h('p', { class: 'hint' }, 'No model loaded.'));
    return;
  }
  const mf = m.manifest;
  const fileName = safeDecode(m.files.label)
    .split('/')
    .pop()!
    .replace(/\.zip$/i, '');
  modelInfo.append(
    h(
      'label',
      {},
      'Name',
      h('input', {
        id: 'model-display-name',
        value: studio.settings?.displayName ?? '',
        placeholder: fileName,
        maxlength: 64,
        title: 'Shown in the model bar, the recent list and to plugins. Empty: the file name.',
        onchange: (e: Event) => {
          const v = (e.target as HTMLInputElement).value.trim().slice(0, 64);
          studio.updateSettings({ displayName: v || undefined });
          const path = desktopSourcePath(m.files);
          if (path) rememberDisplayName(path, v || undefined);
          renderModelBar();
          void recentUi?.refresh();
        },
      }),
    ),
    h(
      'dl',
      {},
      h('dt', {}, 'Model'),
      h('dd', {}, mf.file),
      h('dt', {}, 'Source'),
      h('dd', {}, safeDecode(m.files.label)),
      h('dt', {}, 'Parameters'),
      h('dd', {}, String(studio.info.parameters.length)),
      h('dt', {}, 'Expressions'),
      h(
        'dd',
        {},
        `${mf.expressions.length}${mf.discovered.expressions ? ' (found in folder)' : ''}`,
      ),
      h('dt', {}, 'Animations'),
      h('dd', {}, `${mf.motions.length}${mf.discovered.motions ? ' (found in folder)' : ''}`),
      h('dt', {}, 'Items'),
      h('dd', {}, String(studio.items.length)),
      h('dt', {}, 'Renderer'),
      h('dd', {}, runtime.name),
    ),
    m.missing.length ? h('p', { class: 'warn' }, `Missing files: ${m.missing.join(', ')}`) : '',
    ...studio.info.notices.map((n) => h('p', { class: 'warn' }, n)),
  );
  if (mf.expressions.length)
    quick.append(
      h('h3', {}, 'Expressions'),
      h(
        'div',
        { class: 'chips' },
        mf.expressions.map((e) =>
          h(
            'button',
            {
              class: `chipbtn${studio.activeExpressions.has(e.name) ? ' on' : ''}`,
              'aria-pressed': String(studio.activeExpressions.has(e.name)),
              onclick: () => {
                void studio
                  .run('set_expression', {
                    expression: e.name,
                    on: !studio.activeExpressions.has(e.name),
                  })
                  .catch(() => undefined);
                renderModelInfo();
              },
            },
            e.name,
          ),
        ),
      ),
    );
  if (mf.motions.length)
    quick.append(
      h('h3', {}, 'Animations'),
      h(
        'div',
        { class: 'chips' },
        mf.motions.map((x) =>
          h(
            'button',
            {
              class: 'chipbtn',
              onclick: () =>
                void studio
                  .run('play_motion', { group: x.group, index: x.index, mode: 'once' })
                  .catch(() => undefined),
            },
            x.group ? `${x.group} / ${x.name}` : x.name,
          ),
        ),
      ),
      h(
        'label',
        {},
        'Idle animation (loops while nothing else plays)',
        select(
          [['', 'None'], ...mf.motions.map((x) => [x.file, x.name] as const)] as const,
          studio.settings?.idleMotion ?? '',
          (v) => studio.updateSettings({ idleMotion: v || undefined }),
          'Idle animation',
        ),
      ),
    );
  if (mf.physics) quick.append(h('h3', {}, 'Physics'), physicsSection(studio));
  quick.append(lightStrengthSection(studio));
}

// ---------------------------------------------------------------------------
// Tracking panel

const camBtn = h('button', { class: 'primary', id: 'camera-toggle' });
const trackStatus = h('p', { class: 'hint', id: 'tracking-status' });
const calibBtn = h('button', { id: 'calibrate' }, 'Calibrate');
const calibStatus = h('span', { class: 'hint' });
const selfView = h('div', { class: 'selfview' });
/** The camera picture shows only when asked for, and only in this window. */
const previewToggle = h('input', {
  type: 'checkbox',
  id: 'camera-preview',
  onchange: () => renderIndicators(),
});
const inputsTable = h('div', { class: 'inputs' });
const trackingSettings = h('div');

/** Starts the camera, with a message that says what to do when it fails. */
function startCamera(): void {
  guide.setError('camera', undefined);
  void studio.startCamera().catch((e) => {
    const msg = cameraErrorMessage(e, mediaContext(!!desktopMode()));
    guide.setError('camera', msg);
    notify(msg, 'error');
  });
}
function calibrateNow(): void {
  if (!studio.trackingOn) return notify('Start the camera (or connect a phone) first.', 'error');
  guide.setError('calibrate', undefined);
  void studio.run('calibrate').catch(() => undefined);
}
camBtn.addEventListener('click', () => {
  if (studio.cameraOn) studio.stopCamera();
  else startCamera();
});
calibBtn.addEventListener('click', calibrateNow);

function renderTrackingSettings(): void {
  trackingSettings.replaceChildren();
  const s = studio.settings;
  if (!s) return;
  trackingSettings.append(
    h(
      'label',
      { class: 'check' },
      h('input', {
        type: 'checkbox',
        checked: s.mirror,
        onchange: (e: Event) =>
          void studio
            .run('set_mapping', {
              rules: s.mapping,
              mirror: (e.target as HTMLInputElement).checked,
            })
            .catch(() => undefined),
      }),
      'Mirror (move like a mirror image)',
    ),
    h('h3', {}, 'Smoothing filter (One Euro)'),
    h(
      'p',
      { class: 'hint' },
      'Lower minimum cutoff: steadier when still, more delay. Higher speed coefficient: less delay on fast moves.',
    ),
    h(
      'div',
      { class: 'grid2' },
      h(
        'label',
        {},
        'Minimum cutoff (Hz)',
        numberInput(
          s.filter.minCutoff,
          (v) => studio.updateSettings({ filter: { ...s.filter, minCutoff: v } }),
          { step: 0.1, min: 0.01 },
        ),
      ),
      h(
        'label',
        {},
        'Speed coefficient',
        numberInput(
          s.filter.beta,
          (v) => studio.updateSettings({ filter: { ...s.filter, beta: v } }),
          { step: 0.005, min: 0 },
        ),
      ),
    ),
    h(
      'label',
      {},
      'Handover to and from the idle animation (ms)',
      numberInput(
        s.handoverMs,
        (v) =>
          studio.updateSettings({
            handoverMs: Math.round(Math.max(0, Math.min(HANDOVER_MAX_MS, v))),
          }),
        { step: 50, min: 0, max: HANDOVER_MAX_MS, label: 'Handover (ms)', id: 'handover-ms' },
      ),
    ),
    h(
      'p',
      { class: 'hint' },
      'When a face is found or lost, the parameters your mapping drives pass between tracking and the idle animation this smoothly (0: at once).',
    ),
    h(
      'p',
      { class: 'hint' },
      Object.keys(s.calibration).length ? 'Calibrated.' : 'Not calibrated.',
      Object.keys(s.calibration).length
        ? h('button', { class: 'link', onclick: () => studio.clearCalibration() }, 'Clear')
        : '',
    ),
  );
}

const recordBtn = h('button', {}, 'Record tracking values');
recordBtn.addEventListener('click', () => {
  if (studio.recordingActive) {
    const rec = studio.stopRecording();
    recordBtn.textContent = 'Record tracking values';
    if (rec) downloadText('tracking-recording.json', JSON.stringify(rec));
  } else {
    studio.startRecording();
    recordBtn.textContent = 'Stop and save recording';
  }
});

const handUi = handsPanel(studio, (m, kind) => notify(m, kind ?? 'info'));
panels.Tracking.append(
  h('h2', {}, 'Camera & tracking'),
  h(
    'p',
    { class: 'hint', id: 'camera-privacy' },
    'Tracking runs on this computer. The camera picture is never sent, saved or shown in outputs, screenshots or recordings; only the movements it measures drive the avatar.',
  ),
  h('div', { class: 'row' }, camBtn, calibBtn, calibStatus),
  trackStatus,
  h(
    'label',
    { class: 'check' },
    previewToggle,
    'Show the camera picture here (only in this window)',
  ),
  selfView,
  handUi.el,
  trackingSettings,
  devMode
    ? h(
        'div',
        { class: 'row dev' },
        recordBtn,
        h('span', { class: 'hint' }, 'Developer: saves blendshape values and head pose, no video.'),
      )
    : '',
  h('h3', {}, 'Live inputs'),
  inputsTable,
);

// ---------------------------------------------------------------------------
// Mapping and hotkeys

const mapping = mappingEditor(studio);
panels.Mapping.append(
  h('h2', {}, 'Tracking → parameters'),
  h(
    'p',
    { class: 'hint' },
    'Rules targeting the same parameter add up. Mouth opening is combined with lip sync (see Audio).',
  ),
  mapping.el,
);
const hotkeys = hotkeyEditor(studio);
const expressions = expressionEditor(studio, (m, kind) => notify(m, kind ?? 'info'));
panels.Hotkeys.append(
  h('h2', {}, 'Hotkeys'),
  h(
    'p',
    { class: 'hint' },
    globalHotkeys
      ? 'A hotkey is up to two keys (with Ctrl, Alt, Shift if you like), or a mouse button. On-screen buttons, up to eight, run down the right side of the stage.'
      : 'A hotkey is up to two keys (with Ctrl, Alt, Shift if you like), or a mouse button. They work while this window has focus: a web page cannot see keys pressed in other apps. In the desktop app they also work while a game or OBS has focus. On-screen buttons, up to eight, run down the right side of the stage.',
  ),
  globalHotkeys?.panel ?? '',
  hotkeys.el,
  expressions.el,
);
installKeyHandler(studio, globalHotkeys?.isGlobal);

function renderButtons(): void {
  buttonsBar.replaceChildren(
    ...(studio.settings?.hotkeys ?? [])
      .filter((x) => x.button)
      // Up to eight on-screen buttons, down the right side of the stage.
      .slice(0, 8)
      .map((x) => {
        const a = x.action;
        const on =
          a.type === 'expression'
            ? studio.activeExpressions.has(a.expression)
            : a.type === 'item'
              ? runtime.isItemVisible(a.item)
              : a.type === 'itemScene'
                ? studio.isItemSceneOn(a.scene)
                : false;
        const label =
          x.label ||
          (a.type === 'expression'
            ? a.expression
            : a.type === 'item'
              ? (studio.items.find((i) => i.id === a.item)?.label ?? 'Item')
              : a.type === 'itemScene'
                ? (studio.itemScenes.find((sc) => sc.id === a.scene)?.name ?? 'Item scene')
                : a.type === 'motion'
                  ? (studio.model?.manifest.motions.find(
                      (m) => m.group === a.motion.group && m.index === a.motion.index,
                    )?.name ?? 'Motion')
                  : a.type === 'calibrate'
                    ? 'Calibrate'
                    : 'All expressions off');
        return h(
          'button',
          {
            class: `hk${on ? ' on' : ''}`,
            'aria-pressed':
              a.type === 'expression' || a.type === 'item' || a.type === 'itemScene'
                ? String(on)
                : undefined,
            'data-hotkey': x.id,
            ...(x.release === 'hold'
              ? {
                  onpointerdown: (e: Event) => {
                    const pe = e as PointerEvent;
                    (pe.currentTarget as HTMLElement).setPointerCapture(pe.pointerId);
                    void studio.run('fire_hotkey', { id: x.id }).catch(() => undefined);
                  },
                  onpointerup: () => void studio.run('release_hotkey', { id: x.id }),
                  onpointercancel: () => void studio.run('release_hotkey', { id: x.id }),
                }
              : {
                  onclick: () =>
                    void studio.run('fire_hotkey', { id: x.id }).catch(() => undefined),
                }),
          },
          label,
          x.keys ? h('kbd', {}, comboLabel(x.keys)) : '',
        );
      }),
  );
}

// ---------------------------------------------------------------------------
// Audio panel

const micBtn = h('button', { class: 'primary', id: 'mic-toggle' });
const meter = h(
  'div',
  { class: 'meter', role: 'meter', 'aria-label': 'Microphone level' },
  h('span'),
  h('i', { class: 'gate', title: 'Noise gate' }),
);
const gateValue = h('output', { id: 'gate-value' });
const audioSettings = h('div');
const voice = voicePanel(studio, (m, kind) => notify(m, kind ?? 'info'));
/** The microphones the browser offers; names appear once access is allowed. */
const micSelect = h('select', {
  id: 'mic-device',
  'aria-label': 'Microphone',
  onchange: () => {
    if (studio.microphoneOn)
      void studio
        .startMicrophone(micSelect.value || undefined)
        .catch((e) => notify(microphoneErrorMessage(e, mediaContext(!!desktopMode())), 'error'));
  },
});
async function listMicrophones(): Promise<void> {
  const devices = await navigator.mediaDevices?.enumerateDevices?.().catch(() => []);
  const inputs = (devices ?? []).filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default');
  const chosen = studio.microphoneDevice ?? micSelect.value;
  micSelect.replaceChildren(
    h('option', { value: '' }, 'Default microphone'),
    ...inputs.map((d, i) =>
      h(
        'option',
        { value: d.deviceId, selected: d.deviceId === chosen },
        d.label || `Microphone ${i + 1}`,
      ),
    ),
  );
}
void listMicrophones();
navigator.mediaDevices?.addEventListener?.('devicechange', () => void listMicrophones());
studio.events.on('microphoneChanged', () => void listMicrophones());
micBtn.addEventListener('click', () => {
  if (studio.microphoneOn) studio.stopMicrophone();
  else
    void studio
      .startMicrophone(micSelect.value || undefined)
      .catch((e) => notify(microphoneErrorMessage(e, mediaContext(!!desktopMode())), 'error'));
});
const MODE_LABELS: Record<LipSyncMode, string> = {
  tracking: 'Camera only',
  microphone: 'Microphone only',
  max: 'Whichever is wider (max)',
  add: 'Add both',
  blend: 'Blend',
};
function renderAudioSettings(): void {
  voice.refresh();
  audioSettings.replaceChildren();
  const s = studio.settings;
  if (!s) return;
  audioSettings.append(
    h(
      'label',
      {},
      'Mouth opening from',
      select(
        LIP_SYNC_MODES.map((m) => [m, MODE_LABELS[m]] as const),
        s.lipSync.mode,
        (v) => void studio.run('set_lip_sync', { mode: v }).catch(() => undefined),
      ),
    ),
    s.lipSync.mode === 'blend'
      ? h(
          'label',
          {},
          'Camera ↔ microphone',
          h('input', {
            type: 'range',
            min: 0,
            max: 1,
            step: 0.05,
            value: s.lipSync.weight,
            onchange: (e: Event) =>
              void studio
                .run('set_lip_sync', { weight: Number((e.target as HTMLInputElement).value) })
                .catch(() => undefined),
          }),
        )
      : '',
    h(
      'label',
      {},
      'Microphone sensitivity',
      h('input', {
        type: 'range',
        min: 0,
        max: 4,
        step: 0.1,
        value: s.lipSync.gain,
        onchange: (e: Event) =>
          void studio
            .run('set_lip_sync', { gain: Number((e.target as HTMLInputElement).value) })
            .catch(() => undefined),
      }),
    ),
    h(
      'details',
      { class: 'advanced' },
      h('summary', {}, 'Advanced'),
      h(
        'label',
        {},
        'Noise gate (dBFS)',
        h('input', {
          type: 'range',
          id: 'gate',
          min: GATE_MIN_DB,
          max: GATE_MAX_DB,
          step: 1,
          value: s.lipSync.gate,
          oninput: (e: Event) => {
            const gate = Number((e.target as HTMLInputElement).value);
            renderGate(gate);
          },
          onchange: (e: Event) => {
            const gate = Number((e.target as HTMLInputElement).value);
            void studio.run('set_lip_sync', { gate }).catch(() => undefined);
          },
        }),
        gateValue,
      ),
      h(
        'p',
        { class: 'hint' },
        'Sounds quieter than the gate leave the mouth closed. Stay quiet, watch the level meter above, and set the gate (the line) just above where the level sits. The meter only displays the level; nothing is recorded.',
      ),
    ),
  );
  renderGate();
}
function renderGate(value?: number): void {
  const gate = value ?? studio.settings?.lipSync.gate ?? -45;
  gateValue.textContent = `${gate} dB`;
  (meter.lastChild as HTMLElement).style.left = `${meterFraction(gate) * 100}%`;
}
panels.Audio.append(
  h('h2', {}, 'Voice lipsync'),
  h(
    'p',
    { class: 'hint' },
    'Runs on this computer with Mochi2D’s live lip sync and its vowel analysis. Audio is never stored or sent; calibrating a voice keeps only its vowels’ spectra.',
  ),
  h('div', { class: 'row' }, micBtn, micSelect),
  meter,
  voice.el,
  audioSettings,
);

// ---------------------------------------------------------------------------
// Items panel

const itemFolderInput = h('input', {
  type: 'file',
  id: 'item-folder',
  webkitdirectory: true,
  multiple: true,
  hidden: true,
});
const itemZipInput = h('input', {
  type: 'file',
  id: 'item-zip',
  accept: '.zip,application/zip',
  hidden: true,
});
const itemList = h('div', { class: 'items' });

async function addItem(
  p: Promise<import('../core/modelFiles').ModelFileSet | undefined>,
): Promise<void> {
  try {
    if (!studio.settings) throw new Error('Load a model first.');
    const files = await p;
    if (!files) return;
    await studio.addItem(files);
    notify(`Added ${safeDecode(files.label)}`);
    renderItems();
  } catch (e) {
    fail(e);
  }
}
/** A folder of PNG frames: an animated item. */
async function addFrameItem(source: FrameSource): Promise<void> {
  try {
    if (!studio.settings) throw new Error('Load a model first.');
    const paths = framePaths(source)!;
    const name = safeDecode(source.label.split('/').pop() ?? source.label);
    notify(`Preparing ${paths.length} frames of “${name}”…`);
    const build = await frameFolderItem(source, paths, name);
    await studio.addItem(new MemoryFileSet(name, build.files), { file: name });
    notify(`Added “${name}”: ${build.frames} frames at ${build.fps} fps.`);
    renderItems();
  } catch (e) {
    fail(e);
  }
}
itemFolderInput.addEventListener('change', () => {
  const list = itemFolderInput.files;
  if (!list?.length) return;
  const l = listFolderInput(list);
  const frames = framesOf(l);
  void (frames ? addFrameItem(frames) : addItem(fileSetFromFiles(l.label, l.files)));
});
itemZipInput.addEventListener(
  'change',
  () => itemZipInput.files?.[0] && void addItem(fromZipFile(itemZipInput.files[0])),
);

/** An animated item's frame rate (0–60; 0 holds the frame) and play state. */
function animationControls(id: string): HTMLElement | '' {
  const a = studio.itemAnimation(id);
  if (!a) return '';
  const play = h(
    'button',
    {
      class: 'item-play',
      'aria-pressed': String(a.playing),
      onclick: () => {
        const now = studio.setItemAnimation(id, { playing: !studio.itemAnimation(id)?.playing });
        play.textContent = now?.playing ? 'Pause' : 'Play';
        play.setAttribute('aria-pressed', String(!!now?.playing));
      },
    },
    a.playing ? 'Pause' : 'Play',
  );
  return h(
    'div',
    { class: 'row item-animation' },
    h(
      'span',
      { class: 'hint' },
      a.ownTiming
        ? `Animated, ${a.frames} frames, with the GIF’s own timing (${a.baseFps} is its normal speed).`
        : `Animated, ${a.frames} frames.`,
    ),
    h(
      'label',
      {},
      'Frame rate',
      h('input', {
        type: 'number',
        class: 'item-fps',
        min: 0,
        max: 60,
        step: 1,
        value: a.fps,
        title: a.ownTiming
          ? `Speed: ${a.baseFps} plays the GIF as it is, twice that plays it twice as fast (0 holds the frame shown)`
          : 'Frames per second, 0 to 60 (0 holds the frame shown)',
        'aria-label': 'Frame rate',
        onchange: (e: Event) => {
          const v = Number((e.target as HTMLInputElement).value);
          if (Number.isFinite(v)) studio.setItemAnimation(id, { fps: v });
        },
      }),
    ),
    play,
  );
}

function renderItems(): void {
  itemList.replaceChildren();
  if (!studio.settings) {
    itemList.append(h('p', { class: 'hint' }, 'Load a model first.'));
    return;
  }
  if (!studio.items.length) itemList.append(h('p', { class: 'hint' }, 'No items yet.'));
  const state = new Map(runtime.items().map((i) => [i.id, i]));
  for (const item of studio.items) {
    const r = state.get(item.id);
    const pl = r?.placement ?? item.placement;
    const num = (label: string, key: 'x' | 'y' | 'scale' | 'rotation', step: number) =>
      h(
        'label',
        {},
        label,
        numberInput(
          +(pl?.[key] ?? (key === 'scale' ? 1 : 0)).toFixed(3),
          (v) => {
            void studio
              .run('set_item', { id: item.id, [key]: key === 'scale' ? Math.max(0.01, v) : v })
              .catch(() => undefined);
            renderItems();
          },
          { step },
        ),
      );
    itemList.append(
      h(
        'div',
        { class: 'item', 'data-item': item.id },
        h(
          'div',
          { class: 'row' },
          h('input', {
            value: item.label,
            'aria-label': 'Item name',
            onchange: (e: Event) =>
              studio.renameItem(item.id, (e.target as HTMLInputElement).value.trim() || item.label),
          }),
          h(
            'label',
            { class: 'check' },
            h('input', {
              type: 'checkbox',
              checked: r?.visible ?? item.visible,
              onchange: (e: Event) => {
                void studio
                  .run('set_item', { id: item.id, visible: (e.target as HTMLInputElement).checked })
                  .catch(() => undefined);
                renderButtons();
              },
            }),
            'Show',
          ),
          h('button', { class: 'link', onclick: () => studio.removeItem(item.id) }, 'Remove'),
        ),
        animationControls(item.id),
        layerHint(item.id),
        item.temporary
          ? h(
              'p',
              { class: 'hint item-temporary' },
              'Loaded by a plugin, for this session only. ',
              h(
                'button',
                {
                  class: 'link item-keep',
                  onclick: () =>
                    void studio
                      .keepItem(item.id)
                      .then(() => notify(`Kept “${item.label}”.`))
                      .catch(fail),
                },
                'Keep it',
              ),
            )
          : '',
        r
          ? h(
              'div',
              { class: 'grid2' },
              num('X', 'x', 0.01),
              num('Y', 'y', 0.01),
              num('Scale', 'scale', 0.05),
              num('Rotation (°)', 'rotation', 1),
            )
          : h('p', { class: 'warn' }, 'Its files are missing. Remove it and add it again.'),
        r
          ? h(
              'div',
              { class: 'row' },
              h(
                'label',
                { class: 'check' },
                h('input', {
                  type: 'checkbox',
                  checked: pl?.front ?? true,
                  onchange: (e: Event) =>
                    void studio
                      .run('set_item', {
                        id: item.id,
                        front: (e.target as HTMLInputElement).checked,
                      })
                      .catch(() => undefined),
                }),
                'In front of the model',
              ),
              h(
                'label',
                { class: 'check', title: 'Mirrored left to right (or Ctrl+click it on the stage)' },
                h('input', {
                  type: 'checkbox',
                  class: 'item-mirror',
                  checked: pl?.mirror === true,
                  onchange: (e: Event) =>
                    studio.setItemMirror(item.id, (e.target as HTMLInputElement).checked),
                }),
                'Flipped',
              ),
              h(
                'label',
                { class: 'check' },
                h('input', {
                  type: 'checkbox',
                  checked: r.pinned,
                  onchange: (e: Event) => {
                    const on = (e.target as HTMLInputElement).checked;
                    void studio
                      .run('set_item', { id: item.id, pinned: on })
                      .then((r) => {
                        const note = (r as { note?: string }).note;
                        if (note) notify(note, 'error');
                        renderItems();
                      })
                      .catch(() => undefined);
                  },
                }),
                'Pin to model',
              ),
            )
          : '',
      ),
    );
  }
}

/** Where a plugin put an item among the model's art meshes (ItemSortRequest), with a way back. */
function layerHint(id: string): HTMLElement | string {
  const sort = studio.itemSort(id);
  if (!sort || (!sort.layer && !sort.split)) return '';
  const place = (d: ItemDepth): string =>
    d === 'front'
      ? 'in front of the model'
      : d === 'behind'
        ? 'behind the model'
        : 'above' in d
          ? `just in front of the model’s “${d.above}”`
          : `just behind the model’s “${d.below}”`;
  const has = (d: ItemDepth): boolean =>
    typeof d === 'string' || studio.runtime.artMeshIds().includes('above' in d ? d.above : d.below);
  const parts = [
    sort.layer
      ? `Drawn ${place(sort.layer)}${has(sort.layer) ? '' : ' (this model has no such art mesh, so it is drawn on its side)'}.`
      : '',
    sort.split
      ? `Split at its “${sort.split.mesh}”: the part before it is drawn ${place(sort.split.back)}.`
      : '',
  ].filter(Boolean);
  return h(
    'p',
    { class: 'hint item-layer' },
    `${parts.join(' ')} Set by a plugin. `,
    h(
      'button',
      {
        class: 'link item-whole',
        onclick: () => {
          studio.drawItemWhole(id);
          renderItems();
        },
      },
      'Draw it whole',
    ),
  );
}

const scenes = itemScenesPanel(studio, (m, kind) => notify(m, kind ?? 'info'));
panels.Items.append(
  h('h2', {}, 'Items'),
  h(
    'p',
    { class: 'hint' },
    'Props drawn over the model, from a model folder or zip. Drag an item on the stage to move it; pin it so it follows the body. Item files stay in this browser.',
  ),
  h(
    'div',
    { class: 'row' },
    h('button', { class: 'primary', onclick: () => itemFolderInput.click() }, 'Add item folder…'),
    h('button', { onclick: () => itemZipInput.click() }, 'Add item zip…'),
    itemFolderInput,
    itemZipInput,
  ),
  webItemForm(),
  itemList,
  scenes.el,
);

/** The Items sheet's web item: a page drawn as an item, in the desktop app. */
function webItemForm(): HTMLElement {
  if (!studio.webItemsAvailable)
    return h(
      'p',
      { class: 'hint', id: 'web-item-note' },
      'Web items (a web page drawn as an item) need the desktop app: a browser page cannot draw another site’s page into a picture.',
    );
  const url = h('input', {
    id: 'web-item-url',
    type: 'url',
    placeholder: 'https://…',
    'aria-label': 'Address of the page',
  }) as HTMLInputElement;
  const size = select(
    [
      ['640x360', '640 × 360'],
      ['1280x720', '1280 × 720'],
      ['400x400', '400 × 400'],
      ['800x200', '800 × 200'],
    ] as const,
    '640x360',
    () => undefined,
    'Size',
  );
  size.id = 'web-item-size';
  const fps = h('input', {
    id: 'web-item-fps',
    type: 'number',
    min: 1,
    max: WEB_ITEM_MAX_FPS,
    value: WEB_ITEM_DEFAULTS.fps,
    'aria-label': 'Frames a second',
  }) as HTMLInputElement;
  return h(
    'details',
    { class: 'web-item' },
    h('summary', {}, 'Web item (a page as an item)'),
    h(
      'p',
      { class: 'hint' },
      'A web page drawn as an item: a chat, an alert box, a counter. It runs on its own, with no access to Mochi Studio, your files, camera or microphone; it is muted, and you cannot click it. Only addresses you type here.',
    ),
    h(
      'div',
      { class: 'row' },
      url,
      size,
      h('label', {}, 'Frames a second', fps),
      h(
        'button',
        {
          id: 'web-item-add',
          onclick: () => {
            const [w, hgt] = size.value.split('x').map(Number);
            void studio
              .addWebItem({
                url: url.value.trim(),
                width: w!,
                height: hgt!,
                fps: Number(fps.value),
              })
              .catch((e: Error) => notify(e.message, 'error'));
          },
        },
        'Add web item',
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Output panel

const outputSettings = h('div');
const outputUrl = new URL('output.html', location.href).href;
const viewsToggle = h('input', { type: 'checkbox', id: 'bridge-views' });
const viewsStatus = h('p', { class: 'hint', id: 'views-status' });
const viewsProgress = h('ul', { class: 'view-progress', id: 'view-progress' });
const mb = (n: number): string => `${(n / 1048576).toFixed(n < 10 * 1048576 ? 1 : 0)} MB`;
function renderViewProgress(): void {
  const list = [...studio.viewStatus.values()];
  viewsProgress.replaceChildren(
    ...list.map((v, i) =>
      h(
        'li',
        { 'data-state': v.state },
        `View ${i + 1}: `,
        v.state === 'loading'
          ? `loading the model… ${mb(v.loaded)}${v.total ? ` of ${mb(v.total)}` : ''}`
          : v.state === 'ready'
            ? `ready (loaded ${mb(v.total)} in ${(v.ms / 1000).toFixed(1)} s)`
            : `failed: ${v.message ?? 'unknown error'}`,
        v.state === 'loading' && v.total ? h('progress', { max: v.total, value: v.loaded }) : '',
      ),
    ),
  );
}
studio.events.on('outputViews', renderViewProgress);
const uploadLine = h('p', { class: 'hint', id: 'view-upload' });
function renderUploads(pending: number): void {
  const u = link.uploadStats;
  uploadLine.textContent = pending
    ? `Preparing the model for bridge views: ${mb(u.sentBytes + u.skippedBytes)} of ${mb(u.queuedBytes)}…`
    : u.queuedBytes
      ? `The model is ready for bridge views (${mb(u.queuedBytes)}).`
      : '';
}
const viewsPairInput = h('input', {
  id: 'views-pair-code',
  inputmode: 'numeric',
  maxlength: 6,
  placeholder: '6-digit code',
  'aria-label': 'Pairing code',
});
const viewsPairBox = h(
  'div',
  { class: 'row', hidden: true },
  viewsPairInput,
  h('button', { onclick: () => link.pair(viewsPairInput.value) }, 'Pair'),
);
const obsUrl = h('input', {
  readonly: true,
  id: 'obs-url',
  'aria-label': 'Address for OBS',
  onfocus: (e: Event) => (e.target as HTMLInputElement).select(),
});
const spoutBox = h('div', { id: 'spout-box' });
const cameraBox = h('div', { id: 'vcam-box' });
const obsBox = h(
  'div',
  { class: 'row', hidden: true },
  obsUrl,
  h(
    'button',
    {
      onclick: () =>
        void navigator.clipboard?.writeText(obsUrl.value).then(() => notify('Copied.')),
    },
    'Copy',
  ),
  h(
    'button',
    {
      title: 'Make a new address; the old one stops working',
      onclick: () => void refreshObsUrl(true),
    },
    'New address',
  ),
);
viewsToggle.addEventListener('change', () => {
  if (viewsToggle.checked) link.enableViews(bridgeUrl.value.trim() || DEFAULT_BRIDGE_URL);
  else link.disableViews();
});
async function refreshObsUrl(renew = false): Promise<void> {
  try {
    obsUrl.value = await link.viewUrl(location.href, renew);
  } catch (e) {
    fail(e);
  }
}
function setBackground(b: Background): void {
  const args =
    b.kind === 'image'
      ? { kind: 'image', image: b.src, fit: b.fit }
      : b.kind === 'transparent'
        ? { kind: 'transparent' }
        : { kind: b.kind, color: b.color };
  void studio.run('set_background', args).catch(() => undefined);
}
function setTransform(patch: Partial<SceneTransform>): void {
  if (studio.settings) void studio.run('set_transform', patch).catch(() => undefined);
}
/**
 * A drag or a burst of wheel steps moves the model live, then becomes one
 * set_transform command (one undo step) when it ends.
 */
let gestureStart: SceneTransform | undefined;
function moveLive(t: SceneTransform): void {
  const s = studio.settings;
  if (!s) return;
  gestureStart ??= s.transform;
  studio.updateSettings({ transform: t });
}
function commitMove(): void {
  const s = studio.settings;
  const start = gestureStart;
  gestureStart = undefined;
  if (!s || !start) return;
  const end = s.transform;
  studio.updateSettings({ transform: start });
  setTransform(end);
}
function renderOutputSettings(): void {
  outputSettings.replaceChildren();
  const s = studio.settings;
  const b = studio.stage.background;
  const kinds = [
    // One name everywhere: "Transparent background".
    ['transparent', 'Transparent background'],
    ['chroma', 'Chroma key'],
    ['color', 'Solid color'],
    ['image', 'Image'],
  ] as const;
  const imgInput = h('input', {
    type: 'file',
    accept: 'image/png,image/jpeg,image/webp,image/gif',
    hidden: true,
  });
  imgInput.addEventListener('change', () => {
    const f = imgInput.files?.[0];
    if (!f) return;
    if (f.size > 8 * 1024 * 1024) return notify('Choose an image under 8 MB.', 'error');
    const r = new FileReader();
    r.onload = () =>
      setBackground({
        kind: 'image',
        src: String(r.result),
        fit: b.kind === 'image' ? b.fit : 'cover',
      });
    r.readAsDataURL(f);
  });
  outputSettings.append(
    h('h3', { id: 'background' }, 'Background'),
    s
      ? h(
          'label',
          { class: 'check' },
          h('input', {
            type: 'checkbox',
            id: 'stage-override',
            checked: s.stageOverride,
            onchange: (e: Event) => studio.setStageOverride((e.target as HTMLInputElement).checked),
          }),
          'Use a different background and frame cap for this model',
        )
      : '',
    h('p', { class: 'hint' }, s?.stageOverride ? 'For this model only.' : 'For all models.'),
    select(
      kinds,
      b.kind,
      (k) => {
        if (k === 'transparent') setBackground({ kind: 'transparent' });
        else if (k === 'chroma') setBackground({ kind: 'chroma', color: CHROMA_PRESETS.green });
        else if (k === 'color') setBackground({ kind: 'color', color: '#202028' });
        else imgInput.click();
      },
      'Background',
    ),
    b.kind === 'chroma'
      ? h(
          'div',
          { class: 'row' },
          ...Object.entries(CHROMA_PRESETS).map(([n, c]) =>
            h(
              'button',
              {
                class: `swatch${b.color === c ? ' on' : ''}`,
                style: `--c:${c}`,
                onclick: () => setBackground({ kind: 'chroma', color: c }),
              },
              n,
            ),
          ),
          h('input', {
            type: 'color',
            value: b.color,
            'aria-label': 'Key color',
            onchange: (e: Event) =>
              setBackground({ kind: 'chroma', color: (e.target as HTMLInputElement).value }),
          }),
        )
      : '',
    b.kind === 'color'
      ? h('input', {
          type: 'color',
          value: b.color,
          'aria-label': 'Background color',
          onchange: (e: Event) =>
            setBackground({ kind: 'color', color: (e.target as HTMLInputElement).value }),
        })
      : '',
    b.kind === 'image'
      ? h(
          'div',
          { class: 'row' },
          h('button', { onclick: () => imgInput.click() }, 'Change image…'),
          select(
            [
              ['cover', 'Fill'],
              ['contain', 'Fit'],
            ] as const,
            b.fit,
            (fit) => setBackground({ ...b, fit }),
            'Image fit',
          ),
        )
      : '',
    imgInput,
    h('h3', {}, 'Frame rate'),
    h(
      'label',
      {},
      'Cap',
      select(
        [
          ['0', 'Uncapped'],
          ['24', '24 fps'],
          ['30', '30 fps'],
          ['60', '60 fps'],
          ['120', '120 fps'],
        ] as const,
        String(studio.stage.fpsCap),
        (v) => void studio.run('set_frame_cap', { fps: Number(v) }).catch(() => undefined),
      ),
    ),
  );
  if (!s) return;
  outputSettings.append(
    h('h3', {}, 'Position'),
    h('p', { class: 'hint' }, 'Drag the stage to move, scroll to zoom, Shift+drag to rotate.'),
    h(
      'div',
      { class: 'grid2' },
      h(
        'label',
        {},
        'X',
        numberInput(+s.transform.x.toFixed(3), (x) => setTransform({ x }), { step: 0.01 }),
      ),
      h(
        'label',
        {},
        'Y',
        numberInput(+s.transform.y.toFixed(3), (y) => setTransform({ y }), { step: 0.01 }),
      ),
      h(
        'label',
        {},
        'Zoom',
        numberInput(
          +s.transform.zoom.toFixed(3),
          (zoom) => setTransform({ zoom: Math.min(10, Math.max(0.1, zoom)) }),
          { step: 0.05, min: 0.1, max: 10 },
        ),
      ),
      h(
        'label',
        {},
        'Rotation (°)',
        numberInput(
          +s.transform.rotation.toFixed(1),
          (rotation) => setTransform({ rotation: normalizeRotation(rotation) }),
          { step: 1 },
        ),
      ),
    ),
    h(
      'button',
      { onclick: () => setTransform({ x: 0, y: 0, zoom: 1, rotation: 0 }) },
      'Reset position',
    ),
  );
}
panels.Output.append(
  h('h2', {}, 'Output for streaming'),
  h(
    'p',
    { class: 'hint' },
    'Add this address in OBS as a Browser Source. It shows only the avatar and follows this window.',
  ),
  h(
    'div',
    { class: 'row' },
    h('input', {
      readonly: true,
      value: outputUrl,
      'aria-label': 'Output view address',
      onfocus: (e: Event) => (e.target as HTMLInputElement).select(),
    }),
    h(
      'button',
      {
        onclick: () => void navigator.clipboard?.writeText(outputUrl).then(() => notify('Copied.')),
      },
      'Copy',
    ),
    h('button', { onclick: () => open(outputUrl, 'mochi-output', 'width=800,height=800') }, 'Open'),
  ),
  h(
    'p',
    { class: 'hint' },
    'This address works in this browser (an OBS dock or a window you capture). OBS’s own Browser Source has its own browser profile: use the bridge address below for it.',
  ),
  h('h3', {}, 'For an OBS Browser Source (through the bridge)'),
  h(
    'p',
    { class: 'hint' },
    'Start the bridge on this computer (npm run bridge), tick the box, then paste the address into a Browser Source. The address gives display only: it cannot control anything.',
  ),
  h('label', { class: 'check' }, viewsToggle, 'Output views through the bridge'),
  viewsStatus,
  viewsPairBox,
  obsBox,
  uploadLine,
  viewsProgress,
  outputSettings,
  spoutBox,
  cameraBox,
);

// Spout2 output: its section, kept up to date with the senders' state.
function renderSpout(): void {
  const active = document.activeElement;
  if (active instanceof HTMLInputElement && spoutBox.contains(active)) return;
  spoutBox.replaceChildren(
    spoutSection(studio, (name, args) => void studio.run(name, args).catch(fail)),
  );
}
studio.events.on('spoutState', renderSpout);
studio.events.on('appSettingsChanged', renderSpout);
function renderCamera(): void {
  const active = document.activeElement;
  if (active instanceof HTMLInputElement && cameraBox.contains(active) && active.type === 'color')
    return;
  cameraBox.replaceChildren(
    virtualCameraSection(studio, (name, args) => void studio.run(name, args).catch(fail)),
  );
}
studio.events.on('virtualCameraState', renderCamera);
studio.events.on('appSettingsChanged', renderCamera);
// The stage's size is an output's default size: tell the senders when it changes.
let spoutResize: ReturnType<typeof setTimeout> | undefined;
new ResizeObserver(() => {
  clearTimeout(spoutResize);
  spoutResize = setTimeout(() => studio.applySpout(), 500);
}).observe(canvas);

// ---------------------------------------------------------------------------
// Stage interaction

let drag: { x: number; y: number; rotate: boolean } | undefined;
canvas.addEventListener('pointerdown', (e) => {
  if (!studio.settings || modelLocked || e.button !== 0) return;
  // Items are dragged by Mochi2D itself.
  if (runtime.itemAt(e.clientX, e.clientY)) return;
  drag = { x: e.clientX, y: e.clientY, rotate: e.shiftKey };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  const s = studio.settings;
  if (!drag || !s) return;
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  drag.x = e.clientX;
  drag.y = e.clientY;
  if (drag.rotate)
    moveLive({ ...s.transform, rotation: normalizeRotation(s.transform.rotation + dx * 0.5) });
  else moveLive(dragTransform(s.transform, dx, dy, canvas.clientHeight));
});
canvas.addEventListener('pointerup', () => {
  drag = undefined;
  commitMove();
});
let wheelTimer: ReturnType<typeof setTimeout> | undefined;
canvas.addEventListener(
  'wheel',
  (e) => {
    const s = studio.settings;
    if (!s) return;
    e.preventDefault();
    if (modelLocked) return;
    const r = canvas.getBoundingClientRect();
    const fx = (e.clientX - r.left - r.width / 2) / r.height;
    const fy = (e.clientY - r.top - r.height / 2) / r.height;
    moveLive(zoomAround(s.transform, Math.exp(-e.deltaY * 0.001), fx, fy));
    if (wheelTimer) clearTimeout(wheelTimer);
    wheelTimer = setTimeout(commitMove, 300);
  },
  { passive: false },
);

// Mochi2D sizes the drawing buffer to the canvas's CSS size.
runtime.attach(canvas);
// A press on the stage closes the main menu and the model bar (the sheets stay).
stageWrap.addEventListener(
  'pointerdown',
  () => {
    if (!mainMenu.hidden || !modelBar.hidden) closeOverlays();
  },
  { capture: true },
);
installStageItems({
  studio,
  runtime,
  stage: stageWrap,
  trash,
  notify,
  log,
  openMenu,
  itemsLocked: () => itemsLocked,
});
if (runtime.problem)
  stageWrap.append(
    h(
      'div',
      { class: 'stage-problem', id: 'stage-problem', role: 'alert' },
      h('strong', {}, runtime.problem),
      h('p', {}, 'What to try:'),
      h(
        'ul',
        {},
        WEBGL_TIPS.map((t) => h('li', {}, t)),
      ),
      h(
        'p',
        {},
        'Tracking, settings, hotkeys and the other tabs still work; the avatar appears once WebGL 2 is available.',
      ),
    ),
  );

// ---------------------------------------------------------------------------
// Agents: the local bridge (milestone 2)

const link = new AgentLink(studio, bridgeViews);
(window as unknown as { mochiAgentLink: AgentLink }).mochiAgentLink = link;
const agentToggle = h('input', { type: 'checkbox', id: 'agent-access' });
const bridgeUrl = h('input', {
  id: 'bridge-url',
  value: link.url,
  'aria-label': 'Bridge address',
  placeholder: DEFAULT_BRIDGE_URL,
});
const linkStatus = h('p', { class: 'hint', id: 'bridge-status' });
const pairBox = h('div', { class: 'row', id: 'pair-box', hidden: true });
const pairInput = h('input', {
  id: 'pair-code',
  inputmode: 'numeric',
  maxlength: 6,
  placeholder: '6-digit code',
  'aria-label': 'Pairing code',
});
pairBox.append(
  pairInput,
  h('button', { class: 'primary', onclick: () => link.pair(pairInput.value) }, 'Pair'),
);
const clientList = h('ul', { class: 'clients', id: 'agent-clients' });
const tokenBox = h('div', { class: 'tokens' });
const agentLog = h('ol', { class: 'agent-log', id: 'agent-log' });

agentToggle.addEventListener('change', () => {
  if (agentToggle.checked) link.enable(bridgeUrl.value.trim() || DEFAULT_BRIDGE_URL);
  else link.disable();
});

function mcpSetup(token: string): string {
  const bin = 'node /path/to/mochi-studio/bridge/bin.mjs';
  return [
    'Claude Code:',
    `  claude mcp add mochi-studio -e MOCHI_STUDIO_TOKEN=${token} -- ${bin} mcp`,
    '',
    'Claude Desktop and other clients (mcpServers in their JSON settings):',
    JSON.stringify(
      {
        mcpServers: {
          'mochi-studio': {
            command: 'node',
            args: ['/path/to/mochi-studio/bridge/bin.mjs', 'mcp'],
            env: { MOCHI_STUDIO_TOKEN: token },
          },
        },
      },
      null,
      2,
    ),
  ].join('\n');
}

async function renderTokens(created?: { token: string; name: string }): Promise<void> {
  tokenBox.replaceChildren();
  if (link.state !== 'connected') return;
  const name = h('input', {
    id: 'token-name',
    placeholder: 'Name, e.g. Claude',
    'aria-label': 'Token name',
  });
  const scope = (id: string, label: string, checked: boolean) =>
    h(
      'label',
      { class: 'check' },
      h('input', { type: 'checkbox', 'data-scope': id, checked }),
      label,
    );
  const scopes = h(
    'div',
    { class: 'row' },
    scope('read', 'Read state', true),
    scope('control', 'Control the avatar', true),
    scope('screenshot', 'Take screenshots', true),
  );
  tokenBox.append(
    h('h3', {}, 'Tokens'),
    h(
      'p',
      { class: 'hint' },
      'Each program or agent gets its own token, with the permissions you choose. The bridge keeps only a hash of it.',
    ),
    h('div', { class: 'row' }, name),
    scopes,
    h(
      'button',
      {
        id: 'token-create',
        onclick: async () => {
          const chosen = [...scopes.querySelectorAll<HTMLInputElement>('input[data-scope]')]
            .filter((i) => i.checked)
            .map((i) => i.dataset.scope as 'read' | 'control' | 'screenshot');
          try {
            const r = await link.createToken(name.value.trim() || 'agent', chosen);
            await renderTokens({ token: r.token, name: r.info.name });
          } catch (e) {
            fail(e);
          }
        },
      },
      'Create token',
    ),
  );
  if (created)
    tokenBox.append(
      h(
        'div',
        { class: 'new-token' },
        h('p', {}, `Token for “${created.name}”. Copy it now: it is not shown again.`),
        h('input', {
          readonly: true,
          value: created.token,
          id: 'new-token',
          onfocus: (e: Event) => (e.target as HTMLInputElement).select(),
        }),
        h('pre', { class: 'setup' }, mcpSetup(created.token)),
      ),
    );
  const tokens = await link.listTokens().catch(() => []);
  if (tokens.length)
    tokenBox.append(
      h(
        'ul',
        { class: 'token-list' },
        tokens.map((t) =>
          h(
            'li',
            {},
            `${t.name} · ${t.scopes.join(', ')}${t.lastUsed ? ` · last used ${new Date(t.lastUsed).toLocaleString()}` : ''} `,
            h(
              'button',
              {
                class: 'link',
                onclick: async () => {
                  await link.revokeToken(t.id).catch(fail);
                  await renderTokens();
                },
              },
              'Revoke',
            ),
          ),
        ),
      ),
    );
}

function linkText(): string {
  return link.state === 'connecting'
    ? 'Connecting to the bridge…'
    : link.state === 'pairing'
      ? `The bridge asks for its pairing code: it is printed where the bridge runs (or run “npm run bridge -- status”). ${link.message}`
      : link.message;
}
let obsShown = false;
function renderLink(): void {
  refreshGuide();
  const replaced = link.state === 'replaced';
  agentToggle.checked = link.agentsOn && !replaced;
  const agentsState = replaced ? 'replaced' : link.agentsOn ? link.state : 'off';
  linkStatus.textContent =
    agentsState === 'off'
      ? 'Agent access is off. Nothing outside this page can control the avatar.'
      : linkText();
  linkStatus.dataset.state = agentsState;
  pairBox.hidden = !(link.agentsOn && link.state === 'pairing');
  // The Output tab's bridge views.
  viewsToggle.checked = link.viewsOn && !replaced;
  const viewsState = replaced ? 'replaced' : link.viewsOn ? link.state : 'off';
  viewsStatus.dataset.state = viewsState;
  viewsStatus.textContent =
    viewsState === 'off'
      ? 'Off: only views in this browser follow this window.'
      : viewsState === 'connected'
        ? 'Connected. Paste this address into an OBS Browser Source:'
        : linkText();
  viewsPairBox.hidden = !(link.viewsOn && link.state === 'pairing');
  obsBox.hidden = viewsState !== 'connected';
  if (viewsState === 'connected' && !obsShown) {
    obsShown = true;
    void refreshObsUrl();
  } else if (viewsState !== 'connected') obsShown = false;
  clientList.replaceChildren(
    ...(link.clients.length
      ? link.clients.map((c) =>
          h(
            'li',
            {},
            `● ${c.name} (${c.scopes.join(', ')}) since ${new Date(c.connectedAt).toLocaleTimeString()}`,
          ),
        )
      : [h('li', { class: 'hint' }, 'No agent connected.')]),
  );
  agentChip.hidden = link.clients.length === 0;
  agentChip.dataset.on = String(link.clients.length > 0);
  agentChip.textContent = `● Agent: ${link.clients.map((c) => c.name).join(', ')}`;
  agentChip.title = link.clients.map((c) => `${c.name}: ${c.scopes.join(', ')}`).join('\n');
}
function renderAgentLog(): void {
  const entries = studio.commands
    .entries(500)
    .filter((e) => e.origin.kind === 'agent')
    .slice(-20);
  agentLog.replaceChildren(
    ...entries
      .reverse()
      .map((e) =>
        h(
          'li',
          { class: e.ok ? '' : 'failed' },
          `${new Date(e.time).toLocaleTimeString()} ${e.origin.name ?? 'agent'}: ${e.name}${e.ok ? '' : ` — ${e.error?.message ?? 'failed'}`}`,
        ),
      ),
  );
}
let reopened = false;
link.events.on('state', ({ state }) => {
  renderLink();
  // The desktop app: once its bridge is connected, the recent folders can be read.
  if (state === 'connected' && recentUi && !reopened) {
    reopened = true;
    void recentUi.reopenLast();
  }
  if (state === 'connected') void renderTokens();
  else tokenBox.replaceChildren();
});
link.events.on('clients', renderLink);
link.events.on('uploads', ({ pending }) => renderUploads(pending));
studio.commands.events.on('executed', ({ entry }) => {
  if (entry.origin.kind === 'agent') renderAgentLog();
});
studio.commands.events.on('history', ({ canUndo, canRedo }) => {
  undoBtn.disabled = !canUndo;
  redoBtn.disabled = !canRedo;
});
addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  if (e.code === 'KeyZ' || e.code === 'KeyY') {
    e.preventDefault();
    const redo = e.code === 'KeyY' || e.shiftKey;
    void studio.run(redo ? 'redo' : 'undo').catch(() => undefined);
  }
});

panels.Agents.append(
  h('h2', {}, 'Agents'),
  h(
    'p',
    { class: 'hint' },
    'Let programs and AI agents (through MCP) control the avatar, through a small bridge that runs on this computer. Start it with “npm run bridge”, then turn agent access on. Camera and microphone data never go to agents.',
  ),
  h('label', { class: 'check' }, agentToggle, 'Agent access'),
  h('label', {}, 'Bridge address', bridgeUrl),
  linkStatus,
  pairBox,
  h('h3', {}, 'Connected'),
  clientList,
  tokenBox,
  h('h3', {}, 'Recent agent commands'),
  agentLog,
);
// Plugins made for VTube Studio (the plugin API; off until switched on).
const pluginHost = new PluginHost(studio, runtime, link, canvas);
(window as unknown as { mochiPlugins: PluginHost }).mochiPlugins = pluginHost;
const plugins = pluginsUi(pluginHost, link, {
  bridgeUrl: () => bridgeUrl.value.trim() || DEFAULT_BRIDGE_URL,
  desktop: !!desktopMode(),
});
panels.Agents.append(plugins.panel);

// Collaboration: several people's avatars on one stage.
const collab = new CollabStage(studio, runtime);
const collabBox = h('div', { id: 'collab-box' });
panels.Collab.append(h('h2', {}, 'Collaborate'), collabBox);
function renderCollab(): void {
  const active = document.activeElement;
  // Don't redraw under someone dragging a slider; a text field keeps its text, caret and focus
  // (new chat messages show while someone types).
  if (active instanceof HTMLInputElement && collabBox.contains(active) && active.type === 'range')
    return;
  const kept =
    active instanceof HTMLInputElement && collabBox.contains(active) && active.id
      ? { id: active.id, value: active.value, at: active.selectionStart }
      : undefined;
  collabBox.replaceChildren(collabSection(studio, collab));
  if (!kept) return;
  const again = document.getElementById(kept.id);
  if (!(again instanceof HTMLInputElement) || again.type === 'checkbox') return;
  again.value = kept.value;
  again.focus();
  if (kept.at !== null)
    try {
      again.setSelectionRange(kept.at, kept.at);
    } catch {
      // Not a text field.
    }
}
let collabRedraw = 0;
collab.listeners.add(() => {
  // Many changes come at once (a model's files arriving): redraw once a frame at most.
  if (collabRedraw) return;
  collabRedraw = requestAnimationFrame(() => {
    collabRedraw = 0;
    renderCollab();
  });
  setTimeout(() => {
    if (collabRedraw) {
      cancelAnimationFrame(collabRedraw);
      collabRedraw = 0;
      renderCollab();
    }
  }, 250);
});
studio.events.on('appSettingsChanged', renderCollab);
studio.events.on('modelLoaded', renderCollab);
renderCollab();
(window as unknown as { mochiCollab: CollabStage }).mochiCollab = collab;
studio.collab = collab;
document.getElementById('status')?.prepend(plugins.chip);
document.body.append(plugins.dialog, plugins.imageDialog, plugins.selectionDialog);
stageWrap.append(plugins.outline);
pluginHost.events.on('changed', () => mapping.refresh());
// A phone as a face tracker (the bridge's phone tracker; off until switched on).
const phoneUi = phonePanel(studio, link, {
  bridgeUrl: () => bridgeUrl.value.trim() || DEFAULT_BRIDGE_URL,
  desktop: !!desktopMode(),
});
handUi.el.after(phoneUi.el);
// The mouse and the controller.
const otherInputs = otherInputsPanel(studio);
phoneUi.el.after(otherInputs.el);
// The display light overlay.
const lightUi = lightOverlayPanel(studio, (m, kind) => notify(m, kind ?? 'info'));
otherInputs.el.after(lightUi.el);

renderLink();
const desktop = desktopMode();
if (desktop) {
  // The desktop app: its own bridge, so OBS views are always available.
  bridgeUrl.value = desktop.bridgeUrl;
  link.enableViews(desktop.bridgeUrl);
  if (link.rememberedOn) link.enable(desktop.bridgeUrl);
  if (link.rememberedPluginsOn) link.enablePlugins(desktop.bridgeUrl);
  if (link.rememberedPhoneOn) link.enablePhone(desktop.bridgeUrl);
} else {
  if (link.rememberedOn) link.enable();
  if (link.rememberedViewsOn) link.enableViews();
  if (link.rememberedPluginsOn) link.enablePlugins();
  if (link.rememberedPhoneOn) link.enablePhone();
}

// ---------------------------------------------------------------------------
// Status and refresh

/** A face was seen since the camera was last started (for the guide). */
let faceSeen = false;
studio.events.on('trackingFound', () => (faceSeen = true));
studio.events.on('cameraChanged', () => {
  if (!studio.cameraOn) faceSeen = false;
});

function refreshGuide(): void {
  const s = studio.settings;
  guide.render({
    model: !!studio.model,
    cameraOn: studio.cameraOn,
    faceSeen: faceSeen || studio.faceVisible,
    calibrated: !!s && Object.keys(s.calibration).length > 0,
    // The step is about OBS: only views through the bridge count.
    outputViews: studio.outputViewIds.filter((id) => bridgeViews.viewIds.has(id)).length,
    bridgeReady: link.viewsOn && link.state === 'connected',
    desktop: !!desktopMode(),
  });
  stageEmpty.hidden = !!studio.model || !!runtime.problem;
}

/** The guide's last step: the Output tab, with bridge views on in a browser. */
function setUpOutput(): void {
  showTab('Output');
  if (!link.viewsOn) link.enableViews(bridgeUrl.value.trim() || DEFAULT_BRIDGE_URL);
  (link.state === 'connected' ? obsBox : viewsStatus).scrollIntoView({ block: 'center' });
}

function renderIndicators(): void {
  refreshGuide();
  camChip.textContent = studio.cameraOn ? '● Camera on' : 'Camera off';
  camChip.dataset.on = String(studio.cameraOn);
  micChip.textContent = studio.microphoneOn ? '● Microphone on' : 'Microphone off';
  micChip.dataset.on = String(studio.microphoneOn);
  const n = studio.outputViewCount;
  viewsChip.textContent = n ? `Output views: ${n}` : 'No output view';
  faceChip.hidden = !studio.trackingOn;
  faceChip.textContent = studio.faceVisible ? 'Face found' : 'No face';
  faceChip.dataset.state = studio.faceVisible ? 'ok' : 'warn';
  camBtn.textContent = studio.cameraOn ? 'Stop camera' : 'Start camera';
  micBtn.textContent = studio.microphoneOn ? 'Stop microphone' : 'Start microphone';
  selfView.replaceChildren();
  const v = studio.cameraElement;
  if (studio.cameraOn && v && previewToggle.checked) selfView.append(v);
}

function renderBackground(): void {
  const b = studio.stage.background;
  stageWrap.dataset.bg = b.kind;
  stageWrap.style.background = b && (b.kind === 'color' || b.kind === 'chroma') ? b.color : '';
  stageWrap.style.backgroundImage = b?.kind === 'image' ? `url("${b.src}")` : '';
  stageWrap.style.backgroundSize = b?.kind === 'image' ? b.fit : '';
}

function renderAll(): void {
  renderModelInfo();
  if (!importBox.querySelector('.report')) renderImport();
  renderTrackingSettings();
  renderAudioSettings();
  renderOutputSettings();
  renderItems();
  renderBackground();
  renderButtons();
  mapping.refresh();
  hotkeys.refresh();
  renderIndicators();
}

studio.events.on('modelLoaded', renderAll);
studio.events.on('modelUnloaded', renderAll);
studio.events.on('physicsChanged', ({ overriddenBy }) => updatePhysicsOverrideNote(overriddenBy));
studio.events.on('itemScenesChanged', () => renderButtons());
studio.events.on('appSettingsChanged', () => {
  const active = document.activeElement;
  if (!(active instanceof HTMLInputElement && active.closest('.voice-lipsync'))) voice.refresh();
  handUi.refresh();
  phoneUi?.refresh();
});
studio.events.on('expressionListChanged', () => {
  renderModelInfo();
  hotkeys.refresh();
});
let pending = false;
studio.events.on('settingsChanged', () => {
  // Coalesce bursts (dragging) into one re-render per frame.
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    const active = document.activeElement;
    const inSide =
      active instanceof HTMLElement && active.closest('.side') && active.tagName !== 'BUTTON';
    renderBackground();
    renderButtons();
    if (!drag) renderOutputSettings();
    if (!inSide) {
      renderTrackingSettings();
      renderAudioSettings();
      mapping.refresh();
      hotkeys.refresh();
      expressions.refresh();
      scenes.refresh();
    }
  });
});
for (const ev of [
  'cameraChanged',
  'microphoneChanged',
  'trackingFound',
  'trackingLost',
  'outputViews',
] as const)
  studio.events.on(ev, renderIndicators);
studio.events.on('hotkeyReleased', () => {
  renderButtons();
  renderModelInfo();
});
studio.events.on('hotkeyFired', () => {
  renderButtons();
  renderModelInfo();
});
studio.events.on('calibration', ({ state, secondsLeft }) => {
  if (state === 'failed')
    guide.setError(
      'calibrate',
      'No face was seen while calibrating. Face the camera, in good light, and try again.',
    );
  if (state === 'done' || state === 'failed') refreshGuide();
  calibStatus.textContent =
    state === 'counting'
      ? `Look straight ahead, relax your face… ${secondsLeft}`
      : state === 'sampling'
        ? 'Hold still…'
        : state === 'done'
          ? 'Calibrated.'
          : 'No face seen. Try again.';
});
studio.events.on('error', ({ message }) => notify(message, 'error'));
// Errors that do not stop anything (a frame step, an output view): the log, and a toast
// the first time.
studio.events.on('log', ({ text, kind }) => {
  if (log(text, kind) && kind === 'error') toastOnly(text, 'error');
});
addEventListener('error', (e) => {
  if (log(`Unexpected error: ${errorText(e.error ?? e.message)}`, 'error'))
    toastOnly('Something went wrong; the stage keeps running. See the log.', 'error');
});
addEventListener('unhandledrejection', (e) => {
  // Logged here; the browser's own report would only repeat it.
  e.preventDefault();
  console.warn(e.reason);
  log(`Unexpected error: ${errorText(e.reason)}`, 'error');
});
// The desktop app's main process and bridge.
desktopApi()?.onMainError?.((text) => {
  if (log(text, 'error')) toastOnly(text, 'error');
});
// For tests.
(window as unknown as { mochiLog: AppLog }).mochiLog = appLog;
studio.events.on('appSettingsChanged', () => {
  renderBackground();
  if (!drag) renderOutputSettings();
});
studio.events.on('itemsChanged', () => {
  renderButtons();
  const active = document.activeElement;
  if (!(active instanceof HTMLInputElement && active.closest('.items'))) renderItems();
  // Scenes name their items; the editor (if open) keeps its ticks.
  if (!(active instanceof HTMLElement && active.closest('.item-scenes'))) scenes.refresh();
});

// Live values, a few times a second.
setInterval(() => {
  // Only while someone can see them: a stream runs with the settings closed.
  if (!settingsSheet.hidden && !panels.Mapping.hidden) mapping.live();
  if (!panels.Tracking.hidden) {
    trackStatus.textContent = studio.cameraOn
      ? `Tracking at ${studio.trackerRate.toFixed(0)} fps · ${studio.faceVisible ? 'face found' : 'no face'}${studio.phoneTracking ? ` · the face from ${studio.faceSource === 'phone' ? 'the phone' : 'this camera'}` : ''}`
      : studio.phoneTracking
        ? `Camera off · a phone tracks · ${studio.faceVisible ? 'face found' : 'no face'}`
        : 'Camera off.';
    const vals = Object.entries(studio.lastInputs).filter(([k]) => !k.startsWith('bs.'));
    inputsTable.replaceChildren(
      ...vals.map(([k, v]) =>
        h('div', { class: 'inrow' }, h('span', {}, k), h('span', {}, v.toFixed(2))),
      ),
    );
  }
  const lvl = meterFraction(studio.micLevel ?? -Infinity);
  (meter.firstChild as HTMLElement).style.width = `${Math.round(lvl * 100)}%`;
  voice.live();
  if (!panels.Tracking.hidden) {
    handUi.live();
    lightUi.live();
  }
  meter.dataset.open = String(
    studio.micLevel !== undefined && studio.micLevel > (studio.settings?.lipSync.gate ?? -45),
  );
}, 150);

renderAll();
renderSpout();
renderCamera();
studio.start();
if (studio.spoutSupported) void studio.refreshSpout();
if (studio.virtualCameraSupported) void studio.refreshVirtualCamera();
studio.startup.script = scriptStart;
studio.mark('uiReady');
addEventListener('pagehide', () => void studio.flushSave());

const auto = params.get('model');
if (auto) void load(fileSetFromUrl(new URL(auto, location.href).href));
