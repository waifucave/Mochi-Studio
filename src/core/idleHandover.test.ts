import { describe, expect, it } from 'vitest';
import { IdleHandover } from './idleHandover';

const defaults = (id: string): number | undefined => (id === 'ParamAngleX' ? 0 : undefined);

describe('the handover between tracking and the idle animation', () => {
  it('fades the idle weight to 0 while values arrive', () => {
    const h = new IdleHandover(500);
    let f = h.step({ ParamAngleX: 10 }, defaults, 100);
    expect(f.values).toEqual({ ParamAngleX: 10 });
    expect(f.weights.ParamAngleX).toBeCloseTo(0.8);
    for (let i = 0; i < 4; i++) f = h.step({ ParamAngleX: 10 }, defaults, 100);
    expect(h.weight('ParamAngleX')).toBe(0);
    // Unchanged weights are not reported again.
    expect(h.step({ ParamAngleX: 12 }, defaults, 100).weights).toEqual({});
    expect(h.weights()).toEqual({ ParamAngleX: 0 });
  });

  it('holds the last value, fading to the default, while the idle animation comes back', () => {
    const h = new IdleHandover(500);
    for (let i = 0; i < 10; i++) h.step({ ParamAngleX: 20 }, defaults, 100);
    let f = h.step({}, defaults, 100);
    expect(f.values.ParamAngleX).toBeCloseTo(16);
    expect(f.weights.ParamAngleX).toBeCloseTo(0.2);
    f = h.step({}, defaults, 200);
    expect(f.values.ParamAngleX).toBeCloseTo(8);
    expect(h.weight('ParamAngleX')).toBeCloseTo(0.6);
    // Handed over: the parameter is no longer written, and its weight is 1.
    f = h.step({}, defaults, 300);
    expect(f.values).toEqual({});
    expect(f.weights).toEqual({ ParamAngleX: 1 });
    expect(h.weight('ParamAngleX')).toBe(1);
    expect(h.weights()).toEqual({});
  });

  it('turns back smoothly when values return during a handover', () => {
    const h = new IdleHandover(500);
    for (let i = 0; i < 10; i++) h.step({ ParamAngleX: 20 }, defaults, 100);
    h.step({}, defaults, 200);
    expect(h.weight('ParamAngleX')).toBeCloseTo(0.4);
    const f = h.step({ ParamAngleX: 18 }, defaults, 100);
    expect(f.values).toEqual({ ParamAngleX: 18 });
    expect(h.weight('ParamAngleX')).toBeCloseTo(0.2);
  });

  it('keeps the last value for a parameter without a known default, and resets', () => {
    const h = new IdleHandover(500);
    h.step({ Custom: 3 }, defaults, 100);
    expect(h.step({}, defaults, 100).values).toEqual({ Custom: 3 });
    h.reset();
    expect(h.weight('Custom')).toBe(1);
    expect(h.step({}, defaults, 100).values).toEqual({});
  });
});
