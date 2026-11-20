/**
 * One Euro filter (Casiez, Roussel and Vogel, CHI 2012).
 *
 * An adaptive low-pass filter: at low speeds it smooths strongly (cutoff near
 * `minCutoff`) to remove jitter; at high speeds the cutoff rises with
 * `beta * |speed|` so that fast head movements are not delayed.
 *
 * - `minCutoff` (Hz): lower = smoother when still, more lag.
 * - `beta`: higher = less lag on fast motion, more jitter.
 * - `dCutoff` (Hz): cutoff for the speed estimate itself.
 */
export interface OneEuroParams {
  minCutoff: number;
  beta: number;
  dCutoff: number;
}

export const DEFAULT_ONE_EURO: OneEuroParams = { minCutoff: 1.5, beta: 0.02, dCutoff: 1 };

function alpha(cutoff: number, dt: number): number {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

export class OneEuroFilter {
  private x: number | undefined;
  private dx = 0;
  private lastT: number | undefined;

  constructor(public params: OneEuroParams = DEFAULT_ONE_EURO) {}

  reset(): void {
    this.x = undefined;
    this.dx = 0;
    this.lastT = undefined;
  }

  /** @param t timestamp in milliseconds */
  filter(value: number, t: number): number {
    if (this.x === undefined || this.lastT === undefined) {
      this.x = value;
      this.lastT = t;
      return value;
    }
    if (t <= this.lastT) return this.x;
    const dt = (t - this.lastT) / 1000;
    this.lastT = t;
    const { minCutoff, beta, dCutoff } = this.params;
    const rawDx = (value - this.x) / dt;
    const ad = alpha(dCutoff, dt);
    this.dx = this.dx + ad * (rawDx - this.dx);
    const cutoff = minCutoff + beta * Math.abs(this.dx);
    const a = alpha(cutoff, dt);
    this.x = this.x + a * (value - this.x);
    return this.x;
  }
}

/** A One Euro filter per named channel. */
export class ChannelFilters {
  private filters = new Map<string, OneEuroFilter>();

  constructor(private params: OneEuroParams = DEFAULT_ONE_EURO) {}

  setParams(p: OneEuroParams): void {
    this.params = p;
    for (const f of this.filters.values()) f.params = p;
  }

  reset(): void {
    this.filters.clear();
  }

  apply(values: Record<string, number>, t: number): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(values)) {
      let f = this.filters.get(k);
      if (!f) {
        f = new OneEuroFilter(this.params);
        this.filters.set(k, f);
      }
      out[k] = f.filter(v, t);
    }
    return out;
  }
}

/**
 * Frame-rate independent exponential smoothing used per mapping rule.
 * `smoothing` in [0, 1] maps to a time constant of `smoothing * 500 ms`.
 */
export class ExpSmoother {
  private value: number | undefined;
  private lastT: number | undefined;

  reset(): void {
    this.value = undefined;
    this.lastT = undefined;
  }

  step(target: number, smoothing: number, t: number): number {
    if (this.value === undefined || this.lastT === undefined || smoothing <= 0) {
      this.value = target;
      this.lastT = t;
      return target;
    }
    const dt = Math.max(0, t - this.lastT);
    this.lastT = t;
    const tau = Math.min(1, smoothing) * 500;
    const a = 1 - Math.exp(-dt / tau);
    this.value = this.value + a * (target - this.value);
    return this.value;
  }
}

/**
 * A rate limit with separate rise and fall, for inputs that come from sound
 * (the voice inputs). An exponential filter rounds off every syllable and
 * lags most when the mouth moves most; a rate limit lets small changes
 * through at once and only caps how fast the value can travel, so the mouth
 * opens quickly and closes a little more slowly, as speech looks.
 *
 * `smoothing` in [0, 1] sets the time for a full swing (the rule's output
 * range): `smoothing * RISE_MS` going up and `smoothing * FALL_MS` going
 * down. 0 is none.
 */
export class RateSmoother {
  static readonly RISE_MS = 250;
  static readonly FALL_MS = 500;
  private value: number | undefined;
  private lastT: number | undefined;

  reset(): void {
    this.value = undefined;
    this.lastT = undefined;
  }

  step(target: number, smoothing: number, t: number, swing = 1): number {
    if (this.value === undefined || this.lastT === undefined || smoothing <= 0) {
      this.value = target;
      this.lastT = t;
      return target;
    }
    const dt = Math.max(0, t - this.lastT);
    this.lastT = t;
    const s = Math.min(1, smoothing);
    const full = Math.abs(swing) || 1;
    const d = target - this.value;
    const limit = (full * dt) / (s * (d > 0 ? RateSmoother.RISE_MS : RateSmoother.FALL_MS));
    this.value += Math.max(-limit, Math.min(limit, d));
    return this.value;
  }
}
