/**
 * The advanced (vowel) lipsync, the
 * parts that need no browser:
 *
 * - **The voice inputs** the analysis feeds, all 0 to 1: `VoiceA` …
 *   `VoiceO` and `VoiceSilence` (Mochi2D's element weights, which sum to 1),
 *   and `VoiceVolume` (how open the level makes the mouth).
 * - **The lipsync's own automatic setup**: `VoiceA` … `VoiceO` to `ParamA` …
 *   `ParamO`, and `VoiceSilence` to `ParamSilence`, where the model has them.
 * - **Voice profiles** (Mochi2D's `VoiceCalibration`), one per voice, kept
 *   app-wide: re-recording one vowel replaces only that vowel.
 */
import type { MappingRule } from './mapping';
import { makeRule } from './mapping';
import type { InputValues } from './tracking';
import {
  VOICE_ELEMENTS,
  VOICE_FREQUENCY,
  VOICE_FREQUENCY_PLUS_MOUTH_SMILE,
  VOICE_INPUTS,
  VOICE_VOLUME,
  VOICE_VOLUME_PLUS_MOUTH_OPEN,
  VOWELS,
  voiceInputId,
  type VoiceElement,
  type Vowel,
} from './voiceInputs';

export {
  VOICE_ELEMENTS,
  VOICE_INPUTS,
  VOICE_VOLUME,
  VOWELS,
  voiceInputId,
  type VoiceElement,
  type Vowel,
} from './voiceInputs';
export const VOICE_INPUT_IDS: ReadonlySet<string> = new Set(VOICE_INPUTS.map((i) => i.id));

/** How much each vowel moves `VoiceFrequency`, −1 to 1. */
export type FrequencyWeights = Record<Vowel, number>;

/**
 * Mochi Studio's own default weights: half of each vowel's mouth form
 * (`VOWEL_FORM`), so a clear I reads 1, a clear O 0, and A stays near the
 * middle. No defaults are documented.
 */
export const DEFAULT_FREQUENCY_WEIGHTS: Readonly<FrequencyWeights> = {
  A: 0.05,
  I: 0.5,
  U: -0.4,
  E: 0.3,
  O: -0.5,
};

/** Stored weights, each from −1 to 1 (two decimals); missing or invalid ones are the defaults'. */
export function parseFrequencyWeights(raw: unknown): FrequencyWeights {
  const o =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const out = { ...DEFAULT_FREQUENCY_WEIGHTS };
  for (const v of VOWELS) {
    const x = o[v];
    if (typeof x === 'number' && Number.isFinite(x))
      out[v] = Math.round(Math.max(-1, Math.min(1, x)) * 100) / 100;
  }
  return out;
}

/**
 * The combined voice inputs, approximations (their exact definitions are not
 * documented):
 *
 * - **`VoiceFrequency`**: 0.5 at rest, moved by each vowel's input times its
 *   weight, limited to 0 to 1. Only while the vowels are analysed.
 * - **`VoiceVolumePlusMouthOpen`**: `VoiceVolume` plus the tracked
 *   `MouthOpen`, limited to 1. Without one part, the other alone.
 * - **`VoiceFrequencyPlusMouthSmile`**: the tracked mouth smile (Mochi
 *   Studio's `MouthForm` as 0 to 1, 0.5 at rest) plus `VoiceFrequency`'s move
 *   from its resting 0.5, limited to 0 to 1. Both rest at 0.5, so a plain
 *   sum would read 1 with a still face and no sound; adding the move keeps
 *   the rest at 0.5. Without one part, the other alone.
 */
export function combinedVoiceInputs(
  inputs: InputValues,
  weights: Readonly<FrequencyWeights> = DEFAULT_FREQUENCY_WEIGHTS,
): InputValues {
  const out: InputValues = {};
  let frequency: number | undefined;
  if (VOWELS.some((v) => inputs[voiceInputId(v)] !== undefined)) {
    let f = 0.5;
    for (const v of VOWELS) f += (weights[v] ?? 0) * (inputs[voiceInputId(v)] ?? 0);
    frequency = clamp01(f);
    out[VOICE_FREQUENCY] = frequency;
  }
  const volume = inputs[VOICE_VOLUME];
  const mouth = inputs.MouthOpen;
  if (volume !== undefined || mouth !== undefined)
    out[VOICE_VOLUME_PLUS_MOUTH_OPEN] = clamp01((volume ?? 0) + (mouth ?? 0));
  const smile = inputs.MouthForm === undefined ? undefined : (inputs.MouthForm + 1) / 2;
  if (frequency !== undefined || smile !== undefined)
    out[VOICE_FREQUENCY_PLUS_MOUTH_SMILE] = clamp01((smile ?? 0.5) + (frequency ?? 0.5) - 0.5);
  return out;
}

