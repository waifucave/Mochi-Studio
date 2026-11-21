/**
 * The virtual camera in the desktop app's main process
 * (docs/virtual-camera.md): the app's own output view in a hidden offscreen
 * window of the camera's size, its frames converted and written to the
 * platform's camera:
 *
 * - **Linux:** YUYV to the v4l2loopback device labelled "Mochi Studio
 *   Camera" (native/v4l2). The device must exist: loading v4l2loopback needs
 *   root, which the app never asks for. Until it exists, the state says what
 *   to install and run, and the app looks again each time the page asks.
 * - **Windows:** NV12 to the frame ring (native/wincam), which the app's
 *   DirectShow camera reads in each app that opens it, and, on Windows 11,
 *   the Media Foundation camera the app makes (MFCreateVirtualCamera), read
 *   by the Frame Server. Both are installed once with Install (regsvr32 of
 *   the DLLs, with one administrator prompt) and removed with Uninstall.
 * - **macOS:** NV12 to the helper (native/maccam, next to the app's
 *   executable), which writes it into the Camera Extension's sink stream.
 *   Install asks macOS to activate the extension (the person approves it in
 *   System Settings); it needs a signed app in /Applications.
 *
 * For tests, MOCHI_VCAM_FAKE_DEVICE names a file that stands in for the
 * device: each frame overwrites it (YUYV), and the format goes next to it as
 * JSON.
 */
import { BrowserWindow, screen } from 'electron';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, openSync, readdirSync, writeFileSync, writeSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { offscreenScale } from './cameraWindow.ts';
import { helperFrameHeader } from './macCamera.ts';
import { mfInstallPath, windowsInstallCommand } from './windowsCamera.ts';
import {
  CameraFeed,
  type CameraDevice,
  type CameraPixelFormat,
  type Converter,
} from '../src/core/cameraFeed.ts';
import {
  CAMERA_NAME,
  cameraPageUrl,
  LINUX_SETUP,
  type CameraInstallOptions,
  type CameraInstallState,
  type VirtualCameraConfig,
  type VirtualCameraState,
} from '../src/core/virtualCamera.ts';

/** What a platform gives the camera: where frames go, and how it is installed. */
export interface CameraBackend {
  /** Why the camera can't run here at all. */
  unavailable?: string;
  /** The device to send to now, or what is missing. */
  open(): { device: CameraDevice } | { problem: string; setup?: string[] };
  /** The native conversion to the device's format (faster than the reference). */
  convert?: Converter;
  /** Windows and macOS: Install and Uninstall. */
  installer?: CameraInstaller;
}

export interface CameraInstaller {
  installed(): { installed: boolean; detail?: string; olderApps?: boolean };
  install(options?: CameraInstallOptions): Promise<void>;
  uninstall(): Promise<void>;
}

/** Loads a module next to the app (unpacked from the archive in a package), or says why not. */
function loadModule<T>(dir: string, file: string, what: string): T | string {
  const candidates = [
    join(dir, 'native', file).replace(/app\.asar([\\/])/, 'app.asar.unpacked$1'),
    join(dir, 'native', file),
  ];
  const path = candidates.find((p) => existsSync(p));
  if (!path) return `This build of the app has no ${what}.`;
  try {
    return createRequire(__filename)(path) as T;
  } catch (e) {
    return `The ${what} could not be loaded: ${(e as Error).message}`;
  }
}

/** A file next to the app, unpacked from the archive in a package. */
function unpacked(dir: string, ...parts: string[]): string {
  return join(dir, ...parts).replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
}

// --- Linux ------------------------------------------------------------------------

export interface V4l2Addon {
  open(path: string): number;
  close(fd: number): void;
  queryCap(fd: number): { driver: string; card: string; capabilities: number; deviceCaps: number };
  setFormat(
    fd: number,
    width: number,
    height: number,
    fps: number,
  ): { width: number; height: number; bytesPerLine: number; sizeImage: number; rateSet: boolean };
  write(fd: number, frame: Uint8Array): number;
  convert(
    src: Uint8Array,
    width: number,
    height: number,
    under: number,
    dst: Uint8Array,
    rgba?: boolean,
  ): void;
}

