/**
 * Keeps the app answering whatever an output costs. Outputs drawn in a hidden
 * page and read back (Spout2, the virtual camera, web items) share the
 * graphics process with the app's window; where it draws in software, a large
 * output at full rate left the window without an answer for a minute.
 *
 * The desktop app asks its window, a few times a second, to answer a trivial
 * call, and gives each output's governor how long that took. While the window
 * is slow, the governor halves the output's frame rate (down to MIN_FPS); a
 * paint that comes sooner than the rate allows is skipped, never queued. While
 * the window answers quickly, the rate goes back up, more slowly each time it
 * had to come down. Once an output has been held below its rate for a while,
 * the person is told, once.
 */

/** The window took this long to answer: the outputs are too much for this computer. */
export const SLOW_MS = 250;
/** Answering faster than this: room to raise the rate. */
export const EASY_MS = 100;
/** The lowest rate an output is held to, before it is paused. */
export const MIN_FPS = 2;
/**
 * Still slow this long at MIN_FPS: the output is paused (0, no frames drawn or sent; receivers
 * keep its last one) until the window and the main process answer quickly again. On the runner,
 * with the window shown, the main process was late by seconds with an output at 2 frames a
 * second.
 */
export const PAUSE_AFTER_MS = 2000;
/** An output starts at no more than this, and goes up while the window keeps answering. */
export const START_FPS = 15;
/** The least time between two steps down (each step takes a moment to show). */
export const LOWER_EVERY_MS = 500;
/** How long the window must answer quickly before a step up; doubled after each step down. */
export const RAISE_AFTER_MS = 2000;
export const RAISE_AFTER_MAX_MS = 60_000;
/** Held below its rate this long: the person is told. */
export const TELL_AFTER_MS = 5000;
/**
 * The frames sent are counted over this long. An output that sends less than half its allowed
 * rate is held too, whatever the reason: on the runner, with the window shown and drawing its
 * own stage in software, a 1920 × 1080 output sent one frame a minute while the window answered
 * in milliseconds.
 */
export const RATE_WINDOW_MS = 5000;

/** A rate in words: "less than 1" below one frame a second, else whole frames. */
export function rateText(fps: number): string {
  return fps < 1 ? 'less than 1' : String(Math.round(fps));
}

/**
 * The rate an output of this size begins at: START_FPS up to 1280 × 720, less for a larger one
 * (in proportion to its pixels), so that the first second does not stop the window either.
 */
export function startFps(width: number, height: number): number {
  const k = Math.min(1, (1280 * 720) / Math.max(1, width * height));
  return Math.max(MIN_FPS, Math.round(START_FPS * k));
}

export interface GovernorHooks {
  /** Sets the output page's frame rate (called outside its paint events). */
  apply(fps: number): void;
  /** Tells the person, once per output, at which rate it is held. */
  tell(fps: number): void;
}

export class FrameGovernor {
  /** The rate asked for (the stage's, the camera's). */
  wanted: number;
  /** The rate allowed now. */
  fps: number;
  private lastLower = -Infinity;
  private easySince: number | undefined;
  private raiseAfter = RAISE_AFTER_MS;
  private limitedSince: number | undefined;
  private told = false;
  private lastSent = -Infinity;
  private firstSent: number | undefined;
  private readonly sentTimes: number[] = [];
  private starvedSince: number | undefined;
  private readonly hooks: GovernorHooks;
  private readonly now: () => number;
  private readonly watchRate: boolean;

  /**
   * `start`: the rate to begin at (startFps(), for the output's size). `watchRate`: whether an
   * output sending far below its allowed rate counts as held (not for a page that paints only
   * when it changes, such as a web item).
   */
  constructor(
    wanted: number,
    hooks: GovernorHooks,
    start = START_FPS,
    now: () => number = () => performance.now(),
    watchRate = true,
  ) {
    this.hooks = hooks;
    this.now = now;
    this.watchRate = watchRate;
    this.wanted = Math.max(1, Math.round(wanted));
    this.fps = Math.max(1, Math.min(this.wanted, Math.round(start)));
  }

  /**
   * Held: brought down because the window was slow, and still below the rate asked for; or
   * sending less than half its allowed rate.
   */
  get held(): boolean {
    return this.limitedSince !== undefined || this.starvedSince !== undefined;
  }

