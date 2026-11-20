/**
 * Frames for the virtual camera (docs/virtual-camera.md): Chromium's frames
 * (premultiplied BGRA) composited over a solid color, since video apps show
 * no transparency, and converted to YUYV (4:2:2), the format V4L2 apps
 * accept most widely.
 *
 * BT.709, limited range (Y 16–235, Cb and Cr 16–240), as video apps expect
 * for HD. Each pair of pixels shares its Cb and Cr, from the pair's average.
 */

/** Fixed-point weights (× 2¹⁶) of 8-bit R, G, B for Y, Cb and Cr, limited range. */
const S = 1 << 16;
const W = (v: number) => Math.round(v * S);
// Y = 16 + 219/255 · (0.2126 R + 0.7152 G + 0.0722 B)
const YR = W((0.2126 * 219) / 255);
const YG = W((0.7152 * 219) / 255);
const YB = W((0.0722 * 219) / 255);
// Cb = 128 + 224/255 · (B − Y′) / 1.8556, Cr = 128 + 224/255 · (R − Y′) / 1.5748
const C = 224 / 255;
const UR = W((-0.2126 / 1.8556) * C);
const UG = W((-0.7152 / 1.8556) * C);
const UB = W(0.5 * C);
const VR = W(0.5 * C);
const VG = W((-0.7152 / 1.5748) * C);
const VB = W((-0.0722 / 1.5748) * C);
const HALF = S >> 1;

/**
 * Converts a premultiplied BGRA (or RGBA) frame to YUYV over `under`
 * (0xRRGGBB). `width` must be even. Writes into `out` when given (2 bytes a
 * pixel), and returns it.
 */
export function premultipliedToYuyv(
  src: Uint8Array,
  width: number,
  height: number,
  under: number,
  out: Uint8Array = new Uint8Array(width * height * 2),
  order: 'bgra' | 'rgba' = 'bgra',
): Uint8Array {
  if (width % 2) throw new Error('The width must be even.');
  if (src.length < width * height * 4) throw new Error('The frame is smaller than its size.');
  const ur = (under >> 16) & 255;
  const ug = (under >> 8) & 255;
  const ub = under & 255;
  const ri = order === 'bgra' ? 2 : 0;
  const bi = order === 'bgra' ? 0 : 2;
  // The color under each alpha, per channel: under · (255 − a) / 255, rounded down after + 127.
  const tr = new Int32Array(256);
  const tg = new Int32Array(256);
  const tb = new Int32Array(256);
  for (let a = 0; a < 256; a++) {
    tr[a] = Math.floor((ur * (255 - a) + 127) / 255);
    tg[a] = Math.floor((ug * (255 - a) + 127) / 255);
    tb[a] = Math.floor((ub * (255 - a) + 127) / 255);
  }
  const n = width * height;
  for (let p = 0, o = 0; p < n; p += 2, o += 4) {
    const i = p * 4;
    // Over the color: c + under · (1 − a), with c premultiplied.
    const a0 = src[i + 3]!;
    const r0 = src[i + ri]! + tr[a0]!;
    const g0 = src[i + 1]! + tg[a0]!;
    const b0 = src[i + bi]! + tb[a0]!;
    const a1 = src[i + 7]!;
    const r1 = src[i + 4 + ri]! + tr[a1]!;
    const g1 = src[i + 5]! + tg[a1]!;
    const b1 = src[i + 4 + bi]! + tb[a1]!;
    out[o] = 16 + ((YR * r0 + YG * g0 + YB * b0 + HALF) >> 16);
    out[o + 2] = 16 + ((YR * r1 + YG * g1 + YB * b1 + HALF) >> 16);
    // Cb and Cr of the pair's average (sums of two, halved in the shift).
    const r = r0 + r1;
    const g = g0 + g1;
    const b = b0 + b1;
    out[o + 1] = 128 + ((UR * r + UG * g + UB * b + S) >> 17);
    out[o + 3] = 128 + ((VR * r + VG * g + VB * b + S) >> 17);
  }
  return out;
}

/** YUYV back to RGB (BT.709, limited range): for tests and checks of a received frame. */
export function yuyvToRgb(yuyv: Uint8Array, width: number, x: number, y: number): number[] {
  const pair = (y * width + (x & ~1)) * 2;
  const Y = yuyv[pair + (x & 1) * 2]! - 16;
  const U = yuyv[pair + 1]! - 128;
  const V = yuyv[pair + 3]! - 128;
  const k = 255 / 219;
  const kc = 255 / 224;
  const r = k * Y + kc * 1.5748 * V;
  const g = k * Y - kc * ((0.2126 * 1.5748) / 0.7152) * V - kc * ((0.0722 * 1.8556) / 0.7152) * U;
  const b = k * Y + kc * 1.8556 * U;
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return [c(r), c(g), c(b)];
}
