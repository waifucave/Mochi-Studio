/**
 * Parameters that physics overwrites, and what drives them.
 *
 * Some models (DeepSeek-chan, for one) let physics write the head and body
 * angles every frame, from parameters of their own (`AngleX` drives
 * `ParamAngleX`). Anything written to the overwritten parameter is lost, so
 * tracking must write the driving parameter instead.
 *
 * Mochi2D lists them: `physicsInputs` maps each overwritten parameter to
 * its inputs, largest weight first, and `lookRouting()` says which input
 * look-at writes for each look target. Mochi Studio chooses among them.
 */
import { parseExpression, parsePhysics } from 'mochi2d/headless';
import type { ModelFileSet, ModelManifest } from './modelFiles';

export type PhysicsFile = ReturnType<typeof parsePhysics>;

/** What drives a parameter that physics overwrites. */
export interface PhysicsDriver {
  /** The driving parameter (a physics input). */
  from: string;
  /** The driver moves the target the other way: write the driver mirrored. */
  reflect: boolean;
}

/** Overwritten parameter id -> its driver. */
export type PhysicsDrivers = Record<string, PhysicsDriver>;

/** One input of Mochi2D's `physicsInputs`. */
export interface PhysicsInput {
  id: string;
  weight: number;
  /** The input's direction is reversed. */
  reflect: boolean;
}

/** One entry of Mochi2D's `lookRouting()`. */
export interface LookRoute {
  target: string;
  writes: string;
}

export interface DriverChoice {
  /** Look-at's routing: for its targets, the input it writes is the driver. */
  look?: readonly LookRoute[];
  /** Inputs an effect writes (breath's parameters): never drivers. */
  skip?: ReadonlySet<string>;
  /** Inputs an expression writes: drivers only when nothing else is left. */
  avoid?: ReadonlySet<string>;
  /** Overwritten parameters whose physics output is reversed (from the physics file). */
  reflectedOutputs?: ReadonlySet<string>;
}

/**
 * For each parameter physics overwrites, the input to move instead:
 *
 * - **Look-at's targets** (`ParamAngleX`, …): the input look-at writes. It
 *   already resolves them through physics, and look-at is "the head follows
 *   the pointer", the same job as head tracking.
 * - **The others**, among their inputs from `physicsInputs`:
 *   1. skip those that physics writes itself and those an effect writes
 *      (`skip`: breath's parameters; never look-at's targets);
 *   2. prefer those that no expression writes (`avoid`); fall back to them
 *      only when nothing else is left, since an expression may well write a
 *      head angle. (A lean control that an expression writes is not the
 *      tracking input.)
 *   3. take the largest weight.
 *
 * Motions never count: a motion takes over its parameters only while it
 * plays, as it does over tracked ones.
 *
 * `reflect`: Mochi2D gives the input's reversal; an output that is reversed
 * too cancels it (`reflectedOutputs`).
 */
export function chooseDrivers(
  inputs: ReadonlyMap<string, readonly PhysicsInput[]>,
  o: DriverChoice = {},
): PhysicsDrivers {
  const skip = o.skip ?? new Set<string>();
  const avoid = o.avoid ?? new Set<string>();
  const look = new Map((o.look ?? []).map((r) => [r.target, r.writes] as const));
  const out: PhysicsDrivers = {};
  for (const [target, list] of inputs) {
    const routed = look.get(target);
    let pick: PhysicsInput | undefined;
    if (routed !== undefined && routed !== target) {
      pick = list.find((i) => i.id === routed) ?? { id: routed, weight: 0, reflect: false };
    } else {
      const usable = list.filter((i) => !inputs.has(i.id) && !skip.has(i.id) && i.id !== target);
      const preferred = usable.filter((i) => !avoid.has(i.id));
      const pool = preferred.length ? preferred : usable;
      pick = pool.reduce<PhysicsInput | undefined>(
        (a, b) => (!a || b.weight > a.weight ? b : a),
        undefined,
      );
    }
    if (pick)
      out[target] = {
        from: pick.id,
        reflect: pick.reflect !== !!o.reflectedOutputs?.has(target),
      };
  }
  return out;
}

/**
 * The overwritten parameters whose output is reversed in the physics file
 * (read with Mochi2D's `parsePhysics`; the last setting that writes a
 * parameter wins, as in Mochi2D).
 */
