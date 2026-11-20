/**
 * Spout2 senders in the desktop app's main process. Each output
 * is the app's own output view in a hidden offscreen window of its size,
 * transparent; its frames go to a Spout2 sender of the addon
 * (native/spout).
 *
 * - **On the GPU** when it can: Electron's offscreen rendering hands each
 *   frame over as a shared D3D11 texture, which the addon copies into the
 *   sender's texture without leaving the GPU.
 * - **Read back** otherwise (no GPU compositing, or asked for): the frame's
 *   pixels, sent with the SDK's SendImage.
 *
 * Chromium's frames have premultiplied alpha, which is what Spout2 receivers
 * expect when set to premultiplied (OBS's composite mode).
 */
import { BrowserWindow, screen } from 'electron';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import {
  drawScale,
  spoutPageUrl,
  type SpoutConfig,
  type SpoutOutputConfig,
  type SpoutOutputState,
  type SpoutPath,
  type SpoutState,
} from '../src/core/spout.ts';

interface NativeSender {
  readonly name: string;
  sendSharedTexture(ntHandle: Buffer): boolean;
  sendImage(bgra: Uint8Array, width: number, height: number): boolean;
  release(): void;
}
export interface SpoutAddon {
  Sender: new (name: string) => NativeSender;
  Receiver: new (name?: string) => {
    receive(): {
      width: number;
      height: number;
      name: string;
      /** DXGI format: 87 is BGRA, 28 RGBA. */
      format: number;
      data: Buffer;
    } | null;
    release(): void;
  };
  senders(): string[];
}

/** Loads the addon next to the app (unpacked from the archive in a package), or says why not. */
export function loadSpoutAddon(dir: string): SpoutAddon | string {
  if (process.platform !== 'win32') return 'Spout2 is available in the desktop app on Windows.';
  const candidates = [
    join(dir, 'native', 'mochi_spout.node').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1'),
    join(dir, 'native', 'mochi_spout.node'),
  ];
  const file = candidates.find((p) => existsSync(p));
  if (!file) return 'This build of the app has no Spout2 module.';
  try {
    return createRequire(__filename)(file) as SpoutAddon;
  } catch (e) {
    return `The Spout2 module could not be loaded: ${(e as Error).message}`;
  }
}

interface Output {
  cfg: SpoutOutputConfig;
  win: BrowserWindow;
  sender: NativeSender;
  url: string;
  path?: SpoutPath;
  /** Started with readback asked for (a change of path restarts the output). */
  forced: boolean;
  /** The drawing scale (above 1 for outputs larger than the screen). */
  scale: number;
  /** The last frame's size. */
  frame?: { width: number; height: number };
  frames: number;
  /** The frame rate asked for (the stage's cap). */
  fps: number;
  error?: string;
}

/**
 * The most frames a second an output sends by readback, once the app knows an
 * output reads back (asked for, or seen at its next change). Each frame is
 * copied from the graphics card to memory and back by the main process.
 * (Changing the rate from inside a paint turned a transparent output white on
 * the Windows runner, so it changes only with the output's settings.)
 */
export const READBACK_FPS = 30;

export class SpoutOutputs {
  private outputs = new Map<string, Output>();

  private addon: SpoutAddon | string;
  private log: (m: string) => void;

  constructor(addon: SpoutAddon | string, log: (m: string) => void) {
    this.addon = addon;
    this.log = log;
  }

  get available(): boolean {
    return typeof this.addon !== 'string';
  }

  state(): SpoutState {
    return {
      available: this.available,
      ...(typeof this.addon === 'string' ? { problem: this.addon } : {}),
      outputs: [...this.outputs.values()].map((o): SpoutOutputState => ({
        name: o.cfg.name,
        active: o.frames > 0 && !o.error,
        width: o.cfg.width,
        height: o.cfg.height,
        mirror: o.cfg.mirror,
        ...(o.path ? { path: o.path } : {}),
        frames: o.frames,
        ...(o.error ? { error: o.error } : {}),
      })),
    };
  }

  /** Starts, changes and stops outputs to match; returns the state. */
  configure(c: SpoutConfig): SpoutState {
    if (typeof this.addon === 'string') return this.state();
    const wanted = new Map(c.outputs.map((o) => [o.name, o]));
    const restarted = new Set<string>();
    for (const [name, t] of this.pending)
      if (!wanted.has(name)) {
        clearTimeout(t);
        this.pending.delete(name);
      }
    for (const [name, o] of this.outputs) {
      if (!wanted.has(name)) this.stop(name);
      else if ((c.path === 'readback') !== o.forced || (!!c.noScale && o.scale !== 1)) {
        this.stop(name);
        restarted.add(name);
      }
    }
    for (const cfg of wanted.values()) {
      const o = this.outputs.get(cfg.name);
      if (restarted.has(cfg.name)) this.restart(cfg, c);
      else if (!o) this.start(cfg, c);
      else this.update(o, cfg, c);
    }
    return this.state();
  }