/** What one analysis gives: the elements' weights (summing to 1) and the mouth's openness. */
export interface VoiceReading {
  weights: Record<VoiceElement, number>;
  /** 0 to 1. */
  volume: number;
  /** dBFS. */
  level: number;
  silent: boolean;
}

/** The voice inputs of a reading. */
export function voiceInputs(r: VoiceReading): InputValues {
  const out: InputValues = { [VOICE_VOLUME]: clamp01(r.volume) };
  for (const e of VOICE_ELEMENTS) out[voiceInputId(e)] = clamp01(r.weights[e] ?? 0);
  return out;
}

/** The voice inputs while the microphone is off or quiet: silence. */
export function silentInputs(): InputValues {
  return voiceInputs({
    weights: { Silence: 1, A: 0, I: 0, U: 0, E: 0, O: 0 },
    volume: 0,
    level: -Infinity,
    silent: true,
  });
}

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);

/** The analysis's default gate, dBFS (Mochi2D's). */
export const DEFAULT_VOICE_GATE = -50;
/** A voiced level to use without a profile, dBFS. */
export const DEFAULT_VOICED_LEVEL = -20;

/**
 * How open a level makes the mouth, as Mochi2D's analysis has it: 0 at the
 * gate, 1 from 6 dB below the voice's typical level (a profile's, or
 * `DEFAULT_VOICED_LEVEL`). The gate is 6 dB above a recorded noise floor
 * when that is higher than `gate`.
 */
export function openness(
  level: number,
  profile?: { voicedLevel: number; floorLevel: number | null } | null,
  gate = DEFAULT_VOICE_GATE,
): number {
  const g = profile?.floorLevel != null ? Math.max(gate, profile.floorLevel + 6) : gate;
  const top = (profile?.voicedLevel ?? DEFAULT_VOICED_LEVEL) - 6;
  if (!Number.isFinite(level) || level <= g) return 0;
  if (top <= g) return 1;
  return clamp01((level - g) / (top - g));
}

// --- the basic mouth: vowels shape the mouth form -----------------------

/** The mouth parameter the vowels shape, for models without vowel parameters. */
export const MOUTH_FORM_PARAM = 'ParamMouthForm';

/**
 * How each vowel moves the mouth form, −1 (round) to 1 (wide): Mochi
 * Studio's own values for the two-axis basic mouth. I is the widest, E wide,
 * A neutral and open, U and O round (O the roundest).
 */
export const VOWEL_FORM: Readonly<Record<Vowel, number>> = {
  A: 0.1,
  I: 1,
  U: -0.8,
  E: 0.6,
  O: -1,
};

/**
 * The mouth form the vowels give, −1 to 1: each vowel's share of the sound
 * times its form. Silence gives 0, so the mouth form is left to tracking.
 */
export function vowelMouthForm(weights: Readonly<Record<VoiceElement, number>>): number {
  let f = 0;
  for (const v of VOWELS) f += (weights[v] ?? 0) * VOWEL_FORM[v];
  return Math.max(-1, Math.min(1, f));
}

/**
 * Adds the vowels' form to a mouth-form value (in the parameter's units):
 * `form` (−1 to 1) moves it by up to half the range, within the range.
 */
export function shapeMouthForm(
  value: number | undefined,
  form: number,
  range: { min: number; max: number; default?: number },
): number {
  const base = value ?? range.default ?? (range.min + range.max) / 2;
  const v = base + (form * (range.max - range.min)) / 2;
  return Math.max(Math.min(range.min, range.max), Math.min(Math.max(range.min, range.max), v));
}

/** Whether the model has none of the vowel parameters (the basic mouth then takes the vowels). */
export function lacksVowelParameters(params: ReadonlyArray<{ id: string }>): boolean {
  return !VOWEL_PARAMETERS.some(([, id]) => params.some((p) => p.id === id));
}

// --- the automatic setup ------------------------------------------------------------

/** The model parameters the setup maps each voice input to (fixed IDs). */
export const VOWEL_PARAMETERS: ReadonlyArray<readonly [string, string]> = [
  ...VOWELS.map((v) => [voiceInputId(v), `Param${v}`] as const),
  [voiceInputId('Silence'), 'ParamSilence'],
];

