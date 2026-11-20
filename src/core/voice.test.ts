import {
  VOWEL_FORMANTS,
  VoiceCalibration,
  VowelAnalyzer,
  synthesizeVowel,
  voiceProfileFromJson,
} from 'mochi2d/headless';
import { describe, expect, it } from 'vitest';
import { makeRule } from './mapping';
import {
  lacksVowelParameters,
  mergeProfiles,
  shapeMouthForm,
  vowelMouthForm,
  openness,
  parseVoiceProfiles,
  profileElements,
  silentInputs,
  voiceInputs,
  vowelMapping,
  VOWELS,
  type StoredVoiceProfile,
} from './voice';
import { combinedVoiceInputs, DEFAULT_FREQUENCY_WEIGHTS, parseFrequencyWeights } from './voice';
import { TrackingPipeline } from './pipeline';
import { DEFAULT_ONE_EURO } from './filter';

const RATE = 16_000;

/** Mochi2D's analysis of a synthetic vowel: the element weights after half a second. */
function hear(
  vowel: (typeof VOWELS)[number],
  profile: StoredVoiceProfile | null = null,
  female = false,
) {
  const signal = synthesizeVowel(VOWEL_FORMANTS[vowel], 0.6, RATE, {
    ...(female ? { f0: 220, formantScale: 1.15 } : {}),
  });
  const a = new VowelAnalyzer({ profile: profile && voiceProfileFromJson(profile) });
  let last: ReturnType<VowelAnalyzer['analyze']> | undefined;
  for (let start = 0; start + 512 <= signal.length; start += 320)
    last = a.analyze(signal, start, 0.02);
  return last!;
}
const top = (raw: Float64Array): string => ['Silence', ...VOWELS][raw.indexOf(Math.max(...raw))]!;

