/**
 * The mouse inputs: `MousePositionX` and
 * `MousePositionY`, the pointer within an X and a Y range in pixels that the
 * person sets, as −1 to 1.
 *
 * Mochi Studio's choices for what the documentation leaves open:
 *
 * - **The centre**: the ranges are centred on the middle of the screen (the
 *   main screen, in the desktop app) or of the page (in a browser).
 * - **Their size**: 0, the default, is the whole screen or page.
 * - **The sign**: X is positive to the right, Y positive upwards, as the
 *   other inputs' Y.
 * - **Outside the range**: the values stay at −1 or 1.
 */
import { clamp } from './math';
import type { InputValues } from './tracking';

/** The X and Y ranges in pixels; 0 is the whole screen or page. */
export interface MouseRange {
  width: number;
  height: number;
}
export const DEFAULT_MOUSE_RANGE: MouseRange = { width: 0, height: 0 };
export const MAX_MOUSE_RANGE = 20_000;

/** Where the pointer is, and the area it moves over (the screen, or the page), in pixels. */
export interface PointerSample {
  x: number;
  y: number;
  area: { x: number; y: number; width: number; height: number };
}

export function mouseInputs(
  p: PointerSample,
  range: MouseRange = DEFAULT_MOUSE_RANGE,
): InputValues {
  const { area } = p;
  const w = range.width > 0 ? range.width : area.width;
  const h = range.height > 0 ? range.height : area.height;
  const cx = area.x + area.width / 2;
  const cy = area.y + area.height / 2;
  return {
    MousePositionX: w > 0 ? clamp((p.x - cx) / (w / 2), -1, 1) : 0,
    MousePositionY: h > 0 ? clamp((cy - p.y) / (h / 2), -1, 1) : 0,
  };
}

export function parseMouseRange(raw: unknown): MouseRange {
  const o =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const px = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v)
      ? Math.round(Math.max(0, Math.min(MAX_MOUSE_RANGE, v)))
      : 0;
  return { width: px(o.width), height: px(o.height) };
}