/** The loopback devices on this computer, with their labels. */
export function loopbackDevices(addon: V4l2Addon): { path: string; label: string }[] {
  let names: string[];
  try {
    names = readdirSync('/sys/class/video4linux').filter((n) => /^video\d+$/.test(n));
  } catch {
    return [];
  }
  const out: { path: string; label: string }[] = [];
  for (const n of names.sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)))) {
    const path = `/dev/${n}`;
    let fd = -1;
    try {
      fd = addon.open(path);
      const cap = addon.queryCap(fd);
      if (/loopback/i.test(cap.driver)) out.push({ path, label: cap.card });
    } catch {
      // Not ours to open (or gone): skip it.
    } finally {
      if (fd >= 0) addon.close(fd);
    }
  }
  return out;
}

function linuxBackend(dir: string): CameraBackend {
  const addon = loadModule<V4l2Addon>(dir, 'mochi_v4l2.node', 'virtual camera module');
  if (typeof addon === 'string') return { unavailable: addon, open: () => ({ problem: addon }) };
  return {
    convert: (src, w, h, under, out, order) =>
      addon.convert(src, w, h, under, out, order === 'rgba'),
    open() {
      const all = loopbackDevices(addon);
      const mine = all.find((d) => d.label === CAMERA_NAME);
      if (!mine)
        return {
          problem: all.length
            ? `No camera device named “${CAMERA_NAME}”. The loopback devices here have other names (${all.map((d) => d.label).join(', ')}), so another app may use them.`
            : `No camera device named “${CAMERA_NAME}”: install v4l2loopback and load it with the camera’s name.`,
          setup: LINUX_SETUP,
        };
      const fd = addon.open(mine.path);
      return {
        device: {
          path: mine.path,
          setFormat: (w, h, fps) => {
            const f = addon.setFormat(fd, w, h, fps);
            if (f.width !== w || f.height !== h)
              throw new Error(`the device took ${f.width} × ${f.height} instead of ${w} × ${h}`);
          },
          write: (frame) => void addon.write(fd, frame),
          close: () => addon.close(fd),
        },
      };
    },
  };
}

// --- Windows ----------------------------------------------------------------------

export interface WincamAddon {
  open(width: number, height: number, fps: number): { local: boolean; global: boolean };
  write(frame: Uint8Array): number;
  close(): void;
  convert(
    src: Uint8Array,
    width: number,
    height: number,
    under: number,
    dst: Uint8Array,
    rgba?: boolean,
  ): void;
  installed(): {
    dshow: boolean;
    dshowPath: string;
    dshow32: boolean;
    dshow32Path: string;
    mf: boolean;
    mfPath: string;
    mfAvailable: boolean;
  };
  mfState(): MfCameraState;
  mfStart(): MfCameraState;
  mfStop(): MfCameraState;
  mfDevices(): string[];
  mfGrab(
    name: string,
    skip: number,
  ): { width?: number; height?: number; frame?: Uint8Array; error?: string };
}

/** Windows 11's camera (MFCreateVirtualCamera), as the module reports it. */
export interface MfCameraState {
  available: boolean;
  problem?: string;
  running: boolean;
  error?: string;
}

/** Runs a command line as administrator (one UAC prompt); rejects with what went wrong. */
export function runElevated(commandLine: string): Promise<void> {
  // PowerShell's Start-Process -Verb RunAs asks Windows for the rights. The
  // script goes encoded, so no quoting reaches the outer command line.
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const script = [
    `$p = Start-Process -FilePath (Join-Path $env:WINDIR 'System32\\cmd.exe') -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList ${q(`/c "${commandLine}"`)}`,
    'exit $p.ExitCode',
  ].join('\n');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    const ps = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { windowsHide: true },
    );
    let err = '';
    ps.stderr.on('data', (d: Buffer) => (err += d.toString()));
    ps.on('error', reject);
    ps.on('close', (code) => {
      if (code === 0) return resolve();
      if (/cancel/i.test(err))
        return reject(new Error('Windows did not get permission (cancelled).'));
      reject(new Error(`it ended with code ${code}${err ? `: ${err.trim().split('\n')[0]}` : ''}`));
    });
  });
}

