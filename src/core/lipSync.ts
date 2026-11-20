import type { FrequencyWeights } from './voice';
import { clamp } from './math';

/** How the microphone's lip-sync value combines with the tracked mouth opening. */
export type LipSyncMode =
  /** Only the camera. */
  | 'tracking'
  /** Only the microphone. */
  | 'microphone'
  /** The larger of the two. */
  | 'max'
  /** Their sum, clamped. */
  | 'add'
  /** A weighted blend: weight 0 = tracking, 1 = microphone. */
  | 'blend';

export const LIP_SYNC_MODES: readonly LipSyncMode[] = [
  'tracking',
  'microphone',
  'max',
  'add',
  'blend',
];

/**
 * The lipsync type: simple follows the volume
 * (Mochi2D's live lip sync); advanced also tells the vowels apart (Mochi2D's
 * motion-sync analysis), for the voice inputs and a model's own mouth shapes.
 */
export type LipSyncType = 'simple' | 'advanced';

export interface LipSyncSettings {
  type: LipSyncType;
  /**
   * Advanced: a setting of the model's motion-sync file that moves the
   * mouth with its own shapes (a dictionary name); undefined for the voice
   * inputs and the mapping only.
   */
  motionSync?: string;
  /**
   * Advanced: the browser's echo cancellation, noise suppression and gain
   * control on the microphone. Off by default (they blur the vowels); on
   * helps in noisy rooms.
   */
  voiceProcessing: boolean;
  /**
   * Advanced: the vowels shape the mouth form: I and E widen
   * it, U and O round it (src/core/voice.ts, `vowelMouthForm`). The
   * automatic setup turns it on for models without vowel parameters.
   * Undefined until the setup or the person decides; once decided, a later
   * switch to advanced leaves it as it is.
   */
  vowelForm?: boolean;
  /**
   * Advanced: how much each vowel moves the `VoiceFrequency` input
   * (src/core/voice.ts). Absent: Mochi Studio's defaults.
   */
  frequencyWeights?: FrequencyWeights;
  mode: LipSyncMode;
  /** For `blend`. */
  weight: number;
  /** Microphone sensitivity, relative to Mochi2D's default (1). */
  gain: number;
  /**
   * Noise gate in dBFS: quieter input leaves the mouth closed. Mochi2D's
   * default, −45 dBFS, suits speech at arm's length in a quiet room.
   */
  gate: number;
}

export const DEFAULT_LIP_SYNC: LipSyncSettings = {
  type: 'simple',
  voiceProcessing: false,
  mode: 'max',
  weight: 0.5,
  gain: 1,
  gate: -45,
};

/** The lowest level the input meter shows, in dBFS. */
export const METER_FLOOR_DB = -80;
export const GATE_MIN_DB = -80;
export const GATE_MAX_DB = -10;

/** An input level in dBFS as a fraction of the meter, from METER_FLOOR_DB (0) to 0 dBFS (1). */
export function meterFraction(db: number): number {
  if (!Number.isFinite(db)) return 0;
  return Math.min(1, Math.max(0, (db - METER_FLOOR_DB) / -METER_FLOOR_DB));
}

/**
 * Combines a tracked mouth opening and a microphone lip-sync value, both
 * normalised to [0, 1] of the output parameter's range. When either source
 * is unavailable (`undefined`), the other is used alone. This is the
 * intended result of each mode; `mixMouth` produces it with Mochi2D.
 */
export function combineMouth(
  tracked: number | undefined,
  mic: number | undefined,
  s: LipSyncSettings,
): number | undefined {
  const m = mic === undefined ? undefined : clamp(mic * s.gain, 0, 1);
  if (tracked === undefined && m === undefined) return undefined;
  if (s.mode === 'tracking') return tracked ?? (m as number);
  if (s.mode === 'microphone') return m ?? (tracked as number);
  if (tracked === undefined) return m;
  if (m === undefined) return tracked;
  switch (s.mode) {
    case 'max':
      return Math.max(tracked, m);
    case 'add':
      return clamp(tracked + m, 0, 1);
    case 'blend':
      return tracked + (m - tracked) * clamp(s.weight, 0, 1);
  }
}

export interface MouthMix {
  /** The mouth parameter's base value to set (undefined: leave it at its default). */
  base: number | undefined;
  /** The live lip-sync sensitivity to use from the next frame (1 = Mochi2D's default). */
  liveGain: number;
  /** How Mochi2D combines the live value with the base: added, or the larger of the two. */
  mix: 'add' | 'max';
  /** The resulting mouth value: base and the live value combined, within the range. */
  value: number | undefined;
}

/**
 * Mixes the tracked mouth with Mochi2D's live lip sync.
 *
 * Every frame, Mochi2D's live lip sync combines its value with the mouth
 * parameter's base value, limited to the parameter's range: added (mix
 * "add") or the larger of the two (mix "max"). So each mode is produced
 * with three controls: the base value Mochi Studio sets, the mix, and the
 * live lip sync's sensitivity:
 *
 * - tracking: sensitivity 0, base = tracked;
 * - microphone: base = the range's minimum;
 * - add: base = tracked;
 * - blend (weight w): sensitivity scaled by w and base = (1 − w) · tracked,
 *   both relative to the minimum; exact, because the live value is linear
 *   in the sensitivity;
 * - max: base = tracked, mix "max"; exact, in the same frame.
 *
 * Without a face, the microphone drives the mouth alone in every mode except
 * `tracking`; without the microphone, tracking does.
 *
 * @param tracked the mapped mouth value in parameter units, or undefined (no face)
 * @param live what lip sync added last frame, in parameter units, or undefined (microphone off)
 */
export function mixMouth(
  tracked: number | undefined,
  live: number | undefined,
  s: LipSyncSettings,
  range: { min: number; max: number },
): MouthMix {
  const gain = Math.max(0, s.gain);
  if (live === undefined || s.mode === 'tracking')
    return {
      base: tracked,
      liveGain: s.mode === 'tracking' ? 0 : gain,
      mix: s.mode === 'max' ? 'max' : 'add',
      value: tracked,
    };
  const { min, max } = range;
  const t = tracked === undefined ? undefined : clamp(tracked, min, max);
  let base: number;
  let liveGain = gain;
  if (s.mode === 'microphone' || t === undefined) base = min;
  else if (s.mode === 'add') base = t;
  else if (s.mode === 'max')
    return { base: t, liveGain, mix: 'max', value: clamp(Math.max(t, live), min, max) };
  else {
    const w = clamp(s.weight, 0, 1);
    liveGain = gain * w;
    base = min + (1 - w) * (t - min);
  }
  return { base, liveGain, mix: 'add', value: clamp(base + live, min, max) };
}
