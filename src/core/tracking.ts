import { HAND_INPUTS, type TrackedHand } from './hands';
import { CONTROLLER_INPUTS, MOCOPI_INPUTS, MOUSE_INPUTS } from './knownInputs';
import { VOICE_COMBINED_INPUTS, VOICE_INPUTS } from './voiceInputs';
import { clamp } from './math';
import { poseFromMatrix, type HeadPose } from './headPose';

/**
 * One frame of face tracking, independent of the tracker that produced it.
 * `blendshapes` uses MediaPipe's (ARKit-style) names, for example
 * `eyeBlinkLeft`, `jawOpen`. Left and right are the subject's own sides.
 */
export interface TrackingFrame {
  /** Milliseconds, monotonic. */
  t: number;
  /** False when no face was found in this frame. */
  face: boolean;
  blendshapes: Record<string, number>;
  /** Column-major 4x4 facial transformation matrix, if available. */
  matrix?: number[];
  /**
   * The hands found, while hand tracking runs (src/core/hands.ts); absent
   * when it does not, empty when it finds none.
   */
  hands?: TrackedHand[];
}

export type InputKind =
  /** Value around 0 at rest (angles, gaze, positions): calibration subtracts the neutral value. */
  | 'centered'
  /** 0..1, at maximum at rest (eye openness): calibration rescales so the neutral value reads 1. */
  | 'open'
  /** 0..1, at minimum at rest (jaw open, smile): calibration rescales so the neutral value reads 0. */
  | 'closed';

export interface InputInfo {
  id: string;
  label: string;
  kind: InputKind;
  /** The natural range of the value, used as the mapping editor's default input range. */
  min: number;
  max: number;
  /** The value at rest, where the kind does not give it (`VoiceFrequency`: 0.5). */
  rest?: number;
}

/** The value of an input at rest: `rest`, or what its kind says. */
export function restValue(i: InputInfo): number {
  return i.rest ?? (i.kind === 'open' ? i.max : i.kind === 'closed' ? i.min : 0);
}

/** Inputs derived from a frame, in addition to every raw blendshape (prefixed `bs.`). */
export const DERIVED_INPUTS: readonly InputInfo[] = [
  { id: 'HeadYaw', label: 'Head turn (yaw, °)', kind: 'centered', min: -30, max: 30 },
  { id: 'HeadPitch', label: 'Head nod (pitch, °)', kind: 'centered', min: -30, max: 30 },
  { id: 'HeadRoll', label: 'Head tilt (roll, °)', kind: 'centered', min: -30, max: 30 },
  { id: 'HeadX', label: 'Head position X', kind: 'centered', min: -10, max: 10 },
  { id: 'HeadY', label: 'Head position Y', kind: 'centered', min: -10, max: 10 },
  { id: 'HeadZ', label: 'Head distance Z', kind: 'centered', min: -10, max: 10 },
  { id: 'EyeOpenLeft', label: 'Left eye open', kind: 'open', min: 0, max: 1 },
  { id: 'EyeOpenRight', label: 'Right eye open', kind: 'open', min: 0, max: 1 },
  { id: 'EyeSmileLeft', label: 'Left eye smile', kind: 'closed', min: 0, max: 1 },
  { id: 'EyeSmileRight', label: 'Right eye smile', kind: 'closed', min: 0, max: 1 },
  { id: 'GazeX', label: 'Gaze left/right', kind: 'centered', min: -1, max: 1 },
  { id: 'GazeY', label: 'Gaze up/down', kind: 'centered', min: -1, max: 1 },
  { id: 'BrowLeftY', label: 'Left brow up/down', kind: 'centered', min: -1, max: 1 },
  { id: 'BrowRightY', label: 'Right brow up/down', kind: 'centered', min: -1, max: 1 },
  { id: 'Brows', label: 'Both brows up/down', kind: 'centered', min: -1, max: 1 },
  { id: 'Cheek', label: 'Cheek puff', kind: 'closed', min: 0, max: 1 },
  { id: 'MouthOpen', label: 'Mouth open', kind: 'closed', min: 0, max: 1 },
  { id: 'MouthForm', label: 'Mouth smile/frown', kind: 'centered', min: -1, max: 1 },
  { id: 'MouthX', label: 'Mouth left/right', kind: 'centered', min: -1, max: 1 },
];

