import { clamp } from './math';
import { inputInfo, type InputValues } from './tracking';

/** Neutral value per input, captured while the user holds a relaxed, front-facing pose. */
export type Calibration = Record<string, number>;

/** Averages input samples into a neutral pose. */
export class CalibrationRecorder {
  private sums: Record<string, number> = {};
  private count = 0;

  add(values: InputValues): void {
    for (const [k, v] of Object.entries(values)) this.sums[k] = (this.sums[k] ?? 0) + v;
    this.count++;
  }

  get samples(): number {
    return this.count;
  }

  result(): Calibration {
    const out: Calibration = {};
    if (this.count === 0) return out;
    for (const [k, s] of Object.entries(this.sums)) out[k] = s / this.count;
    return out;
  }
}

/**
 * Applies a neutral-pose calibration:
 * - `centered` inputs: value - neutral;
 * - `open` inputs (rest = open): value / neutral, clamped to [0, 1];
 * - `closed` inputs (rest = closed): (value - neutral) / (1 - neutral), clamped to [0, 1].
 * Inputs without a neutral value pass through.
 */
export function applyCalibration(values: InputValues, cal: Calibration): InputValues {
  const out: InputValues = {};
  for (const [k, v] of Object.entries(values)) {
    const n = cal[k];
    const info = inputInfo(k);
    if (n === undefined || !info) {
      out[k] = v;
      continue;
    }
    switch (info.kind) {
      case 'centered':
        out[k] = v - n;
        break;
      case 'open':
        out[k] = n > 0.05 ? clamp(v / n, 0, 1) : v;
        break;
      case 'closed':
        out[k] = n < 0.95 ? clamp((v - n) / (1 - n), 0, 1) : v;
        break;
    }
  }
  return out;
}
