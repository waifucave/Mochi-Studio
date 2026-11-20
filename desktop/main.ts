/**
 * Mochi Studio desktop: an Electron app that runs the bridge itself, so
 * streamers need no separate Node process. The bridge also serves the built
 * pages at http://127.0.0.1:<port>/app/, so this window and OBS's output
 * address (output.html?bridge=…&view=…) work the same way as with
 * `npm run bridge`.
 *
 * Unsigned builds: see docs/desktop.md.
 */
import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  screen,
  session,
  shell,
  systemPreferences,
} from 'electron';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { basename, join, relative } from 'node:path';
import catalog from '../bridge/catalog.json';
import { BridgeServer } from '../bridge/src/server.ts';
import { BridgeStore } from '../bridge/src/store.ts';
import { DEFAULT_PORT, type CommandInfoWire } from '../src/core/bridgeProtocol.ts';
import { isZipPath, RecentModels, recentState } from './recent.ts';
import { isOwnAddress, parseWebItem } from '../src/core/webItems.ts';
import { parseSpoutConfig } from '../src/core/spout.ts';
import { SpoutOutputs, loadSpoutAddon } from './spout.ts';
import { parseVirtualCameraConfig } from '../src/core/virtualCamera.ts';
import { VirtualCamera, loadV4l2Addon } from './virtualCamera.ts';

const port = Number(process.env.MOCHI_STUDIO_PORT ?? DEFAULT_PORT);
// Tests keep their app data (browser storage, recent models) apart.
if (process.env.MOCHI_STUDIO_USER_DATA) app.setPath('userData', process.env.MOCHI_STUDIO_USER_DATA);
const webDir = join(__dirname, 'web');
let bridge: BridgeServer | undefined;

/**
 * Errors in the main process never stop the app: no
 * dialog over the stream; they go to the window's log (scrubbed there), and
 * wait for the page if it is not there yet.
 */
let mainWindow: BrowserWindow | undefined;
const pendingErrors: string[] = [];
function reportMainError(text: string): void {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoading())
    mainWindow.webContents.send('mochi:main-error', text);
  else if (pendingErrors.length < 50) pendingErrors.push(text);
}
const mainError = (e: unknown): void => {
  console.error('[mochi-studio]', e);
  reportMainError(`The app: ${e instanceof Error ? e.message : String(e)}`);
};
process.on('uncaughtException', mainError);
process.on('unhandledRejection', mainError);