function windowsBackend(
  dir: string,
  elevated: (commandLine: string) => Promise<void> = runElevated,
): CameraBackend {
  const addon = loadModule<WincamAddon>(dir, 'mochi_wincam.node', 'virtual camera module');
  if (typeof addon === 'string') return { unavailable: addon, open: () => ({ problem: addon }) };
  const dll64 = unpacked(dir, 'native', 'x64', 'mochi_camera_dshow.dll');
  const dll32 = unpacked(dir, 'native', 'x86', 'mochi_camera_dshow.dll');
  const mfDll = unpacked(dir, 'native', 'x64', 'mochi_camera_mf.dll');
  const mfTarget = mfInstallPath();
  const dlls = {
    dshow64: dll64,
    ...(existsSync(dll32) ? { dshow32: dll32 } : {}),
    ...(existsSync(mfDll) ? { mf: mfDll } : {}),
    mfTarget,
  };
  // Windows 11: the Media Foundation camera, which DirectShow apps list as well;
  // the DirectShow camera only when asked (older and 32-bit apps). It is made
  // the first time the camera is turned on, and kept while the app runs
  // (session lifetime), so apps keep listing it.
  const win11 = (i: ReturnType<WincamAddon['installed']>) =>
    i.mfAvailable && !!dlls.mf && process.env.MOCHI_WINCAM_NO_MF !== '1';
  return {
    convert: (src, w, h, under, out, order) =>
      addon.convert(src, w, h, under, out, order === 'rgba'),
    open() {
      const i = addon.installed();
      const mf = win11(i) && i.mf;
      if (!i.dshow && !mf) return { problem: 'The camera isn’t installed yet: press Install.' };
      if (mf) addon.mfStart();
      const pixelFormat: CameraPixelFormat = 'nv12';
      return {
        device: {
          path: CAMERA_NAME,
          pixelFormat,
          setFormat: (w, h, fps) => void addon.open(w, h, fps),
          write: (frame) => void addon.write(frame),
          close: () => addon.close(),
        },
      };
    },
    installer: {
      installed() {
        const i = addon.installed();
        const ours = (path: string) => path.toLowerCase() === dll64.toLowerCase();
        if (!win11(i)) {
          return {
            installed: i.dshow,
            detail: !i.dshow
              ? 'Install registers the camera for every app on this computer, so Windows asks for administrator rights once.'
              : ours(i.dshowPath)
                ? 'Installed for every app on this computer (DirectShow, 64-bit and 32-bit apps).'
                : `Installed from another copy of Mochi Studio (${i.dshowPath}): Install again to use this one.`,
          };
        }
        const st = addon.mfState();
        const installed = i.mf || i.dshow;
        return {
          installed,
          olderApps: i.dshow,
          detail: !installed
            ? 'Install registers the camera for every app on this computer, so Windows asks for administrator rights once.'
            : !i.mf
              ? 'Only the camera for older apps is installed: Install again to add the Windows 11 camera.'
              : st.error
                ? `Installed, but the Windows 11 camera didn’t start: ${st.error}`
                : i.dshow
                  ? 'Installed for every app on this computer. Apps that use DirectShow list two cameras: “Mochi Studio Camera (Windows Virtual Camera)” and “Mochi Studio Camera”; either works.'
                  : 'Installed for every app on this computer. Apps list it as “Mochi Studio Camera (Windows Virtual Camera)” while Mochi Studio runs.',
        };
      },
      async install(options) {
        const i = addon.installed();
        await elevated(windowsInstallCommand('install', dlls, !win11(i) || !!options?.olderApps));
        if (win11(addon.installed()) && addon.installed().mf) addon.mfStart();
      },
      async uninstall() {
        addon.mfStop();
        await elevated(windowsInstallCommand('uninstall', dlls));
      },
    },
  };
}

