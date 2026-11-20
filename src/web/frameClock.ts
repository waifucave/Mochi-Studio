/**
 * The control window's frame clock: animation frames
 * while the window is drawn, and a worker's ticks (about 30 a second) while
 * it is not. A hidden, minimized or covered window gets no animation frames,
 * yet output views (OBS) still need the parameters it computes each frame.
 *
 * The worker ticks all the time; a tick runs a frame only when no animation
 * frame came for a while, so a drawn window runs on animation frames alone.
 *
 * Each frame is told whether to draw: only a frame of
 * a window that is shown. A worker's tick means no animation frames, so
 * nobody sees the window; a hidden document (minimized, or a background
 * tab) is not seen either, even where the browser keeps animation frames
 * coming (Electron's `backgroundThrottling: false`).
 */
/** Whether the page is out of sight (minimized, or a background tab). */
const documentHidden = (): boolean => typeof document !== 'undefined' && document.hidden;

export class FrameClock {
  private raf = 0;
  private worker: Worker | undefined;
  /** When the last animation frame came: the worker's ticks run frames only once they stop. */
  private lastAnimationFrame = 0;
  /** The last time given to `tick`: frames get times that never go back. */
  private lastTime = 0;
  private running = false;
  /** Frames run on the worker's ticks (the window was out of sight), for tests and the log. */
  ticked = 0;

  constructor(
    private tick: (now: number, draw: boolean) => void,
    private o: { tickMs?: number; stallMs?: number } = {},
  ) {}

  private run(animationFrame: boolean): void {
    // One clock for both sources (an animation frame's own time is that frame's start).
    const now = Math.max(performance.now(), this.lastTime);
    this.lastTime = now;
    this.tick(now, animationFrame && !documentHidden());
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const frame = (): void => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(frame);
      this.lastAnimationFrame = performance.now();
      this.run(true);
    };
    this.raf = requestAnimationFrame(frame);
    this.lastAnimationFrame = performance.now();
    try {
      this.worker ??= new Worker(new URL('./tickWorker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = () => {
        if (!this.running) return;
        if (performance.now() - this.lastAnimationFrame < (this.o.stallMs ?? 100)) return;
        this.ticked++;
        this.run(false);
      };
      this.worker.postMessage({ interval: this.o.tickMs ?? 33 });
    } catch {
      // No workers (an old browser): animation frames only, as before.
      this.worker = undefined;
    }
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.worker?.postMessage({ interval: 0 });
  }
}
