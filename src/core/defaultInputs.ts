/**
 * The default face-tracking input names of models' settings files and of the
 * plugin API (from specifications of the settings file and of the plugin
 * API), and how each maps to Mochi Studio's own
 * inputs. The settings import and the plugin API share this table.
 */
import { HAND_INPUTS } from './hands';
import { CONTROLLER_INPUTS, MOCOPI_INPUTS, MOUSE_INPUTS } from './knownInputs';

export interface InputConversion {
  /** Mochi Studio's input id. */
  input: string;
  /** Mochi Studio value = scale · file value + offset. */
  scale: number;
  offset: number;
  /** Why this conversion was chosen, when its meaning is unknown. */
  assumed?: string;
}

export const same = (input: string, assumed?: string): InputConversion => ({
  input,
  scale: 1,
  offset: 0,
  ...(assumed ? { assumed } : {}),
});
/** A 0…1 value whose middle is the neutral position, as Mochi Studio's −1…1 input. */
const halfToCentered = (input: string, what: string): InputConversion => ({
  input,
  scale: 2,
  offset: -1,
  assumed: `${what}: read as 0…1 with 0.5 at rest, converted to Mochi Studio's −1…1 input.`,
});

/**
 * The default face-tracking inputs. Assumed throughout: the same units as
 * Mochi Studio's inputs (degrees for angles), the same sign, and the
 * subject's own left and right; the documentation gives none of these.
 */
export const FACE_INPUTS: Record<string, InputConversion> = {
  FaceAngleX: same('HeadYaw'),
  FaceAngleY: same('HeadPitch'),
  FaceAngleZ: same('HeadRoll'),
  FacePositionX: same('HeadX', 'Face position: the units are unknown; taken as they are.'),
  FacePositionY: same('HeadY', 'Face position: the units are unknown; taken as they are.'),
  FacePositionZ: same('HeadZ', 'Face position: the units are unknown; taken as they are.'),
  MouthOpen: same('MouthOpen'),
  MouthSmile: halfToCentered('MouthForm', 'MouthSmile'),
  MouthX: same('MouthX', 'MouthX: read as −1…1 with 0 at rest.'),
  CheekPuff: same('Cheek'),
  Brows: halfToCentered('Brows', 'Brows'),
  BrowLeftY: halfToCentered('BrowLeftY', 'BrowLeftY'),
  BrowRightY: halfToCentered('BrowRightY', 'BrowRightY'),
  EyeOpenLeft: same('EyeOpenLeft'),
  EyeOpenRight: same('EyeOpenRight'),
  EyeLeftX: same('GazeX', 'Eye X/Y: read as −1…1 with 0 looking ahead; both eyes share one gaze.'),
  EyeLeftY: same('GazeY', 'Eye X/Y: read as −1…1 with 0 looking ahead; both eyes share one gaze.'),
  EyeRightX: same('GazeX', 'Eye X/Y: read as −1…1 with 0 looking ahead; both eyes share one gaze.'),
  EyeRightY: same('GazeY', 'Eye X/Y: read as −1…1 with 0 looking ahead; both eyes share one gaze.'),
  // The combined voice inputs: Mochi Studio's approximations.
  VoiceVolumePlusMouthOpen: same(
    'VoiceVolumePlusMouthOpen',
    'VoiceVolumePlusMouthOpen: an approximation, the voice volume plus the tracked mouth open, limited to 1.',
  ),
  VoiceFrequency: same(
    'VoiceFrequency',
    'VoiceFrequency: an approximation, 0.5 at rest moved by the weighted vowels (Audio tab), limited to 0 to 1.',
  ),
  VoiceFrequencyPlusMouthSmile: same(
    'VoiceFrequencyPlusMouthSmile',
    "VoiceFrequencyPlusMouthSmile: an approximation, the tracked mouth smile plus VoiceFrequency's move from its resting 0.5, limited to 0 to 1.",
  ),
  // Hand tracking: the inputs of src/core/hands.ts, as they are.
  ...handConversions(),
  // The advanced lipsync's voice inputs: 0 to 1, as Mochi Studio's.
  VoiceVolume: same('VoiceVolume'),
  VoiceA: same('VoiceA'),
  VoiceI: same('VoiceI'),
  VoiceU: same('VoiceU'),
  VoiceE: same('VoiceE'),
  VoiceO: same('VoiceO'),
  VoiceSilence: same('VoiceSilence'),
  // The other documented inputs, as they are.
  ...Object.fromEntries(
    [...MOUSE_INPUTS, ...CONTROLLER_INPUTS, ...MOCOPI_INPUTS].map((i) => [
      i.id,
      same(
        i.id,
        i.id === 'MocopiLowerLegRightAngleZ'
          ? 'MocopiLowerLegRightAngleZ: the documentation prints the name without its last letter; Z is assumed.'
          : undefined,
      ),
    ]),
  ),
};

/**
 * The hand inputs, under their documented names, as Mochi Studio's: the same names, ranges and sides. Only
 * `HandDistance`'s scale is not documented.
 */
function handConversions(): Record<string, InputConversion> {
  return Object.fromEntries(
    HAND_INPUTS.map((i) => [
      i.id,
      same(
        i.id,
        i.id === 'HandDistance'
          ? "HandDistance: its scale is not documented; Mochi Studio's is the palms' distance in the positions' units (0 to 20)."
          : undefined,
      ),
    ]),
  );
}

/** Inputs Mochi Studio cannot provide. */
export const UNSUPPORTED_INPUTS: Record<string, string> = {
  TongueOut: 'the face tracker reports no tongue',
  FaceAngry: 'Mochi Studio has no such input',
};
