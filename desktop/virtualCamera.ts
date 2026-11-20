/**
 * The virtual camera in the desktop app's main process
 * (docs/virtual-camera.md), Linux first: the app's own output view in a
 * hidden offscreen window of the camera's size; its frames converted to
 * YUYV and written to the v4l2loopback device labelled "Mochi Studio
 * Camera" (native/v4l2).
 *
 * The device must exist: loading v4l2loopback needs root, which the app never
 * asks for. Until it exists, the state says what to install and run, and the
 * app looks again each time the page asks for the state.
 *
 * For tests, MOCHI_VCAM_FAKE_DEVICE names a file that stands in for the
 * device: each frame overwrites it, and the format goes next to it as JSON.
 */
import { BrowserWindow } from 'electron';
import { closeSync, existsSync, openSync, readdirSync, writeFileSync, writeSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { CameraFeed, type CameraDevice, type Converter } from '../src/core/cameraFeed.ts';
import {
  CAMERA_NAME,
  cameraPageUrl,
  LINUX_SETUP,
  type VirtualCameraConfig,
  type VirtualCameraState,
} from '../src/core/virtualCamera.ts';

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

/** Loads the module next to the app (unpacked from the archive in a package), or says why not. */
export function loadV4l2Addon(dir: string): V4l2Addon | string {
  if (process.platform !== 'linux')
    return 'The virtual camera comes to the desktop app on Linux first; Windows and macOS follow.';
  const candidates = [
    join(dir, 'native', 'mochi_v4l2.node').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1'),
    join(dir, 'native', 'mochi_v4l2.node'),
  ];
  const file = candidates.find((p) => existsSync(p));
  if (!file) return 'This build of the app has no virtual camera module.';
  try {
    return createRequire(__filename)(file) as V4l2Addon;
  } catch (e) {
    return `The virtual camera module could not be loaded: ${(e as Error).message}`;
  }
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

function v4l2Device(addon: V4l2Addon, path: string): CameraDevice {
  const fd = addon.open(path);
  return {
    path,
    setFormat: (w, h, fps) => {
      const f = addon.setFormat(fd, w, h, fps);
      if (f.width !== w || f.height !== h)
        throw new Error(`the device took ${f.width} × ${f.height} instead of ${w} × ${h}`);
    },
    write: (frame) => void addon.write(fd, frame),
    close: () => addon.close(fd),
  };
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
  private url = '';
  private problem: string | undefined;
  private setup: string[] | undefined;
  private startError: string | undefined;

  private addon: V4l2Addon | string;
  private log: (m: string) => void;
  private fake: string | undefined;

  constructor(
    addon: V4l2Addon | string,
    log: (m: string) => void,
    fake = process.env.MOCHI_VCAM_FAKE_DEVICE,
  ) {
    this.addon = addon;
    this.log = log;
    this.fake = fake || undefined;
  }

  get available(): boolean {
    return !!this.fake || typeof this.addon !== 'string';
  }

  state(): VirtualCameraState {
    // A device made since (modprobe): start now.
    if (this.cfg?.enabled && !this.feed) this.start(this.cfg);
    const c = this.cfg;
    const f = this.feed;
    return {
      available: this.available,
      ...(typeof this.addon === 'string' && !this.fake ? { problem: this.addon } : {}),
      ...(this.problem ? { problem: this.problem } : {}),
      ...(this.setup ? { setup: this.setup } : {}),
      ...(f ? { device: f.device.path } : {}),
      active: !!f && f.frames > 0 && !f.error,
      width: c?.width ?? 0,
      height: c?.height ?? 0,
      fps: c?.fps ?? 0,
      frames: f?.frames ?? 0,
      ...((f?.error ?? this.startError) ? { error: f?.error ?? this.startError } : {}),
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

  private openDevice(): CameraDevice | undefined {
    this.problem = undefined;
    this.setup = undefined;
    if (this.fake) return fileDevice(this.fake);
    const addon = this.addon as V4l2Addon;
    const all = loopbackDevices(addon);
    const mine = all.find((d) => d.label === CAMERA_NAME);
    if (!mine) {
      this.problem = all.length
        ? `No camera device named “${CAMERA_NAME}”. The loopback devices here have other names (${all.map((d) => d.label).join(', ')}), so another app may use them.`
        : `No camera device named “${CAMERA_NAME}”: install v4l2loopback and load it with the camera’s name.`;
      this.setup = LINUX_SETUP;
      return undefined;
    }
    return v4l2Device(addon, mine.path);
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
    const addon = typeof this.addon === 'string' ? undefined : this.addon;
    const convert: Converter | undefined = addon
      ? (src, w, h, under, out, order) => addon.convert(src, w, h, under, out, order === 'rgba')
      : undefined;
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
    const win = new BrowserWindow({
      show: false,
      width: c.width,
      height: c.height,
      enableLargerThanScreen: true,
      useContentSize: true,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      webPreferences: {
        offscreen: { useSharedTexture: false, deviceScaleFactor: 1 },
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
    win.webContents.on('paint', (_e, _dirty, image) => {
      const { width, height } = image.getSize();
      if (width && height) feed.frame(image.toBitmap(), width, height);
    });
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
    this.url = url;
    void this.win.loadURL(url).catch((e: Error) => {
      if (this.feed) this.feed.error = e.message;
    });
  }

  /** Closes the page and the device (other apps see the camera stop). */
  stop(): void {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = undefined;
    this.feed?.stop();
    this.feed = undefined;
  }
}
