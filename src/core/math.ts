export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Maps `v` from [inMin, inMax] to [outMin, outMax] linearly (no clamping). */
export function remap(
  v: number,
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number,
): number {
  const span = inMax - inMin;
  if (span === 0) return outMin;
  return outMin + ((v - inMin) / span) * (outMax - outMin);
}

export const RAD2DEG = 180 / Math.PI;
