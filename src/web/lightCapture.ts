/**
 * The display light overlay's capture: a screen or a window,
 * through the browser's screen-capture API (`getDisplayMedia`), or in the
 * desktop app, Electron's capture of the screen or window the person picked. It runs only after
 * the person starts it, and stops when they stop it or the browser ends it.
 *
 * Each sample draws the picture into a tiny canvas (48 × 27 pixels) and
 * reads it there, in this page: the frames are never kept, shown or sent.
 */
import { partAverages, type CapturePart, type Rgb } from '../core/lightOverlay';

export const SAMPLE_W = 48;
export const SAMPLE_H = 27;

export class LightCapture {
  private stream: MediaStream | undefined;
  private video: HTMLVideoElement | undefined;
  private canvas: OffscreenCanvas | HTMLCanvasElement | undefined;
  /** A window (true) or a screen (false). */
  isWindow = false;
  /** Called when the capture ends by itself (the person stopped sharing). */
  onEnded: (() => void) | undefined;

  get active(): boolean {
    return !!this.stream;
  }

  /**
   * Asks the browser for a screen or window; throws when the person refuses.
   * `window` says which kind was picked where the browser does not (the desktop app).
   */
  async start(hint?: { window: boolean; sourceId?: string }): Promise<void> {
    this.stop();
    const md = navigator.mediaDevices;
    let stream: MediaStream;
    if (hint?.sourceId) {
      // The desktop app: Electron's capture of a screen or window it listed, small and slow.
      const video = {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: hint.sourceId,
          maxWidth: 640,
          maxHeight: 360,
          maxFrameRate: 10,
        },
      };
      stream = await md.getUserMedia({ audio: false, video } as unknown as MediaStreamConstraints);
    } else {
      if (!md?.getDisplayMedia) throw new Error('This browser cannot capture the screen.');
      stream = await md.getDisplayMedia({ video: true });
    }
    const track = stream.getVideoTracks()[0];
    if (!track) {
      for (const t of stream.getTracks()) t.stop();
      throw new Error('The capture has no picture.');
    }
    const surface = (track.getSettings() as { displaySurface?: string }).displaySurface;
    this.isWindow = surface ? surface === 'window' || surface === 'browser' : !!hint?.window;
    track.addEventListener('ended', () => {
      this.stop();
      this.onEnded?.();
    });
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play().catch(() => undefined);
    this.stream = stream;
    this.video = video;
  }

  stop(): void {
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = undefined;
    if (this.video) this.video.srcObject = null;
    this.video = undefined;
  }

  /** The three parts' average colors now; undefined before the first picture. */
  sample(): Record<CapturePart, Rgb> | undefined {
    const v = this.video;
    if (!v || v.readyState < 2 || !v.videoWidth) return undefined;
    this.canvas ??=
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(SAMPLE_W, SAMPLE_H)
        : Object.assign(document.createElement('canvas'), { width: SAMPLE_W, height: SAMPLE_H });
    const g = this.canvas.getContext('2d', { willReadFrequently: true }) as
      CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!g) return undefined;
    g.drawImage(v, 0, 0, SAMPLE_W, SAMPLE_H);
    const d = g.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data;
    return partAverages(d, SAMPLE_W, SAMPLE_H);
  }
}