  /** The frames sent a second, over the last RATE_WINDOW_MS (once it has sent that long). */
  get sentRate(): number | undefined {
    const t = this.now();
    if (this.firstSent === undefined || t - this.firstSent < RATE_WINDOW_MS) return undefined;
    const since = t - RATE_WINDOW_MS;
    while (this.sentTimes.length && this.sentTimes[0]! < since) this.sentTimes.shift();
    return this.sentTimes.length / (RATE_WINDOW_MS / 1000);
  }

  /** The rate it sends at now: the allowed one, or less when it gets fewer frames. */
  get sendingFps(): number {
    const r = this.sentRate;
    return r === undefined ? this.fps : Math.round(Math.min(this.fps, r) * 10) / 10;
  }

  /** A new rate asked for: kept below it if the window was slow, else taken. */
  setWanted(fps: number): void {
    const wanted = Math.max(1, Math.round(fps));
    if (wanted === this.wanted) return;
    this.fps = this.held
      ? Math.min(this.fps, wanted)
      : Math.min(wanted, Math.max(this.fps, START_FPS));
    if (this.fps >= wanted) this.limitedSince = undefined;
    this.wanted = wanted;
    this.hooks.apply(this.fps);
  }

  /** How long the window took to answer (or has been waiting). */
  sample(ms: number): void {
    const t = this.now();
    // Getting far fewer frames than allowed (starved): brought down to about what it gets, as
    // for a slow window, and never raised meanwhile. On the runner, a starved 1920 × 1080 output
    // was raised to 60 while it got almost none; then its frames came all at once, and the main
    // process was late by 1.5 s.
    const got = this.watchRate ? this.sentRate : undefined;
    if (got !== undefined && got < this.fps / 2 && t - this.lastLower >= LOWER_EVERY_MS * 4) {
      const fps = Math.max(MIN_FPS, Math.ceil(got * 1.5));
      if (fps < this.fps) {
        this.fps = fps;
        this.lastLower = t;
        this.raiseAfter = Math.min(RAISE_AFTER_MAX_MS, this.raiseAfter * 2);
        this.limitedSince ??= t;
        this.hooks.apply(this.fps);
      }
    }
    if (ms >= SLOW_MS) {
      this.easySince = undefined;
      const pause = this.fps === MIN_FPS && t - this.lastLower >= PAUSE_AFTER_MS;
      if ((t - this.lastLower >= LOWER_EVERY_MS && this.fps > MIN_FPS) || pause) {
        this.fps = pause ? 0 : Math.max(MIN_FPS, Math.floor(this.fps / 2));
        this.lastLower = t;
        this.raiseAfter = Math.min(RAISE_AFTER_MAX_MS, this.raiseAfter * 2);
        this.limitedSince ??= t;
        this.hooks.apply(this.fps);
      }
    } else if (ms < EASY_MS) {
      this.easySince ??= t;
      const starved = got !== undefined && got < this.fps / 2;
      if (this.fps < this.wanted && !starved && t - this.easySince >= this.raiseAfter) {
        this.fps = this.fps === 0 ? MIN_FPS : Math.min(this.wanted, Math.ceil(this.fps * 1.5));
        this.easySince = t;
        if (this.fps >= this.wanted) this.limitedSince = undefined;
        this.hooks.apply(this.fps);
      }
    } else {
      this.easySince = undefined;
    }
    const r = this.watchRate ? this.sentRate : undefined;
    if (r !== undefined && r < this.fps / 2) this.starvedSince ??= t;
    else this.starvedSince = undefined;
    // Told once the output has been held below its rate for a while.
    const since = Math.min(this.limitedSince ?? Infinity, this.starvedSince ?? Infinity);
    if (!this.told && t - since >= TELL_AFTER_MS) {
      this.told = true;
      this.hooks.tell(this.sendingFps);
    }
  }

  /** Whether a paint now is sent; one that comes sooner than the rate allows is skipped. */
  allow(): boolean {
    const t = this.now();
    if (this.fps <= 0 || t - this.lastSent < 1000 / this.fps - 5) return false;
    this.lastSent = t;
    this.firstSent ??= t;
    this.sentTimes.push(t);
    if (this.sentTimes.length > 600) this.sentTimes.splice(0, this.sentTimes.length - 600);
    return true;
  }
}
