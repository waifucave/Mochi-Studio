import { describe, expect, it } from 'vitest';
import {
  MappingEngine,
  defaultRules,
  evaluateRule,
  isSoundInput,
  makeRule,
  ruleSmoother,
} from './mapping';

describe('evaluateRule', () => {
  const r = makeRule({ input: 'a', output: 'P', inMin: 0, inMax: 1, outMin: -30, outMax: 30 });
  it('remaps linearly', () => {
    expect(evaluateRule(r, 0.5)).toBe(0);
    expect(evaluateRule(r, 1)).toBe(30);
  });
  it('clamps or extrapolates', () => {
    expect(evaluateRule(r, 2)).toBe(30);
    expect(evaluateRule({ ...r, clamp: false }, 2)).toBe(90);
  });
  it('inverts within the output range', () => {
    expect(evaluateRule({ ...r, invert: true }, 1)).toBe(-30);
    expect(evaluateRule({ ...r, invert: true, outMin: 0, outMax: 1 }, 0.25)).toBe(0.75);
  });
  it('handles a reversed and an empty input range', () => {
    expect(evaluateRule({ ...r, inMin: 1, inMax: 0 }, 1)).toBe(-30);
    expect(evaluateRule({ ...r, inMin: 1, inMax: 1 }, 5)).toBe(-30);
  });
});

describe('defaultRules', () => {
  it('keeps only parameters the model has', () => {
    const rules = defaultRules(['ParamAngleX', 'ParamMouthOpenY', 'Other']);
    expect(rules.map((r) => r.output).sort()).toEqual(['ParamAngleX', 'ParamMouthOpenY']);
  });
});

describe('MappingEngine', () => {
  it('adds rules that target the same parameter and skips disabled ones', () => {
    const e = new MappingEngine([
      makeRule({ input: 'a', output: 'P' }),
      makeRule({ input: 'b', output: 'P' }),
      makeRule({ input: 'b', output: 'Q', enabled: false }),
    ]);
    expect(e.evaluate({ a: 0.25, b: 0.5 }, 0)).toEqual({ P: 0.75 });
  });
  it('smooths per rule', () => {
    const e = new MappingEngine([makeRule({ input: 'a', output: 'P', smoothing: 1 })]);
    e.evaluate({ a: 0 }, 0);
    const v = e.evaluate({ a: 1 }, 100).P!;
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(0.3);
  });
  it('limits the rate of the voice inputs, rising faster than falling, and keeps the filter for the rest', () => {
    for (const id of [
      'VoiceA',
      'VoiceO',
      'VoiceSilence',
      'VoiceVolume',
      'VoiceFrequency',
      'VoiceVolumePlusMouthOpen',
    ])
      expect(ruleSmoother({ input: id }), id).toBe('rate');
    for (const id of ['MouthOpen', 'FaceAngleX', 'bs.jawOpen', 'Voice'])
      expect(ruleSmoother({ input: id }), id).toBe('exponential');
    expect(isSoundInput('VoiceE')).toBe(true);
    expect(ruleSmoother({ input: 'VoiceA', smoother: 'exponential' })).toBe('exponential');
    expect(ruleSmoother({ input: 'MouthOpen', smoother: 'rate' })).toBe('rate');

    // Smoothing 0.4: a full swing in 100 ms up, 200 ms down.
    const e = new MappingEngine([
      makeRule({ input: 'VoiceA', output: 'P', smoothing: 0.4 }),
      makeRule({ input: 'MouthOpen', output: 'Q', smoothing: 0.4 }),
    ]);
    e.evaluate({ VoiceA: 0, MouthOpen: 0 }, 0);
    const up = e.evaluate({ VoiceA: 1, MouthOpen: 1 }, 50);
    expect(up.P).toBeCloseTo(0.5, 6); // half the swing in half the time: linear, not eased
    expect(up.Q).toBeCloseTo(1 - Math.exp(-50 / 200), 6); // the exponential filter as before
    expect(e.evaluate({ VoiceA: 1, MouthOpen: 1 }, 100).P).toBeCloseTo(1, 6); // there, and no overshoot
    expect(e.evaluate({ VoiceA: 1, MouthOpen: 1 }, 150).P).toBe(1);
    // Falling takes twice as long.
    expect(e.evaluate({ VoiceA: 0, MouthOpen: 0 }, 200).P).toBeCloseTo(0.75, 6);
    // A change smaller than the step passes at once, where the filter would ease it.
    const small = new MappingEngine([makeRule({ input: 'VoiceA', output: 'P', smoothing: 0.4 })]);
    small.evaluate({ VoiceA: 0.5 }, 0);
    expect(small.evaluate({ VoiceA: 0.52 }, 16).P).toBeCloseTo(0.52, 6);
    // The swing is the rule's output range: twice the range, twice the speed.
    const wide = new MappingEngine([
      makeRule({ input: 'VoiceA', output: 'P', smoothing: 0.4, outMin: 0, outMax: 2 }),
    ]);
    wide.evaluate({ VoiceA: 0 }, 0);
    expect(wide.evaluate({ VoiceA: 1 }, 50).P).toBeCloseTo(1, 6);
  });
  it('switches smoother when a rule changes its choice', () => {
    const r = makeRule({ input: 'VoiceA', output: 'P', smoothing: 1 });
    expect(makeRule({ ...r, smoother: 'bogus' as never }).smoother).toBeUndefined();
    const e = new MappingEngine([r]);
    e.evaluate({ VoiceA: 0 }, 0);
    expect(e.evaluate({ VoiceA: 1 }, 50).P).toBeCloseTo(0.2, 6);
    e.setRules([{ ...r, smoother: 'exponential' }]);
    // A new smoother starts where the input is.
    expect(e.evaluate({ VoiceA: 1 }, 100).P).toBe(1);
  });
});