  stopAll(): void {
    for (const name of [...this.outputs.keys()]) this.stop(name);
  }

  private start(cfg: SpoutOutputConfig, c: SpoutConfig): void {
    const addon = this.addon as SpoutAddon;
    let sender: NativeSender;
    try {
      sender = new addon.Sender(cfg.name);
    } catch (e) {
      this.log(`Spout2 sender ${cfg.name}: ${(e as Error).message}`);
      return;
    }
    const readback = c.path === 'readback';
    // Windows keeps a window within the screen: a larger output is drawn at a fraction of its
    // size and a matching scale, so its frames still have the full size.
    const k = c.noScale ? 1 : drawScale(cfg, screen.getPrimaryDisplay().workAreaSize);
    const win = new BrowserWindow({
      show: false,
      width: Math.round(cfg.width / k),
      height: Math.round(cfg.height / k),
      enableLargerThanScreen: true,
      useContentSize: true,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      webPreferences: {
        offscreen: { useSharedTexture: !readback, deviceScaleFactor: k },
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    const o: Output = {
      cfg,
      scale: k,
      win,
      sender,
      url: spoutPageUrl(c.page, cfg),
      frames: 0,
      forced: readback,
      fps: c.fps,
    };
    this.outputs.set(cfg.name, o);
    win.webContents.setAudioMuted(true);
    win.webContents.setFrameRate(readback ? Math.min(c.fps, READBACK_FPS) : c.fps);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.on('paint', (event, _dirty, image) => {
      const texture = (event as unknown as { texture?: SharedTexture }).texture;
      try {
        if (texture) {
          const handle = texture.textureInfo.handle.ntHandle;
          o.path = 'gpu';
          o.frame = { ...texture.textureInfo.codedSize };
          if (handle && o.sender.sendSharedTexture(handle)) o.frames++;
        } else {
          const { width, height } = image.getSize();
          o.path = 'readback';
          o.frame = { width, height };
          if (width && height && o.sender.sendImage(image.toBitmap(), width, height)) o.frames++;
        }
        o.error = undefined;
      } catch (e) {
        o.error = (e as Error).message;
      } finally {
        texture?.release();
      }
    });
    win.webContents.on('render-process-gone', (_e, d) => {
      o.error = `its page stopped (${d.reason})`;
      this.log(`Spout2 output ${cfg.name}: ${o.error}`);
    });
    void win.loadURL(o.url).catch((e: Error) => {
      o.error = e.message;
    });
  }

  private update(o: Output, cfg: SpoutOutputConfig, c: SpoutConfig): void {
    if (cfg.width !== o.cfg.width || cfg.height !== o.cfg.height) {
      // A new scale needs a new window; the same scale, a new size.
      const k = c.noScale ? 1 : drawScale(cfg, screen.getPrimaryDisplay().workAreaSize);
      if (k !== o.scale) {
        this.stop(cfg.name);
        this.restart(cfg, c);
        return;
      }
      o.win.setContentSize(Math.round(cfg.width / k), Math.round(cfg.height / k));
    }
    o.fps = c.fps;
    o.win.webContents.setFrameRate(o.path === 'readback' ? Math.min(c.fps, READBACK_FPS) : c.fps);
    const url = spoutPageUrl(c.page, cfg);
    o.cfg = cfg;
    if (url !== o.url) {
      o.url = url;
      void o.win.loadURL(url).catch((e: Error) => {
        o.error = e.message;
      });
    }
  }

  /**
   * Starts an output again under the same name a moment after it was released:
   * a sender made again at once, before the old one's page and texture were gone,
   * sent nothing receivers could read (the Windows runner).
   */
  private restart(cfg: SpoutOutputConfig, c: SpoutConfig): void {
    const t = setTimeout(() => {
      this.pending.delete(cfg.name);
      if (!this.outputs.has(cfg.name)) this.start(cfg, c);
    }, 500);
    clearTimeout(this.pending.get(cfg.name));
    this.pending.set(cfg.name, t);
  }

  private pending = new Map<string, ReturnType<typeof setTimeout>>();

  /** Closes the output's page and releases its sender (receivers see it go). */
  private stop(name: string): void {
    const o = this.outputs.get(name);
    if (!o) return;
    this.outputs.delete(name);
    if (!o.win.isDestroyed()) o.win.destroy();
    try {
      o.sender.release();
    } catch {
      // Released already.
    }
  }
}

interface SharedTexture {
  release(): void;
  textureInfo: {
    codedSize: { width: number; height: number };
    handle: { ntHandle?: Buffer };
  };
}
