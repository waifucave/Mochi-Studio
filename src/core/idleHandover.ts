/**
 * Tracking wins over the idle animation: a parameter that a mapping drives with a value from
 * tracking or a plugin (or that an agent sets) keeps the idle animation off,
 * through Mochi2D's idle weights. Every handover fades:
 *
 * - when a value arrives, the parameter's idle weight fades from 1 to 0, so
 *   the pose moves from the idle animation to the tracked value;
 * - when values stop (the face is lost, a plugin stops), the weight fades
 *   back to 1, and the last value is held as the base value meanwhile,
 *   fading to the parameter's default, so nothing jumps.
 *
 * Pure: the studio feeds it each frame's values and applies what it returns.
 */

/** How long a handover takes. No duration is documented: about half a second. */
export const HANDOVER_MS = 500;
/** The longest handover the setting allows. */
export const HANDOVER_MAX_MS = 5000;

/** Snaps to the ends, so a finished fade is exactly 0 or 1 (1 is Mochi2D's bit-for-bit default). */
const clamp01 = (v: number): number => (v < 1e-6 ? 0 : v > 1 - 1e-6 ? 1 : v);

interface Entry {
  /** The idle weight now: 0 tracking only, 1 the idle animation as usual. */
  w: number;
  /** The last value written. */
  last: number;
  /** 0 while values arrive; rises to 1 after they stop (the held value reaches the default). */
  hold: number;
}

export interface HandoverFrame {
  /** Base values to write: this frame's, plus held ones fading to their defaults. */
  values: Record<string, number>;
  /** Idle weights that changed this frame. */
  weights: Record<string, number>;
}

export class IdleHandover {
  private entries = new Map<string, Entry>();

  constructor(public fadeMs = HANDOVER_MS) {}

  /**
   * One frame.
   * @param driven base values written now (after physics redirects)
   * @param defaults each parameter's default value
   * @param dt milliseconds since the last frame
   */
  step(
    driven: Readonly<Record<string, number>>,
    defaults: (id: string) => number | undefined,
    dt: number,
  ): HandoverFrame {
    const k = this.fadeMs > 0 ? Math.max(0, dt) / this.fadeMs : 1;
    const values: Record<string, number> = { ...driven };
    const weights: Record<string, number> = {};
    for (const [id, v] of Object.entries(driven)) {
      let e = this.entries.get(id);
      if (!e) this.entries.set(id, (e = { w: 1, last: v, hold: 0 }));
      e.last = v;
      e.hold = 0;
      const w = clamp01(e.w - k);
      if (w !== e.w) weights[id] = e.w = w;
    }
    for (const [id, e] of this.entries) {
      if (id in driven) continue;
      e.hold = clamp01(e.hold + k);
      const w = clamp01(e.w + k);
      if (w !== e.w) weights[id] = e.w = w;
      if (e.hold >= 1 && e.w >= 1) {
        // Handed over: the idle animation (or the default) has the parameter again.
        this.entries.delete(id);
        continue;
      }
      const d = defaults(id);
      values[id] = d === undefined ? e.last : e.last + (d - e.last) * e.hold;
    }
    return { values, weights };
  }

  /** A parameter's idle weight now (1 when nothing drives it). */
  weight(id: string): number {
    return this.entries.get(id)?.w ?? 1;
  }

  /** Every weight below 1, for an output view that joins late. */
  weights(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [id, e] of this.entries) if (e.w < 1) out[id] = e.w;
    return out;
  }

  /** A new model: nothing is driven, every weight is 1 again. */
  reset(): void {
    this.entries.clear();
  }
}
