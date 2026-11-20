import { encodePng } from '../core/png';

/**
 * Up to this many pixels, a canvas's PNG is encoded here (about 25 ms for
 * 512 × 512); above, by the browser, off the main thread. Chrome encodes in
 * idle time, which a page that draws every frame doesn't have, so the
 * browser's encode takes about a second however small the picture
 * (src/core/png.ts); a large one would hold up frames here instead.
 */
export const OWN_PNG_MAX_PIXELS = 512 * 512;

/** A 2D context for a canvas whose PNG `canvasPng` makes (read back on the CPU when small). */
export function pngContext(c: OffscreenCanvas): OffscreenCanvasRenderingContext2D {
  return c.getContext('2d', {
    willReadFrequently: c.width * c.height <= OWN_PNG_MAX_PIXELS,
  }) as OffscreenCanvasRenderingContext2D;
}

/** The canvas's picture as a PNG (its 2D context made with `pngContext`). */
export async function canvasPng(c: OffscreenCanvas): Promise<Uint8Array> {
  if (c.width * c.height <= OWN_PNG_MAX_PIXELS) {
    const g = pngContext(c);
    return encodePng(c.width, c.height, g.getImageData(0, 0, c.width, c.height).data);
  }
  return new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
}
