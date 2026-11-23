/**
 * The virtual camera's writer (docs/virtual-camera.md): it takes the output
 * view's frames, converts them (src/core/yuv.ts) to the device's format
 * and writes them to a camera device at a steady rate.
 *
 * A page paints only when something changes, but camera apps wait for every
 * frame. So each new frame is written as it arrives, and when none came for
 * a frame and a half, the last one is written again.
 */
import { premultipliedToNv12, premultipliedToYuyv } from './yuv';

/** The pixel formats the devices take: YUYV (Linux), NV12 (Windows and macOS). */
export type CameraPixelFormat = 'yuyv' | 'nv12';

/** Bytes a frame of this format and size takes. */
export function frameBytes(format: CameraPixelFormat, width: number, height: number): number {
  return format === 'nv12' ? (width * height * 3) / 2 : width * height * 2;
}

/**
 * A camera device: the v4l2loopback device on Linux, the shared frame ring
 * on Windows, the camera extension's feeder on macOS, or a fake one in tests.
 */
export interface CameraDevice {
  readonly path: string;
  /** The format it takes; YUYV when not said. */
  readonly pixelFormat?: CameraPixelFormat;
  /** Sets the frame size and the rate. Throws when the device refuses. */
  setFormat(width: number, height: number, fps: number): void;
  /** Writes one frame (`frameBytes` of its format). */
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

/** Premultiplied pixels over `under` to the device's format, into `out`. */
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
  private out: Uint8Array;
  private have = false;
  private lastWrite = -Infinity;
  private timer: unknown;
  /** Frames written (new and repeated). */
  frames = 0;
  /** Frames converted from the page. */
  converted = 0;
  error: string | undefined;
  private sizeError = false;
  /** What shows through transparent parts; changes take effect with the next frame. */
  under: number;

  readonly device: CameraDevice;
  readonly o: CameraFeedOptions;
  private timers: Timers;

  constructor(device: CameraDevice, o: CameraFeedOptions, timers: Timers = realTimers) {
    this.device = device;
    this.o = o;
    this.timers = timers;
    this.out = new Uint8Array(frameBytes(device.pixelFormat ?? 'yuyv', o.width, o.height));
    this.under = o.under;
  }

  /**
   * Sets the device's format and starts writing at the camera's rate: each tick writes the
   * newest frame, new or the last one again, so call apps get a steady rate whatever the page's
   * (a still page paints only when something changes; a page held to fewer frames a second
   * while the app's window is slow). Throws when the device refuses the format.
   */
  start(): void {
    this.device.setFormat(this.o.width, this.o.height, this.o.fps);
    this.timer = this.timers.setInterval(() => {
      if (this.have) this.write();
    }, 1000 / this.o.fps);
  }

  /** A frame from the page: premultiplied, at the camera's size. */
  frame(pixels: Uint8Array, width: number, height: number): void {
    if (width !== this.o.width || height !== this.o.height) {
      this.error = `a frame of ${width} × ${height} for a camera of ${this.o.width} × ${this.o.height}`;
      this.sizeError = true;
      return;
    }
    // A frame of the right size again (the page was still being laid out): that's over.
    if (this.sizeError) {
      this.error = undefined;
      this.sizeError = false;
    }
    const reference =
      this.device.pixelFormat === 'nv12' ? premultipliedToNv12 : premultipliedToYuyv;
    (this.o.convert ?? reference)(
      pixels,
      width,
      height,
      this.under,
      this.out,
      this.o.order ?? 'bgra',
    );
    // The first frame goes out at once; the next ones at the camera's ticks.
    const first = !this.have;
    this.have = true;
    this.converted++;
    if (first) this.write();
  }

  private write(): void {
    try {
      this.device.write(this.out);
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
