import { RAD2DEG } from './math';

export interface HeadPose {
  /** Degrees. Positive = the subject turns to their left (camera view). */
  yaw: number;
  /** Degrees. Positive = the subject looks up. */
  pitch: number;
  /** Degrees. Positive = the subject tilts their head to their left. */
  roll: number;
  /** Translation in the matrix's units (MediaPipe: centimetres). */
  x: number;
  y: number;
  z: number;
}

/**
 * Decomposes a 4x4 column-major rigid transform (MediaPipe's facial
 * transformation matrix) into Euler angles with R = Ry(yaw) * Rx(pitch) * Rz(roll).
 *
 * Sign conventions follow the matrix's right-handed frame (x right, y up,
 * z towards the camera). The mapping editor can invert any axis.
 */
export function poseFromMatrix(data: ArrayLike<number>): HeadPose {
  const m = (row: number, col: number): number => data[col * 4 + row] ?? 0;
  const r12 = m(1, 2);
  const pitch = Math.asin(Math.max(-1, Math.min(1, -r12)));
  const yaw = Math.atan2(m(0, 2), m(2, 2));
  const roll = Math.atan2(m(1, 0), m(1, 1));
  return {
    yaw: yaw * RAD2DEG,
    pitch: -pitch * RAD2DEG,
    roll: roll * RAD2DEG,
    x: m(0, 3),
    y: m(1, 3),
    z: m(2, 3),
  };
}

/** Builds a column-major matrix from Euler angles in degrees (for tests and fixtures). */
export function matrixFromPose(p: Partial<HeadPose>): number[] {
  const y = ((p.yaw ?? 0) / RAD2DEG) as number;
  const x = (-(p.pitch ?? 0) / RAD2DEG) as number;
  const z = ((p.roll ?? 0) / RAD2DEG) as number;
  const cy = Math.cos(y),
    sy = Math.sin(y),
    cx = Math.cos(x),
    sx = Math.sin(x),
    cz = Math.cos(z),
    sz = Math.sin(z);
  // Ry * Rx
  const a = [
    [cy, sy * sx, sy * cx],
    [0, cx, -sx],
    [-sy, cy * sx, cy * cx],
  ];
  const rz = [
    [cz, -sz, 0],
    [sz, cz, 0],
    [0, 0, 1],
  ];
  const r: number[][] = [0, 1, 2].map((i) =>
    [0, 1, 2].map((j) => [0, 1, 2].reduce((s, k) => s + a[i]![k]! * rz[k]![j]!, 0)),
  );
  const out = new Array<number>(16).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) out[j * 4 + i] = r[i]![j]!;
  out[12] = p.x ?? 0;
  out[13] = p.y ?? 0;
  out[14] = p.z ?? 0;
  out[15] = 1;
  return out;
}
