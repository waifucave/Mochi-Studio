import { describe, expect, it } from 'vitest';
import { combineMouth, meterFraction, mixMouth, type LipSyncSettings } from './lipSync';

const s = (
  mode: LipSyncSettings['mode'],
  extra: Partial<LipSyncSettings> = {},
): LipSyncSettings => ({
  type: 'simple',
  voiceProcessing: false,
  mode,
  weight: 0.5,
  gain: 1,
  gate: -45,
  ...extra,
});

describe('combineMouth', () => {
  it.each([
    ['tracking', 0.2],
    ['microphone', 0.6],
    ['max', 0.6],
    ['add', 0.8],
    ['blend', 0.4],
  ] as const)('%s', (mode, expected) => {
    expect(combineMouth(0.2, 0.6, s(mode))).toBeCloseTo(expected);
  });
  it('clamps add and applies gain', () => {
    expect(combineMouth(0.7, 0.6, s('add'))).toBe(1);
    expect(combineMouth(0, 0.3, s('microphone', { gain: 2 }))).toBeCloseTo(0.6);
  });
  it('falls back to whichever source is available', () => {
    expect(combineMouth(undefined, 0.5, s('tracking'))).toBe(0.5);
    expect(combineMouth(0.3, undefined, s('microphone'))).toBe(0.3);
    expect(combineMouth(undefined, undefined, s('max'))).toBeUndefined();
  });
});

/**
 * A model of Mochi2D's live lip sync: the live value scales with the
 * sensitivity and is added to the base, or the larger of the two is taken
 * (mix "max"), limited to the range.
 */
function simulate(
  mode: LipSyncSettings['mode'],
  tracked: number | undefined,
  mic: number,
  extra: Partial<LipSyncSettings> = {},
  range = { min: 0, max: 1 },
): number {
  const settings = s(mode, extra);
  // Frame 1 sets the sensitivity; frame 2 sees the live value it gives.
  let live = mic * settings.gain;
  let mix = mixMouth(tracked, live, settings, range);
  for (let i = 0; i < 3; i++) {
    live = mic * mix.liveGain;
    mix = mixMouth(tracked, live, settings, range);
  }
  const base = mix.base ?? range.min;
  const v = mix.mix === 'max' ? Math.max(base, live) : base + live;
  return Math.min(range.max, Math.max(range.min, v));
}

describe('meterFraction', () => {
  it('shows −80…0 dBFS', () => {
    expect(meterFraction(-Infinity)).toBe(0);
    expect(meterFraction(-80)).toBe(0);
    expect(meterFraction(-40)).toBeCloseTo(0.5);
    expect(meterFraction(3)).toBe(1);
  });
});

describe('mixMouth with Mochi2D live lip sync', () => {
  it.each([
    ['tracking', 0.2],
    ['microphone', 0.6],
    ['max', 0.6],
    ['add', 0.8],
    ['blend', 0.4],
  ] as const)('%s gives the same result as combineMouth', (mode, expected) => {
    expect(simulate(mode, 0.2, 0.6)).toBeCloseTo(expected);
  });
  it('max keeps the tracked value when it is larger, in the same frame', () => {
    expect(simulate('max', 0.9, 0.3)).toBeCloseTo(0.9);
    // Exact: no dependence on the previous frame's live value.
    expect(mixMouth(0.5, 0.7, s('max'), { min: 0, max: 1 })).toEqual({
      base: 0.5,
      liveGain: 1,
      mix: 'max',
      value: 0.7,
    });
  });
  it('blend weights 0 and 1', () => {
    expect(simulate('blend', 0.2, 0.6, { weight: 0 })).toBeCloseTo(0.2);
    expect(simulate('blend', 0.2, 0.6, { weight: 1 })).toBeCloseTo(0.6);
  });
  it('uses the microphone alone without a face, and tracking alone without a microphone', () => {
    expect(simulate('blend', undefined, 0.6)).toBeCloseTo(0.6);
    expect(simulate('add', undefined, 0.5)).toBeCloseTo(0.5);
    expect(mixMouth(0.4, undefined, s('microphone'), { min: 0, max: 1 })).toEqual({
      base: 0.4,
      liveGain: 1,
      mix: 'add',
      value: 0.4,
    });
  });
  it('silences the microphone in tracking mode and passes the gain on', () => {
    expect(mixMouth(0.3, 0.5, s('tracking'), { min: 0, max: 1 }).liveGain).toBe(0);
    expect(mixMouth(0.3, 0.5, s('add', { gain: 2 }), { min: 0, max: 1 }).liveGain).toBe(2);
  });
  it('works relative to a range that does not start at 0', () => {
    const r = { min: -1, max: 1 };
    expect(simulate('microphone', 0.5, 0.4, {}, r)).toBeCloseTo(-0.6);
    expect(simulate('blend', 0, 1, { weight: 0.5 }, r)).toBeCloseTo(0);
  });
});
