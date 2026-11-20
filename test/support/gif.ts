/**
 * A small GIF89a encoder for tests: indexed frames, a global palette,
 * graphic control extensions (delay, transparency, disposal), interlacing
 * on request, and real LZW compression (codes grow to 12 bits, and the
 * table is cleared when full), so the decoder's paths are all exercised.
 */

export interface TestGifFrame {
  /** Color indices, `width × height` of the frame's rectangle. */
  indices: Uint8Array;
  left?: number;
  top?: number;
  width?: number;
  height?: number;
  /** Centiseconds. */
  delay?: number;
  disposal?: 0 | 1 | 2 | 3;
  transparent?: number;
  interlaced?: boolean;
}

function lzwEncode(indices: Uint8Array, minCodeSize: number): Uint8Array {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let size = minCodeSize + 1;
  let next = eoi + 1;
  const dict = new Map<number, number>();
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  const put = (code: number): void => {
    acc |= code << bits;
    bits += size;
    while (bits >= 8) {
      out.push(acc & 255);
      acc >>>= 8;
      bits -= 8;
    }
  };
  put(clear);
  if (!indices.length) {
    put(eoi);
    if (bits > 0) out.push(acc & 255);
    return Uint8Array.from(out);
  }
  let cur = indices[0]!;
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i]!;
    const key = cur * 4096 + k;
    const found = dict.get(key);
    if (found !== undefined) {
      cur = found;
      continue;
    }
    put(cur);
    const added = next++;
    dict.set(key, added);
    if (added === 1 << size && size < 12) size++;
    if (next === 4096) {
      put(clear);
      dict.clear();
      size = minCodeSize + 1;
      next = eoi + 1;
    }
    cur = k;
  }
  put(cur);
  put(eoi);
  if (bits > 0) out.push(acc & 255);
  return Uint8Array.from(out);
}

function interlace(indices: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(indices.length);
  let r = 0;
  for (const [start, step] of [
    [0, 8],
    [4, 8],
    [2, 4],
    [1, 2],
  ] as const)
    for (let y = start; y < h; y += step) out.set(indices.subarray(y * w, (y + 1) * w), w * r++);
  return out;
}

/** Encodes an animated GIF. `palette` holds RGB triples (at most 256). */
export function encodeGif(
  width: number,
  height: number,
  palette: ReadonlyArray<readonly [number, number, number]>,
  frames: readonly TestGifFrame[],
): Uint8Array {
  const bytes: number[] = [];
  const u16 = (v: number): void => void bytes.push(v & 255, (v >> 8) & 255);
  const sizeBits = Math.max(1, Math.ceil(Math.log2(Math.max(2, palette.length))));
  bytes.push(...[...'GIF89a'].map((c) => c.charCodeAt(0)));
  u16(width);
  u16(height);
  bytes.push(0x80 | (7 << 4) | (sizeBits - 1), 0, 0);
  for (let i = 0; i < 1 << sizeBits; i++) bytes.push(...(palette[i] ?? [0, 0, 0]));
  // Loop forever (the NETSCAPE2.0 application extension).
  bytes.push(0x21, 0xff, 11, ...[...'NETSCAPE2.0'].map((c) => c.charCodeAt(0)), 3, 1, 0, 0, 0);
  const minCodeSize = Math.max(2, sizeBits);
  for (const f of frames) {
    const fw = f.width ?? width;
    const fh = f.height ?? height;
    const t = f.transparent ?? -1;
    bytes.push(0x21, 0xf9, 4, ((f.disposal ?? 0) << 2) | (t >= 0 ? 1 : 0));
    u16(f.delay ?? 10);
    bytes.push(t >= 0 ? t : 0, 0);
    bytes.push(0x2c);
    u16(f.left ?? 0);
    u16(f.top ?? 0);
    u16(fw);
    u16(fh);
    bytes.push(f.interlaced ? 0x40 : 0);
    bytes.push(minCodeSize);
    const data = lzwEncode(f.interlaced ? interlace(f.indices, fw, fh) : f.indices, minCodeSize);
    for (let i = 0; i < data.length; i += 255) {
      const n = Math.min(255, data.length - i);
      bytes.push(n, ...data.subarray(i, i + n));
    }
    bytes.push(0);
  }
  bytes.push(0x3b);
  return Uint8Array.from(bytes);
}

/** A test animation: `count` frames of w × h, frame i a solid color i of the palette, with a moving bar. */
export function testAnimation(w: number, h: number, count: number, delay = 10): Uint8Array {
  const palette: Array<[number, number, number]> = [
    [230, 40, 40],
    [40, 200, 70],
    [40, 90, 230],
    [240, 200, 30],
    [160, 60, 200],
    [20, 20, 20],
    [250, 250, 250],
    [0, 180, 200],
  ];
  const frames: TestGifFrame[] = [];
  for (let i = 0; i < count; i++) {
    const indices = new Uint8Array(w * h).fill(i % 6);
    // A dark bar that moves, so neighbouring frames differ in more than color.
    const x0 = Math.floor((i / count) * w);
    for (let y = 0; y < h; y++)
      for (let x = x0; x < Math.min(w, x0 + 4); x++) indices[y * w + x] = 5;
    frames.push({ indices, delay });
  }
  return encodeGif(w, h, palette, frames);
}