async function start(): Promise<void> {
  const store = new BridgeStore();
  bridge = new BridgeServer({
    port,
    store,
    staticDir: webDir,
    catalog: catalog as CommandInfoWire[],
    log: (m) => {
      process.stderr.write(`[mochi-studio-bridge] ${m}\n`);
      // A connection's error (a plugin's bad frame, say): the window's log too.
      if (m.includes('connection error')) reportMainError(m);
    },
  });
  try {
    await bridge.listen();
  } catch (e) {
    const busy = (e as NodeJS.ErrnoException).code === 'EADDRINUSE';
    dialog.showErrorBox(
      'Mochi Studio',
      busy
        ? `Port ${port} is in use, probably by a bridge started with "npm run bridge". Stop it (the desktop app runs its own), or start the app with MOCHI_STUDIO_PORT set to another port.`
        : `The bridge could not start: ${(e as Error).message}`,
    );
    app.quit();
    return;
  }
  const origin = `http://127.0.0.1:${bridge.port}`;

  // The native folder dialog: the bridge then serves the folder from disk.
  const recent = new RecentModels(join(app.getPath('userData'), 'recent-models.json'));
  const serveFolder = (dir: string) => {
    recent.add(dir);
    return { id: bridge!.registerFolder(dir), label: basename(dir), paths: listFolder(dir), dir };
  };
  ipcMain.handle('mochi:open-folder', async (e) => {
    if (!own(e.senderFrame?.url)) return null;
    // Tests choose the folder without a dialog.
    let dir = process.env.MOCHI_STUDIO_TEST_FOLDER;
    if (!dir) {
      const r = await dialog.showOpenDialog({
        title: 'Open a model folder',
        properties: ['openDirectory'],
      });
      if (r.canceled || !r.filePaths[0]) return null;
      dir = r.filePaths[0];
    }
    return serveFolder(dir);
  });
  // Recent folders: the page may reopen only folders on the list.
  ipcMain.handle('mochi:recent-models', (e) => (own(e.senderFrame?.url) ? recent.list() : []));
  // Zips: the page reads the bytes (as for a zip it is given); views get uploads.
  const serveZip = (path: string) => {
    recent.add(path);
    return { zip: new Uint8Array(readFileSync(path)), label: basename(path), dir: path };
  };
  ipcMain.handle('mochi:open-zip', async (e) => {
    if (!own(e.senderFrame?.url)) return null;
    let path = process.env.MOCHI_STUDIO_TEST_ZIP;
    if (!path) {
      const r = await dialog.showOpenDialog({
        title: 'Open a model zip',
        properties: ['openFile'],
        filters: [{ name: 'Zip archives', extensions: ['zip'] }],
      });
      if (r.canceled || !r.filePaths[0]) return null;
      path = r.filePaths[0];
    }
    return serveZip(path);
  });
  ipcMain.handle('mochi:open-recent', (e, dir: unknown) => {
    if (!own(e.senderFrame?.url) || typeof dir !== 'string' || !recent.has(dir))
      return { error: 'unknown' };
    const state = recentState(dir);
    if (state !== 'ok') return { error: state };
    return isZipPath(dir) ? serveZip(dir) : serveFolder(dir);
  });
  ipcMain.handle('mochi:forget-recent', (e, dir: unknown) => {
    if (own(e.senderFrame?.url) && typeof dir === 'string') recent.forget(dir);
    return recent.list();
  });

  // Hotkeys that work while another app has focus. The page plans them
  // (src/core/globalHotkeys.ts); registering says which keys are taken.
  ipcMain.handle('mochi:global-hotkeys', (e, accelerators: unknown) => {
    if (!own(e.senderFrame?.url) || !Array.isArray(accelerators)) return {};
    globalShortcut.unregisterAll();
    const sender = e.sender;
    const result: Record<string, boolean> = {};
    for (const a of accelerators) {
      if (typeof a !== 'string') continue;
      try {
        result[a] = globalShortcut.register(a, () => {
          if (!sender.isDestroyed()) sender.send('mochi:global-hotkey', a);
        });
      } catch {
        result[a] = false;
      }
    }
    return result;
  });

  // The pointer anywhere on the screen, for the mouse inputs: about 60
  // times a second while the page watches it, measured from the chosen screen (the main one).
  let pointerTimer: ReturnType<typeof setInterval> | undefined;
  /** The screen the mouse inputs are measured from (an Electron display id); null: the main one. */
  let pointerScreen: number | null = null;
  const screenOf = () =>
    screen.getAllDisplays().find((d) => d.id === pointerScreen) ?? screen.getPrimaryDisplay();
  // Spout2 output: on Windows, with the addon built for this app.
  const spout = new SpoutOutputs(loadSpoutAddon(__dirname), reportMainError);
  ipcMain.handle('mochi:spout-configure', (e, raw: unknown) => {
    if (!own(e.senderFrame?.url)) return null;
    const c = parseSpoutConfig(raw, origin);
    return c ? spout.configure(c) : spout.state();
  });
  ipcMain.handle('mochi:spout-state', (e) => (own(e.senderFrame?.url) ? spout.state() : null));
  app.on('will-quit', () => spout.stopAll());
  // The virtual camera: on Linux, through a v4l2loopback device.
  const camera = new VirtualCamera(loadV4l2Addon(__dirname), reportMainError);
  ipcMain.handle('mochi:vcam-configure', (e, raw: unknown) => {
    if (!own(e.senderFrame?.url)) return null;
    const c = parseVirtualCameraConfig(raw, origin);
    return c ? camera.configure(c) : camera.state();
  });
  ipcMain.handle('mochi:vcam-state', (e) => (own(e.senderFrame?.url) ? camera.state() : null));
  app.on('will-quit', () => camera.stop());
  ipcMain.handle('mochi:screens', (e) => {
    if (!own(e.senderFrame?.url)) return [];
    const main = screen.getPrimaryDisplay().id;
    return screen.getAllDisplays().map((d, i) => ({
      id: d.id,
      label: d.label || `Screen ${i + 1}`,
      primary: d.id === main,
      bounds: d.bounds,
    }));
  });
  ipcMain.handle('mochi:pointer-screen', (e, id: unknown) => {
    if (!own(e.senderFrame?.url)) return false;
    pointerScreen = typeof id === 'number' && Number.isFinite(id) ? id : null;
    return true;
  });
  ipcMain.handle('mochi:pointer-watch', (e, on: unknown) => {
    if (!own(e.senderFrame?.url)) return false;
    clearInterval(pointerTimer);
    pointerTimer = undefined;
    if (on !== true) return true;
    const sender = e.sender;
    let last = '';
    pointerTimer = setInterval(() => {
      if (sender.isDestroyed()) {
        clearInterval(pointerTimer);
        pointerTimer = undefined;
        return;
      }
      const p = screen.getCursorScreenPoint();
      const area = screenOf().bounds;
      const key = `${p.x},${p.y},${area.x},${area.y},${area.width},${area.height}`;
      if (key === last) return;
      last = key;
      sender.send('mochi:pointer', { x: p.x, y: p.y, area });
    }, 16);
    return true;
  });

  // The display light overlay: the page lists the screens and windows, the
  // person picks one, and the page captures it (Electron's desktop media source, a camera
  // permission like any other). Only the app's pages.
  // Screens and windows; when listing windows fails (it can, on some X11 setups, and then
  // the whole list is empty), the screens alone.
  const captureSources = async () => {
    const none = { width: 0, height: 0 };
    const both = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: none,
    });
    return both.length
      ? both
      : desktopCapturer.getSources({ types: ['screen'], thumbnailSize: none });
  };
  ipcMain.handle('mochi:capture-sources', async (e) => {
    if (!own(e.senderFrame?.url)) return [];
    return (await captureSources()).map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.id.startsWith('window:') ? 'window' : 'screen',
    }));
  });
  // Web items: a page per item, rendered off screen into its texture. The
  // pages run in their own sandboxed session, with no permissions, no new windows, no
  // downloads, no navigation to another site and no requests to Mochi Studio's own
  // addresses; they get no input and are muted.
  const webSession = session.fromPartition('mochi-web-items');
  webSession.setPermissionRequestHandler((_wc, _p, done) => done(false));
  webSession.setPermissionCheckHandler(() => false);
  webSession.on('will-download', (e) => e.preventDefault());
  const ownOrigins = (): string[] => [
    origin,
    ...(bridge?.phone.port ? [`https://127.0.0.1:${bridge.phone.port}`] : []),
  ];
  // This computer's network addresses (the phone page listens on them).
  const localHosts = (): string[] =>
    Object.values(networkInterfaces()).flatMap((l) => (l ?? []).map((a) => a.address));
  webSession.webRequest.onBeforeRequest((details, done) => {
    const ok =
      /^(https?|wss?|data|blob):/.test(details.url) &&
      !isOwnAddress(details.url, ownOrigins(), localHosts());
    done({ cancel: !ok });
  });
  const webItems = new Map<string, BrowserWindow>();
  ipcMain.handle('mochi:web-item-start', (e, raw: unknown) => {
    if (!own(e.senderFrame?.url)) return { error: 'not allowed' };
    const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const id = typeof o.id === 'string' ? o.id.slice(0, 50) : '';
    const src = parseWebItem(o);
    if (!id || !src) return { error: 'Only an http or https address can be a web item.' };
    if (isOwnAddress(src.url, ownOrigins(), localHosts()))
      return { error: 'A web item cannot show Mochi Studio’s own pages.' };
    webItems.get(id)?.destroy();
    const page = new BrowserWindow({
      show: false,
      width: src.width,
      height: src.height,
      useContentSize: true,
      webPreferences: {
        offscreen: true,
        session: webSession,
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
        backgroundThrottling: false,
      },
    });
    webItems.set(id, page);
    const wc = page.webContents;
    wc.setAudioMuted(true);
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    const home = new URL(src.url).origin;
    wc.on('will-navigate', (ev, url) => {
      if (new URL(url).origin !== home) ev.preventDefault();
    });
    wc.setFrameRate(src.fps);
    const sender = e.sender;
    let last = 0;
    wc.on('paint', (_ev, _dirty, image) => {
      const now = Date.now();
      if (sender.isDestroyed() || now - last < 1000 / src.fps - 5) return;
      last = now;
      const { width, height } = image.getSize();
      sender.send('mochi:web-item-frame', id, { width, height, data: image.toBitmap() });
    });
    page.on('closed', () => {
      if (webItems.get(id) === page) webItems.delete(id);
    });
    void wc.loadURL(src.url).catch(() => undefined);
    return { ok: true };
  });
  ipcMain.handle('mochi:web-item-stop', (e, id: unknown) => {
    if (!own(e.senderFrame?.url) || typeof id !== 'string') return false;
    webItems.get(id)?.destroy();
    webItems.delete(id);
    return true;
  });

  // This window is the app itself: pair it with the bridge directly.
  const hostToken = store.pair(store.pairingCode())!;

  // The camera and microphone, for this app's own pages only.
  const own = (url: string | undefined): boolean => !!url && url.startsWith(origin + '/');
  session.defaultSession.setPermissionRequestHandler((wc, permission, done, details) => {
    const allowed =
      own(details.requestingUrl ?? wc.getURL()) &&
      // display-capture: the light overlay's capture, which the person starts.
      ['media', 'clipboard-sanitized-write', 'clipboard-read', 'display-capture'].includes(
        permission,
      );
    if (!allowed || permission !== 'media' || process.platform !== 'darwin') return done(allowed);
    // macOS asks the person itself, once per device kind (the usage texts are
    // in the app's Info.plist); a refusal reaches the page as NotAllowedError.
    const kinds = (details as { mediaTypes?: string[] }).mediaTypes ?? ['video', 'audio'];
    void Promise.all(
      kinds.map((k) =>
        systemPreferences.askForMediaAccess(k === 'video' ? 'camera' : 'microphone'),
      ),
    )
      .then((ok) => done(ok.every(Boolean)))
      .catch(() => done(false));
  });
  session.defaultSession.setPermissionCheckHandler(
    (_wc, permission, requestingOrigin) =>
      requestingOrigin === origin &&
      ['media', 'clipboard-sanitized-write', 'display-capture'].includes(permission),
  );

  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    title: 'Mochi Studio',
    backgroundColor: '#1d1b26',
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: join(__dirname, 'preload.cjs'),
      // Minimized or covered while streaming, the window keeps its frames: OBS views
      // need the parameters it computes each frame.
      backgroundThrottling: false,
    },
  });
  win.setMenuBarVisibility(false);
  mainWindow = win;
  win.webContents.on('did-finish-load', () => {
    for (const t of pendingErrors.splice(0)) win.webContents.send('mochi:main-error', t);
  });
  // The output view opens as a window of the app; other links in the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (own(url)) return { action: 'allow' };
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!own(url)) e.preventDefault();
  });
  await win.loadURL(`${origin}/app/index.html?desktop=1#host=${encodeURIComponent(hostToken)}`);
}

/** Files of a folder, relative and with forward slashes: no dotfiles, no links, at most 20,000. */
function listFolder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number): void => {
    if (depth > 12 || out.length >= 20_000) return;
    for (const name of readdirSync(d)) {
      if (name.startsWith('.')) continue;
      const p = join(d, name);
      const st = statSync(p, { throwIfNoEntry: false });
      if (!st) continue;
      if (st.isDirectory()) walk(p, depth + 1);
      else if (st.isFile()) out.push(relative(dir, p).split('\\').join('/'));
    }
  };
  walk(dir, 0);
  return out;
}

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => {
  void bridge?.close().finally(() => app.quit());
});
void app.whenReady().then(start);