describe('the advanced lipsync', () => {
  it('turns readings into the voice inputs, silence when quiet', () => {
    expect(
      voiceInputs({
        weights: { Silence: 0.2, A: 0.7, I: 0.1, U: 0, E: 0, O: 0 },
        volume: 1.3,
        level: -20,
        silent: false,
      }),
    ).toEqual({
      VoiceVolume: 1,
      VoiceSilence: 0.2,
      VoiceA: 0.7,
      VoiceI: 0.1,
      VoiceU: 0,
      VoiceE: 0,
      VoiceO: 0,
    });
    expect(silentInputs()).toMatchObject({ VoiceSilence: 1, VoiceA: 0, VoiceVolume: 0 });
  });

  it('opens the mouth from the level as Mochi2D’s analysis does', () => {
    expect(openness(-60)).toBe(0);
    expect(openness(-50)).toBe(0);
    expect(openness(-26)).toBe(1);
    expect(openness(-38)).toBeCloseTo(0.5, 5);
    // A profile: its voiced level, and a gate 6 dB above its recorded floor.
    const p = { voicedLevel: -10, floorLevel: -40 };
    expect(openness(-34, p)).toBe(0);
    expect(openness(-25, p)).toBeCloseTo(0.5, 5);
    expect(openness(Number.NaN)).toBe(0);
  });

  it('maps the voice inputs to the fixed parameters the model has, one rule per output', () => {
    const before = [
      makeRule({ input: 'MouthOpen', output: 'ParamMouthOpenY' }),
      makeRule({ input: 'MouthForm', output: 'ParamA', enabled: false }),
    ];
    const params = [
      { id: 'ParamMouthOpenY', min: 0, max: 1 },
      { id: 'ParamA', min: 0, max: 1 },
      { id: 'ParamI', min: -1, max: 1 },
      { id: 'ParamSilence' },
    ];
    const { rules, mapped } = vowelMapping(before, params);
    expect(mapped).toEqual(['ParamA', 'ParamI', 'ParamSilence']);
    expect(rules.map((r) => [r.input, r.output, r.enabled])).toEqual([
      ['MouthOpen', 'ParamMouthOpenY', true],
      ['VoiceA', 'ParamA', true],
      ['VoiceI', 'ParamI', true],
      ['VoiceSilence', 'ParamSilence', true],
    ]);
    expect(rules[2]).toMatchObject({ inMin: 0, inMax: 1, outMin: -1, outMax: 1 });
    // A model without them: nothing changes.
    expect(vowelMapping(before, [{ id: 'ParamMouthOpenY' }])).toEqual({
      rules: before,
      mapped: [],
    });
  });

  it('hears Mochi2D’s synthetic vowels, and calibrates a voice with them', () => {
    for (const v of VOWELS) expect(top(hear(v).raw)).toBe(v);
    // A calibrated (female) voice: each vowel recorded for a second, and the room's silence.
    const cal = new VoiceCalibration('High voice');
    for (const v of VOWELS)
      expect(
        cal.add(
          v,
          [synthesizeVowel(VOWEL_FORMANTS[v], 1.2, 48_000, { f0: 220, formantScale: 1.15 })],
          48_000,
        ),
      ).toBeGreaterThan(50);
    const room = new Float32Array(48_000).map(() => (Math.random() * 2 - 1) * 0.001);
    cal.add('Silence', [room], 48_000);
    const profile = cal.profile() as StoredVoiceProfile;
    expect(profileElements(profile)).toEqual(['A', 'I', 'U', 'E', 'O', 'Silence']);
    expect(parseVoiceProfiles([JSON.parse(JSON.stringify(profile))])).toEqual([profile]);
    for (const v of ['A', 'I', 'O'] as const) expect(top(hear(v, profile, true).raw)).toBe(v);
  });

  it('records one vowel again without losing the others', () => {
    const one = (v: (typeof VOWELS)[number], name = 'Me') => {
      const c = new VoiceCalibration(name);
      c.add(v, [synthesizeVowel(VOWEL_FORMANTS[v], 1.2, RATE)], RATE);
      return c.profile() as StoredVoiceProfile;
    };
    let p = mergeProfiles(undefined, one('A'), ['A']);
    p = mergeProfiles(p, one('I'), ['I']);
    expect(profileElements(p)).toEqual(['A', 'I']);
    const again = one('A');
    const q = mergeProfiles(p, again, ['A']);
    expect(q.templates.A).toEqual(again.templates.A);
    expect(q.templates.I).toEqual(p.templates.I);
    expect(q.floorLevel).toBeNull();
  });

  it('reads stored profiles safely', () => {
    const good = {
      format: 'mochi2d-voice-profile',
      version: 1,
      name: ' Me ',
      templates: { A: [[0, -3, -10]], I: 'no', U: [[1, Number.NaN]] },
      voicedLevel: -18,
      floorLevel: null,
    };
    expect(
      parseVoiceProfiles([good, { ...good, name: 'Me' }, { ...good, format: 'x' }, 7]),
    ).toEqual([{ ...good, name: 'Me', templates: { A: [[0, -3, -10]] } }]);
    expect(parseVoiceProfiles('no')).toEqual([]);
  });

  it('shapes the basic mouth with the vowels: I and E widen it, U and O round it', () => {
    const w = (e: Partial<Record<'Silence' | 'A' | 'I' | 'U' | 'E' | 'O', number>>) => ({
      Silence: 0,
      A: 0,
      I: 0,
      U: 0,
      E: 0,
      O: 0,
      ...e,
    });
    expect(vowelMouthForm(w({ I: 1 }))).toBe(1);
    expect(vowelMouthForm(w({ E: 1 }))).toBeGreaterThan(0.4);
    expect(vowelMouthForm(w({ U: 1 }))).toBeLessThan(-0.5);
    expect(vowelMouthForm(w({ O: 1 }))).toBe(-1);
    expect(Math.abs(vowelMouthForm(w({ A: 1 })))).toBeLessThan(0.2);
    // Quiet: no change; half voiced: half as much.
    expect(vowelMouthForm(w({ Silence: 1 }))).toBe(0);
    expect(vowelMouthForm(w({ Silence: 0.5, I: 0.5 }))).toBe(0.5);
    // On top of the tracked value, within the parameter's range.
    const range = { min: -1, max: 1, default: 0 };
    expect(shapeMouthForm(undefined, 1, range)).toBe(1);
    expect(shapeMouthForm(0.4, 0.5, range)).toBeCloseTo(0.9, 9);
    expect(shapeMouthForm(0.8, 1, range)).toBe(1);
    expect(shapeMouthForm(undefined, -0.5, { min: 0, max: 2 })).toBe(0.5);
    expect(lacksVowelParameters([{ id: 'ParamMouthForm' }])).toBe(true);
    expect(lacksVowelParameters([{ id: 'ParamO' }])).toBe(false);
  });
});