/** The 52 blendshape names MediaPipe's face landmarker reports (plus `_neutral`). */
export const BLENDSHAPE_NAMES: readonly string[] = [
  'browDownLeft',
  'browDownRight',
  'browInnerUp',
  'browOuterUpLeft',
  'browOuterUpRight',
  'cheekPuff',
  'cheekSquintLeft',
  'cheekSquintRight',
  'eyeBlinkLeft',
  'eyeBlinkRight',
  'eyeLookDownLeft',
  'eyeLookDownRight',
  'eyeLookInLeft',
  'eyeLookInRight',
  'eyeLookOutLeft',
  'eyeLookOutRight',
  'eyeLookUpLeft',
  'eyeLookUpRight',
  'eyeSquintLeft',
  'eyeSquintRight',
  'eyeWideLeft',
  'eyeWideRight',
  'jawForward',
  'jawLeft',
  'jawOpen',
  'jawRight',
  'mouthClose',
  'mouthDimpleLeft',
  'mouthDimpleRight',
  'mouthFrownLeft',
  'mouthFrownRight',
  'mouthFunnel',
  'mouthLeft',
  'mouthLowerDownLeft',
  'mouthLowerDownRight',
  'mouthPressLeft',
  'mouthPressRight',
  'mouthPucker',
  'mouthRight',
  'mouthRollLower',
  'mouthRollUpper',
  'mouthShrugLower',
  'mouthShrugUpper',
  'mouthSmileLeft',
  'mouthSmileRight',
  'mouthStretchLeft',
  'mouthStretchRight',
  'mouthUpperUpLeft',
  'mouthUpperUpRight',
  'noseSneerLeft',
  'noseSneerRight',
];

/** Inputs that plugins feed (the plugin API's custom parameters), set while they exist. */
let extraInputs: InputInfo[] = [];
export function setExtraInputs(list: InputInfo[]): void {
  extraInputs = list;
}

export function allInputs(): InputInfo[] {
  return [
    ...DERIVED_INPUTS,
    ...VOICE_INPUTS,
    ...VOICE_COMBINED_INPUTS,
    ...HAND_INPUTS,
    ...MOUSE_INPUTS,
    ...CONTROLLER_INPUTS,
    ...MOCOPI_INPUTS,
    ...BLENDSHAPE_NAMES.map((n): InputInfo => ({
      id: `bs.${n}`,
      label: `Blendshape ${n}`,
      kind: 'closed',
      min: 0,
      max: 1,
    })),
    ...extraInputs,
  ];
}

const INPUT_INDEX = new Map(allInputs().map((i) => [i.id, i]));
export function inputInfo(id: string): InputInfo | undefined {
  return INPUT_INDEX.get(id) ?? extraInputs.find((i) => i.id === id);
}

export type InputValues = Record<string, number>;

/**
 * Turns a tracking frame into named input values.
 *
 * With `mirror` (the default in the app), the avatar behaves like a mirror
 * image of the user: left and right are swapped and horizontal motion is
 * negated, so that raising your right brow raises the brow on the same side
 * of the screen.
 */
/** An input id for the average of several inputs: `mean(bs.noseSneerLeft,bs.noseSneerRight)`. */
export function meanInput(ids: readonly string[]): string {
  return `mean(${ids.join(',')})`;
}

/** Reads an input by id, including `mean(…)` ids; undefined when none of its inputs is there. */
export function readInput(inputs: InputValues, id: string): number | undefined {
  const direct = inputs[id];
  if (direct !== undefined) return direct;
  const m = /^mean\((.+)\)$/.exec(id);
  if (!m) return undefined;
  const vals = m[1]!
    .split(',')
    .map((x) => inputs[x.trim()])
    .filter((v): v is number => v !== undefined);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : undefined;
}

