import { describe, expect, it } from 'vitest';
import { LATENESS_EVERY_MS, PageLateness } from './pageLateness';

describe('PageLateness', () => {
  it('keeps the latest timer of each second, for two minutes', () => {
    const p = new PageLateness();
    let now = 0;
    const wall0 = 1_000_000;
    // Four on time, then one 900 ms late (two seconds on).
    for (let i = 0; i < 4; i++) p.tick((now += LATENESS_EVERY_MS), wall0 + now);
    p.tick((now += LATENESS_EVERY_MS + 900), wall0 + now);
    expect(p.seconds).toEqual([
      [wall0, 0],
      [wall0 + 1000, 0],
      [wall0 + 2000, 900],
    ]);
    expect(p.between(wall0, wall0 + 3000)).toEqual({ worstMs: 900, seconds: 3 });
    expect(p.between(wall0, wall0 + 999)).toEqual({ worstMs: 0, seconds: 1 });
    for (let i = 0; i < 1000; i++) p.tick((now += LATENESS_EVERY_MS), wall0 + now);
    expect(p.seconds.length).toBe(120);
  });
});