describe('the combined voice inputs', () => {
  const vowels = (o: Record<string, number>) => ({
    VoiceA: 0,
    VoiceI: 0,
    VoiceU: 0,
    VoiceE: 0,
    VoiceO: 0,
    VoiceSilence: 0,
    VoiceVolume: 0,
    ...o,
  });

  it('VoiceFrequency: 0.5 at rest, moved by the weighted vowels, within 0 to 1', () => {
    expect(combinedVoiceInputs(vowels({ VoiceSilence: 1 })).VoiceFrequency).toBe(0.5);
    expect(combinedVoiceInputs(vowels({ VoiceI: 1 })).VoiceFrequency).toBeCloseTo(1);
    expect(combinedVoiceInputs(vowels({ VoiceO: 1 })).VoiceFrequency).toBeCloseTo(0);
    expect(combinedVoiceInputs(vowels({ VoiceA: 0.6, VoiceE: 0.4 })).VoiceFrequency).toBeCloseTo(
      0.5 + 0.05 * 0.6 + 0.3 * 0.4,
    );
    // The weights are the person's (the picture's example: negative ones too), and it is limited.
    const w = { A: -0.9, I: -0.7, U: -0.6, E: 1, O: 0.9 };
    expect(combinedVoiceInputs(vowels({ VoiceE: 0.8 }), w).VoiceFrequency).toBe(1);
    expect(combinedVoiceInputs(vowels({ VoiceA: 0.8 }), w).VoiceFrequency).toBe(0);
    expect(combinedVoiceInputs(vowels({ VoiceI: 0.3 }), w).VoiceFrequency).toBeCloseTo(0.29);
    // No vowel analysis: no value.
    expect('VoiceFrequency' in combinedVoiceInputs({ MouthOpen: 0.4 })).toBe(false);
  });

  it('the Plus inputs: sums limited to 1, either part alone without the other', () => {
    const c = combinedVoiceInputs({
      ...vowels({ VoiceVolume: 0.5 }),
      MouthOpen: 0.3,
      MouthForm: 0,
    });
    expect(c.VoiceVolumePlusMouthOpen).toBeCloseTo(0.8);
    expect(c.VoiceFrequencyPlusMouthSmile).toBeCloseTo(0.5);
    expect(
      combinedVoiceInputs({ ...vowels({ VoiceVolume: 0.9 }), MouthOpen: 0.6 })
        .VoiceVolumePlusMouthOpen,
    ).toBe(1);
    // No microphone: the tracked mouth alone; no face: the voice alone.
    expect(combinedVoiceInputs({ MouthOpen: 0.4, MouthForm: 0.5 })).toEqual({
      VoiceVolumePlusMouthOpen: 0.4,
      VoiceFrequencyPlusMouthSmile: 0.75,
    });
    const voiceOnly = combinedVoiceInputs(vowels({ VoiceVolume: 0.7, VoiceI: 1 }));
    expect(voiceOnly.VoiceVolumePlusMouthOpen).toBeCloseTo(0.7);
    expect(voiceOnly.VoiceFrequencyPlusMouthSmile).toBeCloseTo(1);
    // A smile and a round vowel: the smile plus the frequency's move from 0.5.
    expect(
      combinedVoiceInputs({ ...vowels({ VoiceO: 0.5 }), MouthForm: 1 })
        .VoiceFrequencyPlusMouthSmile,
    ).toBeCloseTo(0.75);
    expect(combinedVoiceInputs({})).toEqual({});
  });

  it('keeps the weights in the settings, from −1 to 1', () => {
    expect(parseFrequencyWeights(undefined)).toEqual(DEFAULT_FREQUENCY_WEIGHTS);
    expect(parseFrequencyWeights({ A: -3, I: 0.333, U: 'x', E: 1 })).toEqual({
      ...DEFAULT_FREQUENCY_WEIGHTS,
      A: -1,
      I: 0.33,
      E: 1,
    });
  });

  it('feeds them to the mappings, with the weights given', () => {
    const p = new TrackingPipeline({
      mirror: true,
      filter: DEFAULT_ONE_EURO,
      calibration: {},
      mapping: [
        makeRule({ input: 'VoiceFrequency', output: 'ParamMouthForm', outMin: -1, outMax: 1 }),
        makeRule({ input: 'VoiceVolumePlusMouthOpen', output: 'ParamMouthOpenY' }),
      ],
      frequencyWeights: { A: 0, I: 0, U: 0, E: 0, O: -1 },
    });
    const out = p.step(undefined, 0, undefined, vowels({ VoiceO: 0.25, VoiceVolume: 0.6 }));
    expect(out.ParamMouthForm).toBeCloseTo(-0.5);
    expect(out.ParamMouthOpenY).toBeCloseTo(0.6);
  });
});