// --- macOS ------------------------------------------------------------------------

function macBackend(helper: string): CameraBackend {
  if (!existsSync(helper)) {
    const why = 'This build of the app has no virtual camera helper.';
    return { unavailable: why, open: () => ({ problem: why }) };
  }
  const status = (): boolean => {
    const r = spawnSync(helper, ['status'], { encoding: 'utf8', timeout: 5000 });
    try {
      return JSON.parse(r.stdout).installed === true;
    } catch {
      return false;
    }
  };
  let approval = false;
  const request = (action: 'activate' | 'deactivate') =>
    new Promise<void>((resolve, reject) => {
      const p = spawn(helper, [action]);
      let err = '';
      p.stdout.on('data', (d: Buffer) => {
        if (d.toString().includes('needsApproval')) approval = true;
      });
      p.stderr.on('data', (d: Buffer) => (err += d.toString()));
      p.on('error', reject);
      p.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(err.trim() || `it ended with code ${code}`)),
      );
    });
  const inApplications = /^\/Applications\//.test(process.execPath);
  return {
    open() {
      if (!status())
        return {
          problem: approval
            ? 'Approve “Mochi Studio Camera” in System Settings → Privacy & Security, then turn the camera on again.'
            : 'The camera isn’t installed yet: press Install.',
        };
      let child: ChildProcess | undefined;
      let busy = false;
      let size = { width: 0, height: 0 };
      return {
        device: {
          path: CAMERA_NAME,
          pixelFormat: 'nv12',
          setFormat: (width, height) => {
            size = { width, height };
            child = spawn(helper, ['feed'], { stdio: ['pipe', 'ignore', 'pipe'] });
            child.stdin!.on('drain', () => (busy = false));
            child.stdin!.on('error', () => undefined);
          },
          write: (frame) => {
            if (!child || child.exitCode !== null) throw new Error('the camera helper stopped');
            // A full pipe: the helper hasn't taken the last frame; drop this one.
            if (busy) return;
            const ok = child.stdin!.write(
              Buffer.concat([helperFrameHeader(size.width, size.height), frame]),
            );
            if (!ok) busy = true;
          },
          close: () => {
            child?.stdin?.end();
            child = undefined;
          },
        },
      };
    },
    installer: {
      installed: () => {
        const installed = status();
        return {
          installed,
          detail: installed
            ? 'Installed: every app on this Mac lists “Mochi Studio Camera”.'
            : inApplications
              ? 'Install asks macOS to add the camera; you approve it once in System Settings → Privacy & Security.'
              : 'macOS adds the camera only for apps in the Applications folder: move Mochi Studio there first.',
        };
      },
      install: () => request('activate'),
      uninstall: () => request('deactivate'),
    },
  };
}

/** The camera's backend for this platform. */
export function cameraBackend(dir: string): CameraBackend {
  if (process.platform === 'linux') return linuxBackend(dir);
  if (process.platform === 'win32') return windowsBackend(dir);
  if (process.platform === 'darwin')
    return macBackend(join(dirname(process.execPath), 'mochi-camera'));
  const why = 'The virtual camera isn’t available on this system.';
  return { unavailable: why, open: () => ({ problem: why }) };
}

/** The test stand-in: a file the frames overwrite, and the format beside it. */
function fileDevice(path: string): CameraDevice {
  const fd = openSync(path, 'w');
  return {
    path,
    setFormat: (width, height, fps) =>
      writeFileSync(`${path}.json`, JSON.stringify({ width, height, fps, format: 'YUYV' })),
    write: (frame) => void writeSync(fd, frame, 0, frame.length, 0),
    close: () => closeSync(fd),
  };
}

