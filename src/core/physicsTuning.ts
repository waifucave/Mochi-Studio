/**
 * Physics strength and wind, for the Model tab and the plugin API.
 *
 * The person sets, per model: a base strength and a base wind, integers from
 * 0 to 100 (defaults 50 and 0), and a strength multiplier from 0 to 2 per
 * physics group (the model's physics settings, by ID). Plugins override them
 * for a few seconds at a time (`SetCurrentModelPhysicsRequest`); an override
 * replaces the person's value while it lasts.
 *
 * Mochi2D's values (`setPhysicsStrength`, `setPhysicsSettingStrength`,
 * `setPhysicsWind`):
 *
 * - **Model strength** = base strength / 50: 50 is the model as made (1, the
 *   reference), 0 is the same as physics off, 100 doubles every movement
 *   (within each parameter's range).
 * - **A group's strength** = its multiplier, 0 to 2 (Mochi2D multiplies it by
 *   the model's).
 * - **Wind** is "a random wind-like force": smooth random gusts
 *   whose direction drifts slowly across both sides, as real wind does,
 *   in the physics' units, where gravity is 1. Its peak is base
 *   wind / 100 × `WIND_AT_100`; `windGust` gives the gusts (30% to 100% of
 *   the peak) and the direction (from the left, through still moments, to
 *   the right, about every half minute), with a little up and down, on the
 *   wall clock, so every window shows the same wind. At 100 the strongest
 *   gusts are as strong as gravity.
 * - **Group wind multipliers** cannot be applied: Mochi2D's wind is the same
 *   for the whole model. They are reported as 1, and plugins' group wind
 *   overrides are checked and kept, but have no effect yet.
 */

/** The person's physics settings for one model. */
export interface PhysicsTuning {
  /** 0–100; 50 is the model as made. */
  strength: number;
  /** 0–100; 0 is no wind. */
  wind: number;
  /** Physics setting ID → strength multiplier, 0–2 (missing is 1). */
  groups: Record<string, number>;
  /** Physics setting ID → wind multiplier, 0–2 (missing is 1; Mochi2D 0.13.0). */
  windGroups?: Record<string, number>;
  /**
   * The physics rate: steps a second, or 0 for one step a frame
   * ("same as the app"). Absent: the physics file's own rate, the default.
   */
  rate?: PhysicsRate;
}

/** The physics rates to choose from: one step a frame (0), or fixed steps a second. */
export const PHYSICS_RATES = [0, 30, 60, 120] as const;
export type PhysicsRate = (typeof PHYSICS_RATES)[number];
const isPhysicsRate = (v: unknown): v is PhysicsRate =>
  (PHYSICS_RATES as readonly unknown[]).includes(v);

/**
 * The plugin API's `physicsFPSSetting` (30, 60
 * or 120, or −1 for "same as the app") for the rate chosen. The file's own
 * rate has no value of its own in the protocol: it is reported as the rate
 * it runs at when that is 30, 60 or 120, and as −1 otherwise (one step a
 * frame, or a rate the protocol cannot express).
 */
export function physicsFpsSetting(rate: PhysicsRate | undefined, fileRate: number): number {
  const r = rate ?? fileRate;
  return r === 30 || r === 60 || r === 120 ? r : -1;
}

export const DEFAULT_PHYSICS_TUNING: PhysicsTuning = { strength: 50, wind: 0, groups: {} };

/** The wind force (gravity is 1) at base wind 100. */
export const WIND_AT_100 = 1;
export const MULTIPLIER_MAX = 2;
export const BASE_MAX = 100;

/** What Mochi2D is given: the model's strength, each group's, and the wind. */
export interface PhysicsValues {
  strength: number;
  /** Setting ID → strength; groups at 1 are left out. */
  settings: Record<string, number>;
  /** Setting ID → wind multiplier; groups at 1 are left out (absent: none). */
  windSettings?: Record<string, number>;
  /** The wind's peak force; the runtime applies it in gusts (`windGust`). */
  wind: [number, number];
  /** The physics rate (`PhysicsTuning.rate`); absent: the physics file's own. */
  rate?: PhysicsRate;
}

