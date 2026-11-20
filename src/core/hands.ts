/**
 * Hand tracking: the hand
 * landmarks of a camera frame (MediaPipe's hand landmarker, 21 points per
 * hand) as inputs for the mapping, and as readings for gestures.
 *
 * The inputs, under the documented names of plugins made for VTube Studio
 * (26 in all):
 *
 * - `HandLeftFound`, `HandRightFound`, `BothHandsFound`: 0 or 1;
 * - `HandDistance`: the distance between the palms, in the position units
 *   (the picture is 20 wide), 0 to 20, while both hands are found (its
 *   documented scale is not given: this one is Mochi Studio's);
 * - per hand (`HandLeft…`, `HandRight…`):
 *   - `PositionX`, `PositionY`, `PositionZ`, −10 to 10: the palm's place in
 *     the picture, the picture spanning −10 to 10 from its middle. X is
 *     mirror-symmetric: positive away from the middle (outwards) for both
 *     hands. Y up. Z the nearness, from the hand's size in the picture, 0 at
 *     a usual distance;
 *   - `AngleX`, `AngleZ`, ±180°: the hand's left/right turn (X: the palm's
 *     facing, 0 towards the camera) and its lean in the picture (Z: 0 with
 *     the fingers up). Both are positive towards the subject's left
 *     (Mochi Studio's sign: the documented one is not given);
 *   - `Open` and `Finger_1_Thumb` … `Finger_5_Pinky`: 0 curled to 1
 *     straight; `Open` is the five fingers' mean.
 *
 * Left and right are the subject's own hands; with `mirror` (as for the
 * face) the names swap and the angles change sign, so the avatar moves like
 * a mirror image. X needs no change: outwards stays outwards in a mirror.
 */
import type { InputInfo, InputValues } from './tracking';

export type HandSide = 'left' | 'right';
export type Point3 = readonly [number, number, number];

/** One hand in a camera frame. */
export interface TrackedHand {
  /** The subject's own hand. */
  side: HandSide;
  /** 21 points in the picture: x and y from 0 to 1 from the top left, z a relative depth. */
  points: readonly Point3[];
  /** The same points in meters around the hand, when the tracker gives them (better angles). */
  world?: readonly Point3[];
  score?: number;
}

export const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'] as const;
export type Finger = (typeof FINGERS)[number];

/** The points of each finger, from its base to its tip (MediaPipe's hand landmarks). */
const CHAINS: Record<Finger, readonly number[]> = {
  Thumb: [1, 2, 3, 4],
  Index: [5, 6, 7, 8],
  Middle: [9, 10, 11, 12],
  Ring: [13, 14, 15, 16],
  Pinky: [17, 18, 19, 20],
};
const WRIST = 0;
const MIDDLE_KNUCKLE = 9;
const PALM = [0, 5, 9, 13, 17];

/** How far a finger bends when fully curled (the sum of its joints' angles), radians. */
const CURL: Record<Finger, number> = {
  Thumb: (110 * Math.PI) / 180,
  Index: (200 * Math.PI) / 180,
  Middle: (200 * Math.PI) / 180,
  Ring: (200 * Math.PI) / 180,
  Pinky: (200 * Math.PI) / 180,
};
/** The wrist-to-knuckle length, in picture widths, at a usual distance (`PositionZ` 0). */
export const USUAL_HAND_SIZE = 0.15;

/** What a hand shows, before mirroring. */
export interface HandReading {
  side: HandSide;
  /** 0 curled to 1 straight. */
  fingers: Record<Finger, number>;
  open: number;
  /** The palm's center in the picture, 0 to 1. */
  palm: [number, number];
  /** Wrist to middle knuckle, in picture widths. */
  size: number;
  /** Degrees. */
  angleX: number;
  angleZ: number;
  /** Where the thumb points in the picture: 1 up, −1 down. */
  thumbUp: number;
  /** The thumb and index tips' distance, in hand lengths (wrist to middle knuckle): 0 touching. */
  tipGap: number;
}

const sub = (a: Point3, b: Point3): [number, number, number] => [
  a[0] - b[0],
  a[1] - b[1],
  a[2] - b[2],
];
const cross = (a: readonly number[], b: readonly number[]): [number, number, number] => [
  a[1]! * b[2]! - a[2]! * b[1]!,
  a[2]! * b[0]! - a[0]! * b[2]!,
  a[0]! * b[1]! - a[1]! * b[0]!,
];
const len = (v: readonly number[]): number => Math.hypot(v[0]!, v[1]!, v[2] ?? 0);
function angle(u: readonly number[], v: readonly number[]): number {
  const lu = len(u);
  const lv = len(v);
  if (!(lu > 0) || !(lv > 0)) return 0;
  const c = (u[0]! * v[0]! + u[1]! * v[1]! + (u[2] ?? 0) * (v[2] ?? 0)) / (lu * lv);
  return Math.acos(Math.max(-1, Math.min(1, c)));
}
const clamp = (v: number, lo: number, hi: number): number =>
  Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : 0;