export class VirtualCamera {
  private cfg: VirtualCameraConfig | undefined;
  private feed: CameraFeed | undefined;
  private win: BrowserWindow | undefined;
  private repaint: ReturnType<typeof setInterval> | undefined;
  private url = '';
  private problem: string | undefined;
  private setup: string[] | undefined;
  private startError: string | undefined;
  private installing: 'install' | 'uninstall' | undefined;
  private installError: string | undefined;

  private backend: CameraBackend;
  private log: (m: string) => void;
  private fake: string | undefined;

  constructor(
    backend: CameraBackend,
    log: (m: string) => void,
    fake = process.env.MOCHI_VCAM_FAKE_DEVICE,
  ) {
    this.backend = backend;
    this.log = log;
    this.fake = fake || undefined;
  }

  get available(): boolean {
    return !!this.fake || !this.backend.unavailable;
  }

  private installState(): CameraInstallState | undefined {
    const ins = this.backend.installer;
    if (!ins || this.fake) return undefined;
    let i: { installed: boolean; detail?: string; olderApps?: boolean };
    try {
      i = ins.installed();
    } catch (e) {
      i = { installed: false, detail: (e as Error).message };
    }
    return {
      ...i,
      ...(this.installing ? { busy: true } : {}),
      ...(this.installError ? { error: this.installError } : {}),
    };
  }

  state(): VirtualCameraState {
    // A device made since (modprobe, Install): start now.
    if (this.cfg?.enabled && !this.feed && !this.installing) this.start(this.cfg);
    const c = this.cfg;
    const f = this.feed;
    const install = this.installState();
    return {
      available: this.available,
      ...(this.backend.unavailable && !this.fake ? { problem: this.backend.unavailable } : {}),
      ...(this.problem ? { problem: this.problem } : {}),
      ...(this.setup ? { setup: this.setup } : {}),
      ...(f ? { device: f.device.path } : {}),
      active: !!f && f.frames > 0 && !f.error,
      width: c?.width ?? 0,
      height: c?.height ?? 0,
      fps: c?.fps ?? 0,
      frames: f?.frames ?? 0,
      ...((f?.error ?? this.startError) ? { error: f?.error ?? this.startError } : {}),
      ...(install ? { install } : {}),
    };
  }

  /** Starts, changes or stops the camera to match; returns the state. */
  configure(c: VirtualCameraConfig): VirtualCameraState {
    const old = this.cfg;
    this.cfg = c;
    if (!this.available || !c.enabled) {
      this.stop();
      return this.state();
    }
    const formatChanged =
      !old || old.width !== c.width || old.height !== c.height || old.fps !== c.fps;
    if (this.feed && formatChanged) this.stop();
    if (!this.feed) this.start(c);
    else {
      this.feed.under = c.under;
      this.loadPage(c);
    }
    return this.state();
  }

  /** Installs or uninstalls the camera (Windows, macOS), then returns the state. */
  async install(
    action: 'install' | 'uninstall',
    options?: CameraInstallOptions,
  ): Promise<VirtualCameraState> {
    const ins = this.backend.installer;
    if (!ins || this.installing) return this.state();
    this.installing = action;
    this.installError = undefined;
    // Uninstalling while sending: stop first, so no app holds the camera's frames.
    if (action === 'uninstall') this.stop();
    try {
      await (action === 'install' ? ins.install(options) : ins.uninstall());
      this.log(`Virtual camera: ${action === 'install' ? 'installed' : 'uninstalled'}.`);
    } catch (e) {
      this.installError = `${action === 'install' ? 'Install' : 'Uninstall'} failed: ${(e as Error).message}`;
      this.log(`Virtual camera: ${this.installError}`);
    } finally {
      this.installing = undefined;
    }
    return this.state();
  }

  private openDevice(): CameraDevice | undefined {
    this.problem = undefined;
    this.setup = undefined;
    if (this.fake) return fileDevice(this.fake);
    const r = this.backend.open();
    if ('problem' in r) {
      this.problem = r.problem;
      this.setup = r.setup;
      return undefined;
    }
    return r.device;
  }

