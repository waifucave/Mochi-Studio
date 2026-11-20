/** Placement of the model in the output canvas. */
export interface SceneTransform {
  /** Offset of the model centre from the canvas centre, in canvas-height units (-1..1 = one height). */
  x: number;
  y: number;
  /** 1 = the model's default fit. */
  zoom: number;
  /** Degrees, clockwise. */
  rotation: number;
}

export const DEFAULT_TRANSFORM: SceneTransform = { x: 0, y: 0, zoom: 1, rotation: 0 };
export const ZOOM_MIN = 0.1;
export const ZOOM_MAX = 10;

/** Applies a pointer drag of (dx, dy) CSS pixels on a canvas of the given height. */
export function dragTransform(
  t: SceneTransform,
  dx: number,
  dy: number,
  canvasHeight: number,
): SceneTransform {
  if (canvasHeight <= 0) return t;
  return { ...t, x: t.x + dx / canvasHeight, y: t.y + dy / canvasHeight };
}

/**
 * Zooms by `factor` around a focus point (in the same units as x/y, relative
 * to the canvas centre) so that the point under the cursor stays put.
 */
export function zoomAround(
  t: SceneTransform,
  factor: number,
  fx: number,
  fy: number,
): SceneTransform {
  const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, t.zoom * factor));
  const k = zoom / t.zoom;
  return { ...t, zoom, x: fx + (t.x - fx) * k, y: fy + (t.y - fy) * k };
}

export function normalizeRotation(deg: number): number {
  const r = ((deg % 360) + 360) % 360;
  return r > 180 ? r - 360 : r;
}