const deg = (r: number): number => (r * 180) / Math.PI;

/**
 * How straight a finger is, 0 (curled) to 1 (straight): one minus how far
 * its joints bend, against a full curl. Joint angles do not change with the
 * hand's size or turn, so this reads the same anywhere in the picture.
 */
function straightness(p: readonly Point3[], f: Finger): number {
  const c = CHAINS[f];
  // The thumb's joints from its first knuckle; the others' from the wrist (the knuckle bends too).
  const from = f === 'Thumb' ? [c[0]!, c[1]!, c[2]!, c[3]!] : [WRIST, c[0]!, c[1]!, c[2]!, c[3]!];
  let bend = 0;
  for (let i = 0; i + 2 < from.length; i++) {
    const a = p[from[i]!]!;
    const b = p[from[i + 1]!]!;
    const d = p[from[i + 2]!]!;
    bend += angle(sub(b, a), sub(d, b));
  }
  return clamp(1 - bend / CURL[f], 0, 1);
}

/** What a hand shows; undefined for a hand with fewer than 21 points. */
export function readHand(h: TrackedHand): HandReading | undefined {
  const img = h.points;
  if (img.length < 21) return undefined;
  const shape = h.world && h.world.length >= 21 ? h.world : img;
  const fingers = {} as Record<Finger, number>;
  for (const f of FINGERS) fingers[f] = straightness(shape, f);
  const open = FINGERS.reduce((s, f) => s + fingers[f], 0) / FINGERS.length;
  const palm: [number, number] = [
    PALM.reduce((s, i) => s + img[i]![0], 0) / PALM.length,
    PALM.reduce((s, i) => s + img[i]![1], 0) / PALM.length,
  ];
  const up = sub(img[MIDDLE_KNUCKLE]!, img[WRIST]!);
  // The palm's normal, out of the palm (towards the camera when the palm faces it): from the
  // wrist to the index and little-finger knuckles, in the hand's own order.
  const a = sub(shape[5]!, shape[WRIST]!);
  const b = sub(shape[17]!, shape[WRIST]!);
  const n = h.side === 'right' ? cross(a, b) : cross(b, a);
  const thumb = sub(img[4]!, img[2]!);
  const thumbLen = Math.hypot(thumb[0], thumb[1]);
  // In the same space as the joints (world points in 3D; picture points across the picture).
  const d3 = shape !== img;
  const dist = (a: Point3, b: Point3): number => {
    const d = sub(a, b);
    return Math.hypot(d[0], d[1], d3 ? d[2] : 0);
  };
  const handLength = dist(shape[MIDDLE_KNUCKLE]!, shape[WRIST]!);
  return {
    side: h.side,
    fingers,
    open,
    palm,
    size: Math.hypot(up[0], up[1]),
    // Fingers up in the picture: 0; towards the subject's left (the picture's right): positive.
    angleZ: deg(Math.atan2(up[0], -up[1])),
    // The palm facing the camera: 0; turned towards the subject's left (the picture's right): positive.
    angleX: deg(Math.atan2(n[0], -n[2])),
    thumbUp: thumbLen > 0 ? -thumb[1] / thumbLen : 0,
    tipGap: handLength > 0 ? dist(shape[4]!, shape[8]!) / handLength : Infinity,
  };
}

const SIDE_NAME: Record<HandSide, 'Left' | 'Right'> = { left: 'Left', right: 'Right' };
const other = (s: HandSide): HandSide => (s === 'left' ? 'right' : 'left');