  private start(c: VirtualCameraConfig): void {
    let device: CameraDevice | undefined;
    try {
      device = this.openDevice();
    } catch (e) {
      this.startError = (e as Error).message;
      return;
    }
    if (!device) return;
    // The native conversion is for the device's format; the test file takes YUYV.
    const convert = this.fake ? undefined : this.backend.convert;
    const feed = new CameraFeed(device, {
      width: c.width,
      height: c.height,
      fps: c.fps,
      under: c.under,
      ...(convert ? { convert } : {}),
    });
    try {
      feed.start();
    } catch (e) {
      // Busy (another writer, or a reader holding another format) or refused.
      this.startError = `${device.path}: ${(e as Error).message}`;
      feed.stop();
      return;
    }
    this.startError = undefined;
    this.feed = feed;
    this.openWindow(c, feed);
  }

  /** The hidden window that draws the camera's page, its paints going to the feed. */
  private openWindow(c: VirtualCameraConfig, feed: CameraFeed): void {
    // A window larger than the screen is clamped to it on Windows: there, the
    // page is laid out at half the size and drawn at twice the density, so its
    // frames keep the camera's size.
    const scale = offscreenScale(c, screen.getPrimaryDisplay().workAreaSize);
    const win = new BrowserWindow({
      show: false,
      width: c.width / scale,
      height: c.height / scale,
      enableLargerThanScreen: true,
      useContentSize: true,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      webPreferences: {
        offscreen: { useSharedTexture: false, deviceScaleFactor: scale },
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    this.win = win;
    win.webContents.setAudioMuted(true);
    win.webContents.setFrameRate(c.fps);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    let lastPaint = Date.now();
    win.webContents.on('paint', (_e, _dirty, image) => {
      lastPaint = Date.now();
      const { width, height } = image.getSize();
      if (width && height) feed.frame(image.toBitmap(), width, height);
    });
    // A hidden offscreen page can stop painting on Windows (the runner: two paints,
    // the first before the model was drawn). Without a paint for two frame
    // intervals, it is asked for one.
    const interval = 1000 / c.fps;
    if (this.repaint) clearInterval(this.repaint);
    this.repaint = setInterval(() => {
      if (win.isDestroyed() || Date.now() - lastPaint < 2 * interval) return;
      if (!win.webContents.isPainting()) win.webContents.startPainting();
      win.webContents.invalidate();
    }, interval);
    // The page's warnings and errors, and a load that fails, in the main process's output.
    win.webContents.on('console-message', (e) => {
      if (e.level !== 'debug') console.log(`[camera page] ${e.level}: ${e.message}`);
    });
    win.webContents.on('did-finish-load', () =>
      console.log(`[camera page] loaded: ${win.webContents.getURL()}`),
    );
    win.webContents.on('did-fail-load', (_e, code, text, url) =>
      console.log(`[camera page] the page didn't load (${code} ${text}): ${url}`),
    );
    win.webContents.on('render-process-gone', (_e, d) => {
      feed.error = `its page stopped (${d.reason})`;
      this.log(`Virtual camera: ${feed.error}`);
    });
    this.url = '';
    this.loadPage(c);
  }

  private loadPage(c: VirtualCameraConfig): void {
    const url = cameraPageUrl(c);
    if (!this.win || url === this.url) return;
    // Another page (mirror, background): a fresh window, the feed and device kept.
    // On Windows, a hidden offscreen window that navigates again drew its page
    // opaque, on white.
    if (this.url && this.feed) {
      this.closeWindow();
      this.openWindow(c, this.feed);
      return;
    }
    this.url = url;
    void this.win.loadURL(url).catch((e: Error) => {
      if (this.feed) this.feed.error = e.message;
    });
  }

  private closeWindow(): void {
    if (this.repaint) clearInterval(this.repaint);
    this.repaint = undefined;
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = undefined;
    this.url = '';
  }

  /** Closes the page and the device (other apps see the camera stop). */
  stop(): void {
    this.closeWindow();
    this.feed?.stop();
    this.feed = undefined;
  }
}
