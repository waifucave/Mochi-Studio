import { describe, expect, it } from 'vitest';
import { matrixFromPose, poseFromMatrix } from './headPose';

describe('poseFromMatrix', () => {
  it('reads the identity as a neutral pose', () => {
    const p = poseFromMatrix(matrixFromPose({}));
    expect(p.yaw).toBeCloseTo(0);
    expect(p.pitch).toBeCloseTo(0);
    expect(p.roll).toBeCloseTo(0);
  });

  it.each([
    { yaw: 20, pitch: 0, roll: 0 },
    { yaw: 0, pitch: -15, roll: 0 },
    { yaw: 0, pitch: 0, roll: 30 },
    { yaw: -25, pitch: 12, roll: -8 },
  ])('round-trips %o', (pose) => {
    const p = poseFromMatrix(matrixFromPose({ ...pose, x: 1, y: 2, z: -40 }));
    expect(p.yaw).toBeCloseTo(pose.yaw, 6);
    expect(p.pitch).toBeCloseTo(pose.pitch, 6);
    expect(p.roll).toBeCloseTo(pose.roll, 6);
    expect([p.x, p.y, p.z]).toEqual([1, 2, -40]);
  });

  it('reads a column-major yaw rotation with the documented sign', () => {
    // Rotation of 30° about +Y, written out by hand (column-major).
    const c = Math.cos(Math.PI / 6),
      s = Math.sin(Math.PI / 6);
    const m = [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
    expect(poseFromMatrix(m).yaw).toBeCloseTo(30, 6);
  });
});