/** The hand inputs, in the mapping editor's list. */
export const HAND_INPUTS: readonly InputInfo[] = [
  { id: 'HandLeftFound', label: 'Hand: left found', kind: 'closed', min: 0, max: 1 },
  { id: 'HandRightFound', label: 'Hand: right found', kind: 'closed', min: 0, max: 1 },
  { id: 'BothHandsFound', label: 'Hands: both found', kind: 'closed', min: 0, max: 1 },
  { id: 'HandDistance', label: 'Hands: distance between them', kind: 'closed', min: 0, max: 20 },
  ...(['Left', 'Right'] as const).flatMap((s): InputInfo[] => {
    const side = s.toLowerCase();
    return [
      { id: `Hand${s}PositionX`, label: `Hand: ${side} X`, kind: 'centered', min: -10, max: 10 },
      { id: `Hand${s}PositionY`, label: `Hand: ${side} Y`, kind: 'centered', min: -10, max: 10 },
      {
        id: `Hand${s}PositionZ`,
        label: `Hand: ${side} nearness`,
        kind: 'centered',
        min: -10,
        max: 10,
      },
      {
        id: `Hand${s}AngleX`,
        label: `Hand: ${side} left/right turn (°)`,
        kind: 'centered',
        min: -180,
        max: 180,
      },
      {
        id: `Hand${s}AngleZ`,
        label: `Hand: ${side} lean (°)`,
        kind: 'centered',
        min: -180,
        max: 180,
      },
      { id: `Hand${s}Open`, label: `Hand: ${side} open`, kind: 'open', min: 0, max: 1 },
      ...FINGERS.map((f, i): InputInfo => ({
        id: `Hand${s}Finger_${i + 1}_${f}`,
        label: `Hand: ${side} ${f.toLowerCase()} straight`,
        kind: 'open',
        min: 0,
        max: 1,
      })),
    ];
  }),
];
export const HAND_INPUT_IDS: ReadonlySet<string> = new Set(HAND_INPUTS.map((i) => i.id));

/**
 * Mochi Studio's first finger names, before the documented ones: saved mappings that use them are moved to the new names.
 */
export const RENAMED_HAND_INPUTS: Readonly<Record<string, string>> = Object.fromEntries(
  (['Left', 'Right'] as const).flatMap((s) =>
    FINGERS.map((f, i) => [`Hand${s}Finger${f}`, `Hand${s}Finger_${i + 1}_${f}`] as const),
  ),
);
/** Inputs that are 0 or 1: not smoothed. */
export const HAND_FLAGS: ReadonlySet<string> = new Set([
  'HandLeftFound',
  'HandRightFound',
  'BothHandsFound',
]);

/**
 * The hand inputs of a frame's hands (the first of each side counts). The
 * found flags are always there; a hand's own inputs only while it is found,
 * and `HandDistance` while both are.
 */
export function handInputs(hands: readonly TrackedHand[], mirror: boolean): InputValues {
  const bySide = new Map<HandSide, HandReading>();
  for (const h of hands) {
    if (bySide.has(h.side)) continue;
    const r = readHand(h);
    if (r) bySide.set(h.side, r);
  }
  const out: InputValues = {};
  const named = (s: HandSide): HandSide => (mirror ? other(s) : s);
  const sign = mirror ? -1 : 1;
  // Outwards: the subject's left hand away to its left (the picture's right), the right hand to its right.
  const outwards = (s: HandSide, x: number): number => (s === 'left' ? x - 0.5 : 0.5 - x) * 20;
  for (const s of ['left', 'right'] as const)
    out[`Hand${SIDE_NAME[named(s)]}Found`] = bySide.has(s) ? 1 : 0;
  out.BothHandsFound = bySide.size === 2 ? 1 : 0;
  for (const [s, r] of bySide) {
    const n = `Hand${SIDE_NAME[named(s)]}`;
    out[`${n}PositionX`] = clamp(outwards(s, r.palm[0]), -10, 10);
    out[`${n}PositionY`] = clamp((0.5 - r.palm[1]) * 20, -10, 10);
    out[`${n}PositionZ`] = clamp((r.size / USUAL_HAND_SIZE - 1) * 10, -10, 10);
    out[`${n}AngleX`] = clamp(sign * r.angleX, -180, 180);
    out[`${n}AngleZ`] = clamp(sign * r.angleZ, -180, 180);
    out[`${n}Open`] = r.open;
    FINGERS.forEach((f, i) => (out[`${n}Finger_${i + 1}_${f}`] = r.fingers[f]));
  }
  const l = bySide.get('left');
  const r = bySide.get('right');
  if (l && r)
    out.HandDistance = clamp(Math.hypot(l.palm[0] - r.palm[0], l.palm[1] - r.palm[1]) * 20, 0, 20);
  return out;
}

/** The readings of a frame's hands by side (the subject's own), for gestures. */
export function handReadings(
  hands: readonly TrackedHand[],
): Partial<Record<HandSide, HandReading>> {
  const out: Partial<Record<HandSide, HandReading>> = {};
  for (const h of hands) {
    if (out[h.side]) continue;
    const r = readHand(h);
    if (r) out[h.side] = r;
  }
  return out;
}