/** A number from 0 to 1 for an integer and a seed (an integer hash). */
function hash(i: number, seed: number): number {
  let x = Math.imul(i ^ seed, 0x27d4eb2d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  return (x >>> 0) / 0xffffffff;
}

/** Smooth noise from 0 to 1 over time (values at whole numbers, eased between). */
function noise(t: number, seed: number): number {
  const i = Math.floor(t);
  const f = t - i;
  const e = f * f * (3 - 2 * f);
  return hash(i, seed) * (1 - e) + hash(i + 1, seed) * e;
}

/** The wind's direction at a moment: −1 (to the left) to 1 (to the right), drifting slowly. */
export function windDirection(seconds: number): number {
  // Two slow octaves; the factor keeps the wind on a side most of the time,
  // crossing through 0 (wind towards the viewer: no sideways push) between.
  const d = 0.75 * (2 * noise(seconds / 28, 53) - 1) + 0.25 * (2 * noise(seconds / 9, 71) - 1);
  return Math.max(-1, Math.min(1, 1.8 * d));
}

/**
 * The wind at a moment (seconds on the wall clock), as a share of its peak:
 * sideways, its gusts (0.3 to 1) times its direction (−1 to 1), and up or
 * down (−0.2 to 0.2).
 */
export function windGust(seconds: number): [number, number] {
  const n = 0.65 * noise(seconds / 1.7, 11) + 0.35 * noise(seconds / 0.6, 23);
  return [(0.3 + 0.7 * n) * windDirection(seconds), 0.2 * (2 * noise(seconds / 1.1, 37) - 1)];
}

export const clampBase = (v: number): number =>
  Number.isFinite(v) ? Math.max(0, Math.min(BASE_MAX, v)) : 0;
export const clampMultiplier = (v: number): number =>
  Number.isFinite(v) ? Math.max(0, Math.min(MULTIPLIER_MAX, v)) : 1;

/** Validates stored physics settings (unknown fields dropped, values limited). */
export function parsePhysicsTuning(raw: unknown): PhysicsTuning {
  const o: Record<string, unknown> =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const { strength, wind, groups } = o;
  const multipliers = (raw: unknown): Record<string, number> => {
    const g: Record<string, number> = {};
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw))
      for (const [id, v] of Object.entries(raw).slice(0, 500))
        if (typeof v === 'number' && Number.isFinite(v) && id)
          g[id.slice(0, 100)] = round2(clampMultiplier(v));
    return g;
  };
  const g = multipliers(groups);
  const w = multipliers(o.windGroups);
  return {
    strength: typeof strength === 'number' ? Math.round(clampBase(strength)) : 50,
    wind: typeof wind === 'number' ? Math.round(clampBase(wind)) : 0,
    groups: g,
    ...(Object.keys(w).length ? { windGroups: w } : {}),
    ...(isPhysicsRate(o.rate) ? { rate: o.rate } : {}),
  };
}

const round2 = (v: number): number => Math.round(v * 100) / 100;

/** The values in effect: the person's, with any plugin overrides in their place. */
export interface EffectivePhysics {
  strength: number;
  wind: number;
  /** Strength multiplier per group ID (every group listed). */
  groups: Record<string, number>;
  /** Wind multiplier per group ID (every group listed; Mochi2D 0.13.0 applies them). */
  windGroups: Record<string, number>;
  /** The person's physics rate (plugins do not change it). */
  rate?: PhysicsRate;
}

export function effectivePhysics(
  person: PhysicsTuning,
  groupIds: readonly string[],
  o?: OverrideValues,
): EffectivePhysics {
  const groups: Record<string, number> = {};
  const windGroups: Record<string, number> = {};
  for (const id of groupIds) {
    groups[id] = o?.strengthGroups[id] ?? person.groups[id] ?? 1;
    windGroups[id] = o?.windGroups[id] ?? person.windGroups?.[id] ?? 1;
  }
  return {
    strength: o?.strength ?? person.strength,
    wind: o?.wind ?? person.wind,
    groups,
    windGroups,
    ...(person.rate !== undefined ? { rate: person.rate } : {}),
  };
}

/** Mochi2D's values for the values in effect. */
export function physicsValues(e: EffectivePhysics): PhysicsValues {
  const settings: Record<string, number> = {};
  for (const [id, k] of Object.entries(e.groups)) if (k !== 1) settings[id] = k;
  const windSettings: Record<string, number> = {};
  for (const [id, k] of Object.entries(e.windGroups)) if (k !== 1) windSettings[id] = k;
  return {
    strength: clampBase(e.strength) / 50,
    settings,
    ...(Object.keys(windSettings).length ? { windSettings } : {}),
    wind: [(clampBase(e.wind) / 100) * WIND_AT_100, 0],
    ...(e.rate !== undefined ? { rate: e.rate } : {}),
  };
}

// --- plugin overrides (SetCurrentModelPhysicsRequest) -----------------------------------

export const OVERRIDE_MIN_S = 0.5;
export const OVERRIDE_MAX_S = 5;

/** The override values in effect at a moment. */
export interface OverrideValues {
  strength?: number;
  wind?: number;
  strengthGroups: Record<string, number>;
  windGroups: Record<string, number>;
}

/** Why a request was refused: one of the plugin API's physics error IDs, and a plain reason. */
export interface OverrideRefusal {
  errorID: 702 | 703 | 704 | 705 | 706;
  message: string;
}

interface Timed {
  value: number;
  until: number;
}

/** A plugin: its ID and name, and the WebSocket session it last asked from. */
export interface OverridingPlugin {
  id: string;
  name: string;
  session: string;
}

/** The plugin that controls physics, and its overrides with their own timers. */
export class PhysicsOverrides {
  private owner?: OverridingPlugin;
  private base = { strength: undefined as Timed | undefined, wind: undefined as Timed | undefined };
  private groups = { strength: new Map<string, Timed>(), wind: new Map<string, Timed>() };