/**
 * The lipsync's automatic setup: a rule from each voice input to its fixed
 * parameter, where the model has it. A rule that already drives that
 * parameter is pointed at the voice input (an output has one rule); other
 * rules stay. Returns the new rules and the parameters it set up.
 */
export function vowelMapping(
  rules: readonly MappingRule[],
  params: ReadonlyArray<{ id: string; min?: number; max?: number }>,
): { rules: MappingRule[]; mapped: string[] } {
  const out = rules.map((r) => ({ ...r }));
  const mapped: string[] = [];
  for (const [input, output] of VOWEL_PARAMETERS) {
    const p = params.find((x) => x.id === output);
    if (!p) continue;
    const range = { inMin: 0, inMax: 1, outMin: p.min ?? 0, outMax: p.max ?? 1 };
    const i = out.findIndex((r) => r.output === output);
    if (i >= 0) out[i] = { ...out[i]!, input, ...range, invert: false, enabled: true };
    else out.push(makeRule({ input, output, ...range, smoothing: 0.1 }));
    mapped.push(output);
  }
  return { rules: out, mapped };
}

// --- voice profiles -------------------------------------------------------------------

/** Mochi2D's voice profile (`VoiceCalibration.profile()`), as kept in the app settings. */
export interface StoredVoiceProfile {
  format: 'mochi2d-voice-profile';
  version: 1;
  name: string;
  templates: Partial<Record<Vowel, number[][]>>;
  voicedLevel: number;
  floorLevel: number | null;
}

/**
 * A profile with some vowels (or the silence) recorded again: the new
 * recordings replace those vowels; the others, the levels and the floor stay
 * unless recorded.
 */
export function mergeProfiles(
  old: StoredVoiceProfile | undefined,
  now: StoredVoiceProfile,
  recorded: readonly VoiceElement[],
): StoredVoiceProfile {
  if (!old) return now;
  const vowels = recorded.filter((e): e is Vowel => e !== 'Silence');
  const templates = { ...old.templates };
  for (const v of vowels) if (now.templates[v]) templates[v] = now.templates[v];
  return {
    ...old,
    name: now.name,
    templates,
    voicedLevel: vowels.length ? now.voicedLevel : old.voicedLevel,
    floorLevel: recorded.includes('Silence') ? now.floorLevel : old.floorLevel,
  };
}

/** The vowels a profile has (and whether it has the room's silence). */
export function profileElements(p: StoredVoiceProfile | undefined): VoiceElement[] {
  if (!p) return [];
  return [
    ...VOWELS.filter((v) => (p.templates[v]?.length ?? 0) > 0),
    ...(p.floorLevel !== null ? (['Silence'] as const) : []),
  ];
}

/** Validates stored profiles (Mochi2D checks each fully when it is used). */
export function parseVoiceProfiles(raw: unknown): StoredVoiceProfile[] {
  if (!Array.isArray(raw)) return [];
  const out: StoredVoiceProfile[] = [];
  const names = new Set<string>();
  for (const v of raw.slice(0, 50)) {
    if (typeof v !== 'object' || v === null) continue;
    const p = v as Record<string, unknown>;
    if (p.format !== 'mochi2d-voice-profile' || p.version !== 1) continue;
    if (typeof p.name !== 'string' || !p.name.trim() || names.has(p.name.trim())) continue;
    if (typeof p.voicedLevel !== 'number' || !Number.isFinite(p.voicedLevel)) continue;
    const t = typeof p.templates === 'object' && p.templates !== null ? p.templates : {};
    const templates: Partial<Record<Vowel, number[][]>> = {};
    for (const vowel of VOWELS) {
      const list = (t as Record<string, unknown>)[vowel];
      if (!Array.isArray(list)) continue;
      const spectra = list.filter(
        (s): s is number[] =>
          Array.isArray(s) &&
          s.length > 0 &&
          s.every((x) => typeof x === 'number' && Number.isFinite(x)),
      );
      if (spectra.length) templates[vowel] = spectra.slice(0, 64);
    }
    const name = p.name.trim().slice(0, 64);
    names.add(name);
    out.push({
      format: 'mochi2d-voice-profile',
      version: 1,
      name,
      templates,
      voicedLevel: p.voicedLevel,
      floorLevel:
        typeof p.floorLevel === 'number' && Number.isFinite(p.floorLevel) ? p.floorLevel : null,
    });
  }
  return out;
}
