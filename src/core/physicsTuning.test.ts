import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PHYSICS_TUNING,
  effectivePhysics,
  parsePhysicsTuning,
  PhysicsOverrides,
  physicsFpsSetting,
  physicsValues,
  windDirection,
  windGust,
} from './physicsTuning';

const groups = ['PhysicsSetting1', 'PhysicsSetting2'];
const plugin = { id: 'p1', name: 'Wind Machine', session: 's1' };
const other = { id: 'p2', name: 'Other', session: 's2' };

describe('physics strength and wind', () => {
  it('maps the person’s values onto Mochi2D’s', () => {
    expect(physicsValues(effectivePhysics(DEFAULT_PHYSICS_TUNING, groups))).toEqual({
      strength: 1,
      settings: {},
      wind: [0, 0],
    });
    const person = { strength: 25, wind: 40, groups: { PhysicsSetting2: 0, Gone: 2 } };
    expect(physicsValues(effectivePhysics(person, groups))).toEqual({
      strength: 0.5,
      settings: { PhysicsSetting2: 0 },
      wind: [0.4, 0],
    });
    expect(
      physicsValues(effectivePhysics({ ...person, strength: 100, wind: 100 }, [])).wind,
    ).toEqual([1, 0]);
  });

  it('keeps the physics rate chosen, and reports it as the plugin API can', () => {
    expect(parsePhysicsTuning({ rate: 120 }).rate).toBe(120);
    expect(parsePhysicsTuning({ rate: 0 }).rate).toBe(0);
    for (const odd of [45, -1, null, '60', undefined])
      expect('rate' in parsePhysicsTuning({ rate: odd })).toBe(false);
    // Mochi2D gets it; without one, the file's own (no rate given).
    expect(physicsValues(effectivePhysics({ ...DEFAULT_PHYSICS_TUNING, rate: 60 }, []))).toEqual({
      strength: 1,
      settings: {},
      wind: [0, 0],
      rate: 60,
    });
    expect('rate' in physicsValues(effectivePhysics(DEFAULT_PHYSICS_TUNING, []))).toBe(false);
    // physicsFPSSetting: 30, 60 or 120, or −1 for one step a frame.
    expect(physicsFpsSetting(120, 30)).toBe(120);
    expect(physicsFpsSetting(0, 30)).toBe(-1);
    // The file's own rate: as it runs, where the protocol can say it.
    expect(physicsFpsSetting(undefined, 30)).toBe(30);
    expect(physicsFpsSetting(undefined, 0)).toBe(-1);
    expect(physicsFpsSetting(undefined, 45)).toBe(-1);
  });

  it('gives each group its share of the wind (Mochi2D 0.13.0)', () => {
    const person = { ...DEFAULT_PHYSICS_TUNING, wind: 50, windGroups: { PhysicsSetting2: 0.5 } };
    expect(physicsValues(effectivePhysics(person, groups)).windSettings).toEqual({
      PhysicsSetting2: 0.5,
    });
    // A plugin's override takes the group's place; groups at 1 are left out.
    const o = { strengthGroups: {}, windGroups: { PhysicsSetting1: 2, PhysicsSetting2: 1 } };
    expect(physicsValues(effectivePhysics(person, groups, o as never)).windSettings).toEqual({
      PhysicsSetting1: 2,
    });
    expect('windSettings' in physicsValues(effectivePhysics(DEFAULT_PHYSICS_TUNING, groups))).toBe(
      false,
    );
    expect(parsePhysicsTuning({ windGroups: { a: 3, b: 'x' } }).windGroups).toEqual({ a: 2 });
    expect('windGroups' in parsePhysicsTuning({})).toBe(false);
  });

  it('reads stored settings, limiting the values', () => {
    expect(parsePhysicsTuning(undefined)).toEqual(DEFAULT_PHYSICS_TUNING);
    expect(
      parsePhysicsTuning({
        strength: 140.4,
        wind: -3,
        groups: { a: 2.5, b: 0.333, c: 'x', '': 1 },
      }),
    ).toEqual({ strength: 100, wind: 0, groups: { a: 2, b: 0.33 } });
  });

  it('lets one plugin override with timers, on top of the person’s values', () => {
    const o = new PhysicsOverrides();
    const person = { strength: 50, wind: 10, groups: { PhysicsSetting1: 0.5 } };
    expect(
      o.apply(
        plugin,
        {
          strengthOverrides: [{ id: 'PhysicsSetting1', value: 3, overrideSeconds: 1 }],
          windOverrides: [{ setBaseValue: true, value: 80, overrideSeconds: 9 }],
        },
        groups,
        0,
      ),
    ).toBeUndefined();
    expect(effectivePhysics(person, groups, o.values(500))).toEqual({
      strength: 50,
      wind: 80,
      groups: { PhysicsSetting1: 2, PhysicsSetting2: 1 },
      windGroups: { PhysicsSetting1: 1, PhysicsSetting2: 1 },
    });
    // Another plugin waits until every timer has run out (5 s at most).
    expect(
      o.apply(other, { strengthOverrides: [{ setBaseValue: true, value: 0 }] }, groups, 1000)
        ?.errorID,
    ).toBe(702);
    expect(effectivePhysics(person, groups, o.values(1000)).groups.PhysicsSetting1).toBe(0.5);
    expect(o.controller(4999)?.name).toBe('Wind Machine');
    expect(o.values(5000)).toBeUndefined();
    expect(
      o.apply(other, { strengthOverrides: [{ setBaseValue: true, value: 0 }] }, groups, 5000),
    ).toBeUndefined();
    // At least half a second.
    expect(o.values(5499)?.strength).toBe(0);
    expect(o.values(5500)).toBeUndefined();
  });

  it('refuses requests with 0013’s error IDs', () => {
    const o = new PhysicsOverrides();
    const refuse = (d: Record<string, unknown>) => o.apply(plugin, d, groups, 0)?.errorID;
    expect(refuse({})).toBe(703);
    expect(refuse({ strengthOverrides: [], windOverrides: [] })).toBe(703);
    expect(refuse({ strengthOverrides: [{ id: 'PhysicsSetting1' }] })).toBe(705);
    expect(refuse({ windOverrides: [{ id: 'Nope', value: 1 }] })).toBe(704);
    expect(refuse({ windOverrides: [{ value: 1 }] })).toBe(704);
    expect(
      refuse({
        strengthOverrides: [
          { id: 'PhysicsSetting1', value: 1 },
          { id: 'PhysicsSetting1', value: 2 },
        ],
      }),
    ).toBe(706);
    expect(
      refuse({
        strengthOverrides: [{ id: 'PhysicsSetting1', value: 1 }],
        windOverrides: [{ id: 'PhysicsSetting1', value: 2 }],
      }),
    ).toBeUndefined();
    // A refused request changes nothing; the plugin's session ending ends its overrides.
    expect(o.endSession('s2')).toBe(false);
    expect(o.endSession('s1')).toBe(true);
    expect(o.values(0)).toBeUndefined();
  });

  it('blows in smooth gusts whose direction drifts across both sides, the same everywhere', () => {
    const t0 = 1_762_000_000;
    // Ten minutes, 20 times a second.
    const samples = Array.from({ length: 12_000 }, (_, i) => windGust(t0 + i * 0.05));
    for (const [x, y] of samples) {
      expect(Math.abs(x)).toBeLessThanOrEqual(1);
      expect(Math.abs(y)).toBeLessThanOrEqual(0.2);
    }
    const xs = samples.map(([x]) => x);
    // Both sides, and strong gusts on each.
    expect(Math.max(...xs)).toBeGreaterThan(0.6);
    expect(Math.min(...xs)).toBeLessThan(-0.6);
    // Slowly: the side changes seldom (no more than once every ten seconds or so).
    let changes = 0;
    for (let i = 1; i < xs.length; i++) if (Math.sign(xs[i]!) !== Math.sign(xs[i - 1]!)) changes++;
    expect(changes).toBeGreaterThan(0);
    expect(changes).toBeLessThan(60);
    // The gusts: on one side, between 30% and 100% of the peak.
    for (let i = 0; i < 2000; i++) {
      const d = windDirection(t0 + i * 0.05);
      if (Math.abs(d) === 1) expect(Math.abs(xs[i]!)).toBeGreaterThanOrEqual(0.3 - 1e-12);
    }
    expect(windGust(t0 + 12.34)).toEqual(windGust(t0 + 12.34));
    // Smooth: no jumps from one frame to the next.
    for (let i = 1; i < samples.length; i++)
      expect(Math.abs(samples[i]![0] - samples[i - 1]![0])).toBeLessThan(0.1);
  });
});
