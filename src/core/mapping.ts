import { ExpSmoother, RateSmoother } from './filter';
import { clamp, remap } from './math';
import { readInput, type InputValues } from './tracking';

/** Maps one tracking input to one model parameter. */
export interface MappingRule {
  id: string;
  enabled: boolean;
  /** A tracking input id, see `allInputs()`. */
  input: string;
  /** A model parameter id. */
  output: string;
  inMin: number;
  inMax: number;
  outMin: number;
  outMax: number;
  /** Mirrors the result within [outMin, outMax]. */
  invert: boolean;
  /** Clamps the result to [outMin, outMax]. */
  clamp: boolean;
  /**
   * 0 = none, 1 = strongest: a 500 ms time constant for the exponential
   * smoother, or a full swing in 250 ms up and 500 ms down for the rate
   * limit.
   */
  smoothing: number;
  /**
   * How `smoothing` works. Unset: the rate limit for inputs from sound
   * (`isSoundInput`), the exponential filter for the rest.
   */
  smoother?: SmootherKind;
  /**
   * When physics overwrites the output parameter, write the parameter that
   * drives it instead (default true). False writes the output as it is.
   */
  followPhysics?: boolean;
}

export type SmootherKind = 'exponential' | 'rate';
export const SMOOTHER_KINDS: readonly SmootherKind[] = ['exponential', 'rate'];

/**
 * Inputs that come from sound: the voice inputs (vowels, silence, volume,
 * frequency, and those made from them). They drive the mouth, so they get
 * the rate limit by default.
 */
export function isSoundInput(input: string): boolean {
  return /^Voice[A-Z]/.test(input);
}

/** The smoother a rule uses: its own choice, or the default for its input. */
export function ruleSmoother(rule: Pick<MappingRule, 'input' | 'smoother'>): SmootherKind {
  return rule.smoother ?? (isSoundInput(rule.input) ? 'rate' : 'exponential');
}

let ruleCounter = 0;
export function newRuleId(): string {
  ruleCounter++;
  return `r${Date.now().toString(36)}${ruleCounter.toString(36)}`;
}

export function makeRule(
  p: Partial<MappingRule> & Pick<MappingRule, 'input' | 'output'>,
): MappingRule {
  return {
    id: p.id ?? newRuleId(),
    enabled: p.enabled ?? true,
    input: p.input,
    output: p.output,
    inMin: p.inMin ?? 0,
    inMax: p.inMax ?? 1,
    outMin: p.outMin ?? 0,
    outMax: p.outMax ?? 1,
    invert: p.invert ?? false,
    clamp: p.clamp ?? true,
    smoothing: p.smoothing ?? 0,
    ...(p.followPhysics === false ? { followPhysics: false } : {}),
    ...(p.smoother && SMOOTHER_KINDS.includes(p.smoother) ? { smoother: p.smoother } : {}),
  };
}

/** Evaluates one rule without smoothing. */
export function evaluateRule(rule: MappingRule, value: number): number {
  let out = remap(value, rule.inMin, rule.inMax, rule.outMin, rule.outMax);
  if (rule.invert) out = rule.outMin + rule.outMax - out;
  if (rule.clamp) {
    const lo = Math.min(rule.outMin, rule.outMax);
    const hi = Math.max(rule.outMin, rule.outMax);
    out = clamp(out, lo, hi);
  }
  return out;
}

/**
 * The default rules for the standard parameter ids, kept only for parameters
 * the model has. Ranges follow the usual conventions of those ids; adjust
 * them in the mapping editor per model.
 */
