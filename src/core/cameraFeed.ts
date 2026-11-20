/**
 * The virtual camera's writer (docs/virtual-camera.md): it takes the output
 * view's frames, converts them (src/core/yuv.ts) and writes them to a
 * camera device at a steady rate.
 *
 * A page paints only when something changes, but camera apps wait for every
 * frame. So each new frame is written as it arrives, and when none came for
 * a frame and a half, the last one is written again.
 */
import { premultipliedToYuyv } from './yuv';

/** A camera device: the v4l2loopback device on Linux, or a fake one in tests. */
export interface CameraDevice {
  readonly path: string;
  /** Sets the frame format (YUYV at this size) and the rate. Throws when the device refuses. */
  setFormat(width: number, height: number, fps: number): void;
  /** Writes one frame (width × height × 2 bytes). */
  write(frame: Uint8Array): void;
  close(): void;
}

export interface CameraFeedOptions {
  width: number;
  height: number;
  fps: number;
  /** What shows through transparent parts, 0xRRGGBB. */
  under: number;
  /** The byte order of the frames given (Chromium's bitmaps are BGRA). */
  order?: 'bgra' | 'rgba';
  /** The conversion (the native module's, which is faster); src/core/yuv.ts's by default. */
  convert?: Converter;
}

/** Premultiplied pixels over `under` to YUYV, into `out`. */
export type Converter = (
  src: Uint8Array,
  width: number,
  height: number,
  under: number,
  out: Uint8Array,
  order: 'bgra' | 'rgba',
) => void;

interface Timers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(t: unknown): void;
  now(): number;
}
const realTimers: Timers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (t) => clearInterval(t as ReturnType<typeof setInterval>),
  now: () => performance.now(),
};

export class CameraFeed {
  private yuyv: Uint8Array;
  private have = false;
  private lastWrite = -Infinity;
  private timer: unknown;
  /** Frames written (new and repeated). */
  frames = 0;
  /** Frames converted from the page. */
  converted = 0;
  error: string | undefined;
  /** What shows through transparent parts; changes take effect with the next frame. */
  under: number;

  readonly device: CameraDevice;
  readonly o: CameraFeedOptions;
  private timers: Timers;

  constructor(device: CameraDevice, o: CameraFeedOptions, timers: Timers = realTimers) {
    this.device = device;
    this.o = o;
    this.timers = timers;
    this.yuyv = new Uint8Array(o.width * o.height * 2);
    this.under = o.under;
  }

  /** Sets the device's format and starts the repeats. Throws when the device refuses the format. */
  start(): void {
    this.device.setFormat(this.o.width, this.o.height, this.o.fps);
    const interval = 1000 / this.o.fps;
    this.timer = this.timers.setInterval(() => {
      if (this.have && this.timers.now() - this.lastWrite >= interval * 1.5) this.write();
    }, interval);
  }

  /** A frame from the page: premultiplied, at the camera's size. */
  frame(pixels: Uint8Array, width: number, height: number): void {
    if (width !== this.o.width || height !== this.o.height) {
      this.error = `a frame of ${width} × ${height} for a camera of ${this.o.width} × ${this.o.height}`;
      return;
    }
    (this.o.convert ?? premultipliedToYuyv)(
      pixels,
      width,
      height,
      this.under,
      this.yuyv,
      this.o.order ?? 'bgra',
    );
    this.have = true;
    this.converted++;
    this.write();
  }

  private write(): void {
    try {
      this.device.write(this.yuyv);
      this.frames++;
      this.lastWrite = this.timers.now();
      this.error = undefined;
    } catch (e) {
      this.error = (e as Error).message;
    }
  }

  stop(): void {
    if (this.timer !== undefined) this.timers.clearInterval(this.timer);
    this.timer = undefined;
    try {
      this.device.close();
    } catch {
      // Closed already.
    }
  }
}
