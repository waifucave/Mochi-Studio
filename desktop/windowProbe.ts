/**
 * How quickly the app's window answers: four times a second, a trivial call
 * into its page, timed from the main process. A call still waiting counts as
 * a sample of how long it has waited, so a window that stopped answering is
 * seen at once, not when it answers again. The outputs that draw hidden pages
 * (Spout2, the virtual camera, web items) take each sample to their frame
 * governors (src/core/frameGovernor.ts).
 */
import type { WebContents } from 'electron';
import { appendFileSync } from 'node:fs';
import { SLOW_MS } from '../src/core/frameGovernor.ts';

export const PROBE_EVERY_MS = 250;

/**
 * Sets a hidden page's frame rate: its paints (setFrameRate), and, for the app's own output
 * page, how often it draws (its cap), since drawing is the cost, and a page draws on its
 * animation frames whatever its paint rate.
 */
export function setPageRate(wc: WebContents, fps: number, ownPage = true): void {
  if (wc.isDestroyed()) return;
  // 0: paused, no paints (a receiver keeps the last frame); the page draws once a second.
  if (fps <= 0) wc.stopPainting();
  else {
    if (!wc.isPainting()) wc.startPainting();
    wc.setFrameRate(fps);
  }
  if (!ownPage) return;
  wc.executeJavaScript(`window.mochiOutput?.setHostCap?.(${Math.max(1, Math.round(fps))})`).catch(
    () => {
      /* loading, or gone */
    },
  );
}

export class WindowProbe {
  /** The app's window (the tests reach it through this too). */
  readonly target: () => WebContents | undefined;
  private readonly listeners = new Set<(ms: number) => void>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private waitingSince: number | undefined;
  /**
   * The last two minutes of samples (for the tests and the state): [time, ms, and the frames
   * the window had drawn by then (when it answered)].
   */
  readonly samples: Array<[number, number, number?]> = [];

  constructor(target: () => WebContents | undefined) {
    this.target = target;
    // For the tests' record: sampled from the start, outputs or not (a control to compare with).
    if (this.file) this.add(() => undefined);
  }

  /** Starts sampling for this listener (the first one starts the timer). */
  add(fn: (ms: number) => void): void {
    this.listeners.add(fn);
    if (!this.timer) {
      this.lastTick = undefined;
      this.timer = setInterval(() => this.tick(), PROBE_EVERY_MS);
    }
  }

  remove(fn: (ms: number) => void): void {
    this.listeners.delete(fn);
    if (!this.listeners.size && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** The longest sample in the last `ms` milliseconds. */
  max(ms = 5000): number {
    const since = performance.now() - ms;
    return Math.round(this.samples.reduce((m, [t, v]) => (t >= since ? Math.max(m, v) : m), 0));
  }

  private emit(ms: number, frames?: number): void {
    const now = performance.now();
    this.samples.push(frames === undefined ? [now, ms] : [now, ms, frames]);
    if (this.file) {
      try {
        const line = {
          t: Date.now(),
          ms: Math.round(ms),
          late: Math.round(this.late),
          frames,
          extra: this.extra?.(),
        };
        appendFileSync(this.file, `${JSON.stringify(line)}\n`);
      } catch {
        /* the tests' file only */
      }
    }
    while (this.samples.length && this.samples[0]![0] < now - 120_000) this.samples.shift();
    for (const fn of this.listeners) fn(ms);
  }

  /** Ticks while the window said it was loading (it is asked all the same). */
  loadingTicks = 0;
  /**
   * For the tests: with MOCHI_PROBE_FILE set, each sample is also appended to that file as a
   * JSON line (wall-clock time, ms, frames, and what `extra` gives), so that a test can read
   * them whatever its own connections to the app do.
   */
  extra: (() => unknown) | undefined;
  private readonly file = process.env.MOCHI_PROBE_FILE;

  private lastTick: number | undefined;
  /** The main process's own lateness: how much later than due the last tick came. */
  late = 0;

  private tick(): void {
    const t = performance.now();
    // A tick that comes late means the main process was busy that long (on the runner, up to
    // 3.5 s with a 1920 × 1080 output): the outputs come down for that too, as for a slow window.
    this.late = this.lastTick === undefined ? 0 : Math.max(0, t - this.lastTick - PROBE_EVERY_MS);
    this.lastTick = t;
    if (this.late >= SLOW_MS) for (const fn of this.listeners) fn(this.late);
    const wc = this.target();
    if (!wc || wc.isDestroyed()) return;
    if (wc.isLoading()) this.loadingTicks++;
    if (this.waitingSince !== undefined) {
      this.emit(t - this.waitingSince);
      return;
    }
    this.waitingSince = t;
    // The answer: how many frames the window has drawn (it draws its stage while shown).
    // The main frame's own call: WebContents.executeJavaScript waits while the page says it is
    // loading, which on the runner held calls for seconds while the window answered this one.
    wc.mainFrame.executeJavaScript('window.mochiStudio?.framesDrawn ?? -1').then(
      (frames: unknown) => {
        this.waitingSince = undefined;
        this.emit(performance.now() - t, typeof frames === 'number' ? frames : undefined);
      },
      () => {
        this.waitingSince = undefined;
      },
    );
  }
}