export function deriveInputs(frame: TrackingFrame, mirror: boolean): InputValues {
  const b = (name: string): number => frame.blendshapes[name] ?? 0;
  const pose: HeadPose = frame.matrix
    ? poseFromMatrix(frame.matrix)
    : { yaw: 0, pitch: 0, roll: 0, x: 0, y: 0, z: 0 };

  // Subject's own sides first.
  const eyeOpenL = clamp(1 - b('eyeBlinkLeft'), 0, 1);
  const eyeOpenR = clamp(1 - b('eyeBlinkRight'), 0, 1);
  const eyeSmileL = clamp(
    Math.max(b('cheekSquintLeft'), b('mouthSmileLeft') * b('eyeSquintLeft')),
    0,
    1,
  );
  const eyeSmileR = clamp(
    Math.max(b('cheekSquintRight'), b('mouthSmileRight') * b('eyeSquintRight')),
    0,
    1,
  );
  // Gaze: positive X = towards the subject's left, positive Y = up.
  const gazeXL = b('eyeLookOutLeft') - b('eyeLookInLeft');
  const gazeXR = b('eyeLookInRight') - b('eyeLookOutRight');
  const gazeX = clamp((gazeXL + gazeXR) / 2, -1, 1);
  const gazeY = clamp(
    (b('eyeLookUpLeft') + b('eyeLookUpRight') - b('eyeLookDownLeft') - b('eyeLookDownRight')) / 2,
    -1,
    1,
  );
  const browL = clamp(b('browOuterUpLeft') + 0.5 * b('browInnerUp') - b('browDownLeft'), -1, 1);
  const browR = clamp(b('browOuterUpRight') + 0.5 * b('browInnerUp') - b('browDownRight'), -1, 1);
  const smile = (b('mouthSmileLeft') + b('mouthSmileRight')) / 2;
  const frown = (b('mouthFrownLeft') + b('mouthFrownRight')) / 2;

  const out: InputValues = {
    HeadYaw: pose.yaw,
    HeadPitch: pose.pitch,
    HeadRoll: pose.roll,
    HeadX: pose.x,
    HeadY: pose.y,
    HeadZ: pose.z,
    EyeOpenLeft: eyeOpenL,
    EyeOpenRight: eyeOpenR,
    EyeSmileLeft: eyeSmileL,
    EyeSmileRight: eyeSmileR,
    GazeX: gazeX,
    GazeY: gazeY,
    BrowLeftY: browL,
    BrowRightY: browR,
    Brows: (browL + browR) / 2,
    Cheek: clamp(b('cheekPuff'), 0, 1),
    MouthOpen: clamp(b('jawOpen'), 0, 1),
    MouthForm: clamp(smile - frown, -1, 1),
    // Positive towards the subject's left.
    MouthX: clamp(b('mouthLeft') - b('mouthRight'), -1, 1),
  };
  for (const n of BLENDSHAPE_NAMES) out[`bs.${n}`] = b(n);

  if (mirror) {
    out.HeadYaw = -pose.yaw;
    out.HeadRoll = -pose.roll;
    out.HeadX = -pose.x;
    out.GazeX = -gazeX;
    out.MouthX = -(out.MouthX ?? 0);
    swap(out, 'EyeOpenLeft', 'EyeOpenRight');
    swap(out, 'EyeSmileLeft', 'EyeSmileRight');
    swap(out, 'BrowLeftY', 'BrowRightY');
    for (const n of BLENDSHAPE_NAMES) {
      if (n.endsWith('Left')) swap(out, `bs.${n}`, `bs.${n.slice(0, -4)}Right`);
    }
    // jawLeft/mouthLeft are directions, swapped by the loop above as well.
  }
  return out;
}

function swap(o: InputValues, a: string, b: string): void {
  const t = o[a] ?? 0;
  o[a] = o[b] ?? 0;
  o[b] = t;
}
