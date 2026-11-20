/**
 * The advanced lipsync's voice inputs, apart from the rest of
 * src/core/voice.ts so that the input list (src/core/tracking.ts) can use
 * them without an import cycle.
 */
import type { InputInfo } from './tracking';

/** Mochi2D's audio elements, in its order. */
export const VOICE_ELEMENTS = ['Silence', 'A', 'I', 'U', 'E', 'O'] as const;
export type VoiceElement = (typeof VOICE_ELEMENTS)[number];
export const VOWELS = ['A', 'I', 'U', 'E', 'O'] as const;
export type Vowel = (typeof VOWELS)[number];

/** The input fed by an element: `VoiceA`, …, `VoiceSilence`. */
export const voiceInputId = (e: VoiceElement): string => `Voice${e}`;
export const VOICE_VOLUME = 'VoiceVolume';

export const VOICE_INPUTS: readonly InputInfo[] = [
  ...VOWELS.map((v): InputInfo => ({
    id: voiceInputId(v),
    label: `Voice: vowel ${v}`,
    kind: 'closed',
    min: 0,
    max: 1,
  })),
  { id: voiceInputId('Silence'), label: 'Voice: silence', kind: 'open', min: 0, max: 1 },
  { id: VOICE_VOLUME, label: 'Voice: volume', kind: 'closed', min: 0, max: 1 },
];

export const VOICE_FREQUENCY = 'VoiceFrequency';
export const VOICE_VOLUME_PLUS_MOUTH_OPEN = 'VoiceVolumePlusMouthOpen';
export const VOICE_FREQUENCY_PLUS_MOUTH_SMILE = 'VoiceFrequencyPlusMouthSmile';

/**
 * The voice inputs made from the others, all 0
 * to 1 and all approximations (their exact definitions are not documented)
 * (src/core/voice.ts, `combinedVoiceInputs`).
 */
export const VOICE_COMBINED_INPUTS: readonly InputInfo[] = [
  {
    id: VOICE_FREQUENCY,
    label: 'Voice: frequency, one mouth shape from the vowels (approximation)',
    kind: 'centered',
    min: 0,
    max: 1,
    rest: 0.5,
  },
  {
    id: VOICE_VOLUME_PLUS_MOUTH_OPEN,
    label: 'Voice: volume plus the tracked mouth open (approximation)',
    kind: 'closed',
    min: 0,
    max: 1,
  },
  {
    id: VOICE_FREQUENCY_PLUS_MOUTH_SMILE,
    label: 'Voice: frequency plus the tracked mouth smile (approximation)',
    kind: 'centered',
    min: 0,
    max: 1,
    rest: 0.5,
  },
];