export function reflectedOutputs(file: PhysicsFile): Set<string> {
  const last = new Map<string, boolean>();
  for (const s of file.settings) for (const o of s.outputs) last.set(o.destination, o.reflect);
  return new Set([...last].filter(([, r]) => r).map(([id]) => id));
}

/** The parameters the model's expressions write (read with Mochi2D's parser). Motions do not count. */
export async function writtenByExpressions(
  files: ModelFileSet,
  manifest: ModelManifest,
): Promise<Set<string>> {
  const out = new Set<string>();
  for (const e of manifest.expressions) {
    if (!files.has(e.file)) continue;
    try {
      for (const p of parseExpression(await files.read(e.file), e.file).parameters) out.add(p.id);
    } catch {
      /* a broken file writes nothing */
    }
  }
  return out;
}

/**
 * The redirects tracking uses: every driver except those that mapping
 * rules write themselves. On a usual model the head angle drives the hair
 * (`ParamHairFront` is "driven by" `ParamAngleX`); a rule on the hair must
 * not turn the head, and tracking already writes the head angle.
 */
export function trackingRedirects(
  drivers: PhysicsDrivers,
  ruleOutputs: Iterable<string>,
  /** Outputs of rules switched to write the parameter itself (`followPhysics: false`). */
  keepOutputs: Iterable<string> = [],
): PhysicsDrivers {
  const outputs = new Set(ruleOutputs);
  const keep = new Set(keepOutputs);
  return Object.fromEntries(
    Object.entries(drivers).filter(([id, d]) => !outputs.has(d.from) && !keep.has(id)),
  );
}

/** What the running model says about physics and look-at (see `chooseDrivers`). */
export interface PhysicsFacts {
  physicsInputs: ReadonlyMap<string, readonly PhysicsInput[]>;
  look: readonly LookRoute[];
  /** Parameters breath writes. */
  breath: readonly string[];
}

/** The facts from a Mochi2D `ModelRuntime` (in the browser or headless). */
export function physicsFacts(rt: {
  physicsInputs: ReadonlyMap<string, readonly PhysicsInput[]>;
  lookRouting(): readonly LookRoute[];
  animator: { breath: { entries: readonly { id: string }[] } };
}): PhysicsFacts {
  return {
    physicsInputs: rt.physicsInputs,
    look: rt.lookRouting(),
    breath: rt.animator.breath.entries.map((e) => e.id),
  };
}

/** The drivers of a loaded model, from what Mochi2D reports and the model's files. */
export async function readPhysicsDrivers(
  files: ModelFileSet,
  manifest: ModelManifest,
  facts: PhysicsFacts,
): Promise<PhysicsDrivers> {
  if (!facts.physicsInputs.size) return {};
  let reflected = new Set<string>();
  if (manifest.physics && files.has(manifest.physics))
    try {
      reflected = reflectedOutputs(
        parsePhysics(await files.read(manifest.physics), manifest.physics),
      );
    } catch {
      /* Mochi2D loaded it; without the flags, no output counts as reversed */
    }
  return chooseDrivers(facts.physicsInputs, {
    look: facts.look,
    skip: new Set(facts.breath),
    avoid: await writtenByExpressions(files, manifest),
    reflectedOutputs: reflected,
  });
}

/**
 * Moves values aimed at overwritten parameters to their drivers, scaled
 * from the target's range to the driver's (assumed linear). Values for the
 * same driver add up, like mapping rules on one parameter.
 */
export function redirectToDrivers(
  values: Record<string, number>,
  drivers: PhysicsDrivers,
  ranges: ReadonlyMap<string, { min: number; max: number }>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, v] of Object.entries(values)) {
    const d = drivers[id];
    if (!d) {
      out[id] = (out[id] ?? 0) + v;
      continue;
    }
    const a = ranges.get(id);
    const b = ranges.get(d.from);
    let mapped =
      a && b && a.max !== a.min ? b.min + ((v - a.min) / (a.max - a.min)) * (b.max - b.min) : v;
    // Reflected: mirror within the driver's range, so the target moves as the rule asks.
    if (d.reflect) mapped = b ? b.min + b.max - mapped : -mapped;
    out[d.from] = (out[d.from] ?? 0) + mapped;
  }
  return out;
}