export function defaultRules(modelParams: Iterable<string>): MappingRule[] {
  const has = new Set(modelParams);
  const d: Array<Omit<Partial<MappingRule>, 'id'> & Pick<MappingRule, 'input' | 'output'>> = [
    {
      input: 'HeadYaw',
      output: 'ParamAngleX',
      inMin: -30,
      inMax: 30,
      outMin: -30,
      outMax: 30,
      smoothing: 0.1,
    },
    {
      input: 'HeadPitch',
      output: 'ParamAngleY',
      inMin: -30,
      inMax: 30,
      outMin: -30,
      outMax: 30,
      smoothing: 0.1,
    },
    {
      input: 'HeadRoll',
      output: 'ParamAngleZ',
      inMin: -30,
      inMax: 30,
      outMin: -30,
      outMax: 30,
      smoothing: 0.1,
    },
    {
      input: 'HeadYaw',
      output: 'ParamBodyAngleX',
      inMin: -30,
      inMax: 30,
      outMin: -10,
      outMax: 10,
      smoothing: 0.3,
    },
    {
      input: 'HeadPitch',
      output: 'ParamBodyAngleY',
      inMin: -30,
      inMax: 30,
      outMin: -10,
      outMax: 10,
      smoothing: 0.3,
    },
    {
      input: 'HeadRoll',
      output: 'ParamBodyAngleZ',
      inMin: -30,
      inMax: 30,
      outMin: -10,
      outMax: 10,
      smoothing: 0.3,
    },
    {
      input: 'EyeOpenLeft',
      output: 'ParamEyeLOpen',
      inMin: 0.15,
      inMax: 0.85,
      outMin: 0,
      outMax: 1,
    },
    {
      input: 'EyeOpenRight',
      output: 'ParamEyeROpen',
      inMin: 0.15,
      inMax: 0.85,
      outMin: 0,
      outMax: 1,
    },
    { input: 'EyeSmileLeft', output: 'ParamEyeLSmile', inMin: 0, inMax: 0.7, outMin: 0, outMax: 1 },
    {
      input: 'EyeSmileRight',
      output: 'ParamEyeRSmile',
      inMin: 0,
      inMax: 0.7,
      outMin: 0,
      outMax: 1,
    },
    {
      input: 'GazeX',
      output: 'ParamEyeBallX',
      inMin: -0.6,
      inMax: 0.6,
      outMin: -1,
      outMax: 1,
      smoothing: 0.1,
    },
    {
      input: 'GazeY',
      output: 'ParamEyeBallY',
      inMin: -0.6,
      inMax: 0.6,
      outMin: -1,
      outMax: 1,
      smoothing: 0.1,
    },
    {
      input: 'BrowLeftY',
      output: 'ParamBrowLY',
      inMin: -0.5,
      inMax: 0.5,
      outMin: -1,
      outMax: 1,
      smoothing: 0.1,
    },
    {
      input: 'BrowRightY',
      output: 'ParamBrowRY',
      inMin: -0.5,
      inMax: 0.5,
      outMin: -1,
      outMax: 1,
      smoothing: 0.1,
    },
    {
      input: 'Cheek',
      output: 'ParamCheek',
      inMin: 0,
      inMax: 0.6,
      outMin: 0,
      outMax: 1,
      smoothing: 0.2,
    },
    { input: 'MouthOpen', output: 'ParamMouthOpenY', inMin: 0, inMax: 0.7, outMin: 0, outMax: 1 },
    {
      input: 'MouthForm',
      output: 'ParamMouthForm',
      inMin: -0.5,
      inMax: 0.5,
      outMin: -1,
      outMax: 1,
      smoothing: 0.1,
    },
  ];
  return d.filter((r) => has.has(r.output)).map((r) => makeRule(r));
}

/**
 * Evaluates a rule set every frame. Several rules may target the same
 * parameter; their results are added.
 */
export class MappingEngine {
  private smoothers = new Map<string, ExpSmoother | RateSmoother>();

  constructor(public rules: MappingRule[] = []) {}

  setRules(rules: MappingRule[]): void {
    this.rules = rules;
    const ids = new Set(rules.map((r) => r.id));
    for (const id of this.smoothers.keys()) if (!ids.has(id)) this.smoothers.delete(id);
  }

  reset(): void {
    for (const s of this.smoothers.values()) s.reset();
  }

  /** @returns parameter id -> value */
  evaluate(inputs: InputValues, t: number): Record<string, number> {
    const out: Record<string, number> = {};
    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      const v = readInput(inputs, rule.input);
      if (v === undefined) continue;
      const rate = ruleSmoother(rule) === 'rate';
      let s = this.smoothers.get(rule.id);
      if (!s || s instanceof RateSmoother !== rate) {
        s = rate ? new RateSmoother() : new ExpSmoother();
        this.smoothers.set(rule.id, s);
      }
      const target = evaluateRule(rule, v);
      const r =
        s instanceof RateSmoother
          ? s.step(target, rule.smoothing, t, rule.outMax - rule.outMin)
          : s.step(target, rule.smoothing, t);
      out[rule.output] = (out[rule.output] ?? 0) + r;
    }
    return out;
  }
}
