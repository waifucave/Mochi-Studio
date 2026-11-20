import type { Finger, HandSide, Point3, TrackedHand } from '../../src/core/hands';

/**
 * Synthetic hands for tests: 21 points in MediaPipe's hand-landmark order
 * (wrist, then thumb, index, middle, ring and pinky, base to tip), built
 * from a simple model. The palm faces the camera with the fingers up; each
 * finger bends its joints towards the camera by how curled it is (MCP 70°,
 * PIP 80°, DIP 50°; the thumb 50° and 60°), so the joint angles a tracker
 * would see match the straightness asked for.
 */
export interface SyntheticHandOptions {
  side: HandSide;
  /** 0 curled to 1 straight, per finger (default 1: an open hand). */
  fingers?: Partial<Record<Finger, number>>;
  /** The wrist's place in the picture, 0 to 1 (default the middle, a little low). */
  at?: [number, number];
  /** Wrist to middle knuckle, in picture widths (default 0.15). */
  size?: number;
  /** The hand's turn in the picture, degrees (0: fingers up; positive towards the picture's right). */
  roll?: number;
  /** The thumb reaches over to the index tip (a pinch or an OK sign), its tip just beside it. */
  touch?: boolean;
  /**
   * The hand's left/right turn, degrees: the palm, facing the camera at 0,
   * turns to face the picture's right for positive values (about the hand's own vertical axis).
   */
  turn?: number;
}

/** The knuckles: the middle one straight above the wrist (the hand's own line). */
const KNUCKLES: Record<Exclude<Finger, 'Thumb'>, [number, number]> = {
  Index: [0.24, 1],
  Middle: [0, 1.03],
  Ring: [-0.2, 0.98],
  Pinky: [-0.38, 0.88],
};
const SEGMENTS: Record<Exclude<Finger, 'Thumb'>, [number, number, number]> = {
  Index: [0.42, 0.26, 0.2],
  Middle: [0.46, 0.29, 0.22],
  Ring: [0.43, 0.27, 0.2],
  Pinky: [0.34, 0.21, 0.18],
};
const BENDS = [70, 80, 50].map((d) => (d * Math.PI) / 180);
const THUMB_BENDS = [50, 60].map((d) => (d * Math.PI) / 180);

type V = [number, number, number];
const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V, k: number): V => [a[0] * k, a[1] * k, a[2] * k];
const norm = (a: V): V => scale(a, 1 / Math.hypot(...a));

/** Turns a direction in its plane with the camera axis: `angle` radians towards the camera (−z). */
function bendTowardsCamera(dir: V, angle: number): V {
  const planar = Math.hypot(dir[0], dir[1]) || 1;
  const along: V = [dir[0] / planar, dir[1] / planar, 0];
  // Current elevation towards −z, plus the bend.
  const elev = Math.atan2(-dir[2], planar) + angle;
  return [along[0] * Math.cos(elev), along[1] * Math.cos(elev), -Math.sin(elev)];
}

/** Points along a chain from `start`, each segment bent further towards the camera. */
function chain(start: V, dir: V, lengths: readonly number[], bends: readonly number[]): V[] {
  const out: V[] = [];
  let p = start;
  let d = norm(dir);
  lengths.forEach((l, i) => {
    if (i > 0) d = bendTowardsCamera(d, bends[i]!);
    p = add(p, scale(d, l));
    out.push(p);
  });
  return out;
}

export function syntheticHand(o: SyntheticHandOptions): TrackedHand {
  const size = o.size ?? 0.15;
  const [ax, ay] = o.at ?? [0.5, 0.7];
  const straight = (f: Finger) => Math.max(0, Math.min(1, o.fingers?.[f] ?? 1));
  // The thumb on the side towards the body's middle: the picture's right for the right hand.
  const mirrorX = o.side === 'right' ? 1 : -1;
  // Local model: x right, y up, z towards the camera negative; in units of `size`.
  const local: V[] = Array.from({ length: 21 }, () => [0, 0, 0] as V);
  local[0] = [0, 0, 0];
  // Thumb: a base, then three segments up and out.
  const tc = 1 - straight('Thumb');
  const thumbBase: V = [0.25, 0.25, 0];
  const thumbDir: V = [0.45, 0.75, 0];
  local[1] = thumbBase;
  const thumb = chain(
    thumbBase,
    thumbDir,
    [0.3, 0.25, 0.22],
    [0, tc * THUMB_BENDS[0]!, tc * THUMB_BENDS[1]!],
  );
  local[2] = thumb[0]!;
  local[3] = thumb[1]!;
  local[4] = thumb[2]!;
  (['Index', 'Middle', 'Ring', 'Pinky'] as const).forEach((f, k) => {
    const c = 1 - straight(f);
    const [kx, ky] = KNUCKLES[f];
    const mcp: V = [kx, ky, 0];
    // The knuckle's own bend (from the wrist's line) comes first.
    const first = bendTowardsCamera(norm(mcp), c * BENDS[0]!);
    const rest = chain(mcp, first, SEGMENTS[f], [0, c * BENDS[1]!, c * BENDS[2]!]);
    const base = 5 + k * 4;
    local[base] = mcp;
    local[base + 1] = rest[0]!;
    local[base + 2] = rest[1]!;
    local[base + 3] = rest[2]!;
  });
  if (o.touch) {
    // The thumb's last joint halfway to the index tip, its tip just beside that tip.
    const tip = local[8]!;
    local[4] = add(tip, [0.06, 0, -0.02]);
    local[3] = scale(add(local[2]!, local[4]!), 0.5);
  }
  const roll = ((o.roll ?? 0) * Math.PI) / 180;
  const cos = Math.cos(roll);
  const sin = Math.sin(roll);
  const turn = ((o.turn ?? 0) * Math.PI) / 180;
  const points: Point3[] = [];
  const world: Point3[] = [];
  for (const [lx0, ly, lz0] of local) {
    // The turn about the vertical axis: the palm's normal (0, 0, −1) goes to (sin t, 0, −cos t).
    const mx = lx0 * mirrorX;
    const x = mx * Math.cos(turn) - lz0 * Math.sin(turn);
    const lz = mx * Math.sin(turn) + lz0 * Math.cos(turn);
    // Turn towards the picture's right for a positive roll.
    const rx = x * cos + ly * sin;
    const ry = -x * sin + ly * cos;
    points.push([ax + rx * size, ay - ry * size, lz * size]);
    world.push([rx * 0.08, -ry * 0.08, lz * 0.08]);
  }
  return { side: o.side, points, world, score: 0.98 };
}