  /** The plugin in control while any of its timers runs. */
  controller(now: number): OverridingPlugin | undefined {
    this.expire(now);
    return this.owner;
  }

  /**
   * Checks and applies a plugin's request. `groupIds` are the model's physics
   * groups. Returns a refusal, or undefined when the overrides now apply.
   */
  apply(
    plugin: OverridingPlugin,
    data: Record<string, unknown>,
    groupIds: readonly string[],
    now: number,
  ): OverrideRefusal | undefined {
    const owner = this.controller(now);
    if (owner && owner.id !== plugin.id)
      return {
        errorID: 702,
        message: `The plugin "${owner.name}" controls the physics until its overrides run out.`,
      };
    const lists = {
      strength: Array.isArray(data.strengthOverrides) ? data.strengthOverrides : [],
      wind: Array.isArray(data.windOverrides) ? data.windOverrides : [],
    };
    if (!lists.strength.length && !lists.wind.length)
      return { errorID: 703, message: 'No overrides given.' };
    const known = new Set(groupIds);
    const parsed: Array<{ kind: 'strength' | 'wind'; id?: string; value: number; ms: number }> = [];
    for (const kind of ['strength', 'wind'] as const) {
      const seen = new Set<string>();
      for (const raw of lists[kind] as unknown[]) {
        const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
        if (typeof o.value !== 'number' || !Number.isFinite(o.value))
          return { errorID: 705, message: `A ${kind} override has no value.` };
        const base = o.setBaseValue === true;
        const id = base ? undefined : typeof o.id === 'string' ? o.id : '';
        if (id !== undefined && !known.has(id))
          return { errorID: 704, message: `The model has no physics group "${id}".` };
        const key = id ?? '\u0000base';
        if (seen.has(key))
          return {
            errorID: 706,
            message: base
              ? `The base ${kind} is overridden twice.`
              : `The physics group "${id}" is overridden twice in the ${kind} overrides.`,
          };
        seen.add(key);
        const s = typeof o.overrideSeconds === 'number' ? o.overrideSeconds : OVERRIDE_MIN_S;
        parsed.push({
          kind,
          ...(id !== undefined ? { id } : {}),
          value: base ? clampBase(o.value) : clampMultiplier(o.value),
          ms:
            1000 *
            (Number.isFinite(s) ? Math.max(OVERRIDE_MIN_S, Math.min(OVERRIDE_MAX_S, s)) : 0.5),
        });
      }
    }
    for (const p of parsed) {
      const t = { value: p.value, until: now + p.ms };
      if (p.id === undefined) this.base[p.kind] = t;
      else this.groups[p.kind].set(p.id, t);
    }
    this.owner = { id: plugin.id, name: plugin.name, session: plugin.session };
    return undefined;
  }

  /** Drops the overrides whose time is up; true when any were dropped. */
  expire(now: number): boolean {
    let dropped = false;
    for (const k of ['strength', 'wind'] as const) {
      const b = this.base[k];
      if (b && b.until <= now) {
        this.base[k] = undefined;
        dropped = true;
      }
      for (const [id, t] of this.groups[k])
        if (t.until <= now) {
          this.groups[k].delete(id);
          dropped = true;
        }
    }
    if (!this.any()) this.owner = undefined;
    return dropped;
  }

  /** The overrides in effect, or undefined when there are none. */
  values(now: number): OverrideValues | undefined {
    this.expire(now);
    if (!this.any()) return undefined;
    return {
      ...(this.base.strength ? { strength: this.base.strength.value } : {}),
      ...(this.base.wind ? { wind: this.base.wind.value } : {}),
      strengthGroups: Object.fromEntries([...this.groups.strength].map(([id, t]) => [id, t.value])),
      windGroups: Object.fromEntries([...this.groups.wind].map(([id, t]) => [id, t.value])),
    };
  }

  /** When the next timer runs out (ms), or undefined. */
  nextExpiry(): number | undefined {
    const all = [
      this.base.strength?.until,
      this.base.wind?.until,
      ...[...this.groups.strength.values()].map((t) => t.until),
      ...[...this.groups.wind.values()].map((t) => t.until),
    ].filter((t): t is number => t !== undefined);
    return all.length ? Math.min(...all) : undefined;
  }

  /** Ends the overrides of the session that set them last (it closed); true when it had any. */
  endSession(session: string): boolean {
    if (this.owner?.session !== session) return false;
    this.clear();
    return true;
  }

  clear(): void {
    this.owner = undefined;
    this.base = { strength: undefined, wind: undefined };
    this.groups.strength.clear();
    this.groups.wind.clear();
  }

  private any(): boolean {
    return (
      !!this.base.strength ||
      !!this.base.wind ||
      this.groups.strength.size > 0 ||
      this.groups.wind.size > 0
    );
  }
}
