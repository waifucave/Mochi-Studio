import { describe, expect, it } from 'vitest';
import { ExpSmoother, OneEuroFilter } from './filter';

describe('OneEuroFilter', () => {
  it('passes the first value and converges on a constant', () => {
    const f = new OneEuroFilter();
    expect(f.filter(5, 0)).toBe(5);
    let v = 5;
    for (let i = 1; i <= 100; i++) v = f.filter(10, i * 16);
    expect(v).toBeCloseTo(10, 3);
  });

  it('reduces jitter on a still signal', () => {
    const f = new OneEuroFilter({ minCutoff: 1, beta: 0, dCutoff: 1 });
    const out: number[] = [];
    for (let i = 0; i < 200; i++) out.push(f.filter(i % 2 ? 1 : -1, i * 16));
    const tail = out.slice(100);
    expect(Math.max(...tail) - Math.min(...tail)).toBeLessThan(0.3);
  });

  it('lags less on fast motion with a higher beta', () => {
    const run = (beta: number): number => {
      const f = new OneEuroFilter({ minCutoff: 1, beta, dCutoff: 1 });
      let v = 0;
      for (let i = 0; i <= 10; i++) v = f.filter(i * 3, i * 16);
      return 30 - v;
    };
    expect(run(0.5)).toBeLessThan(run(0));
  });

  it('ignores non-increasing timestamps', () => {
    const f = new OneEuroFilter();
    f.filter(1, 10);
    expect(f.filter(100, 10)).toBe(1);
  });
});

describe('ExpSmoother', () => {
  it('is a pass-through with smoothing 0', () => {
    const s = new ExpSmoother();
    s.step(0, 0, 0);
    expect(s.step(1, 0, 16)).toBe(1);
  });

  it('is frame-rate independent', () => {
    const a = new ExpSmoother();
    const b = new ExpSmoother();
    a.step(0, 0.5, 0);
    b.step(0, 0.5, 0);
    let va = 0,
      vb = 0;
    for (let t = 10; t <= 200; t += 10) va = a.step(1, 0.5, t);
    for (let t = 40; t <= 200; t += 40) vb = b.step(1, 0.5, t);
    expect(va).toBeCloseTo(vb, 6);
    expect(va).toBeCloseTo(1 - Math.exp(-200 / 250), 6);
  });
});
