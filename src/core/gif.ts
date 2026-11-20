/**
 * A GIF decoder for animated items: the file's structure, and
 * its frames one at a time, composited as a viewer shows them (frame
 * placement, transparency, and the three disposal methods). Frames come as
 * RGBA over the whole logical screen, in one buffer that each step reuses,
 * so even long animations need memory for two screens only.
 *
 * Written from the GIF89a format: header, logical screen, color tables,
 * graphic control extensions, image descriptors and LZW-coded data in
 * sub-blocks.
 */

export interface GifInfo {
  width: number;
  height: number;
  frames: number;
  /** Each frame's delay in milliseconds (a viewer's reading: 0 or 10 ms play as 100 ms). */
  delays: number[];
}

interface FrameHeader {
  left: number;
  top: number;
  width: number;
  height: number;
  interlaced: boolean;
  /** The color table: RGB triples. */
  palette: Uint8Array;
  transparent: number;
  disposal: number;
  delay: number;
  /** The LZW minimum code size, and where the data sub-blocks start. */
  minCodeSize: number;
  dataStart: number;
}

const u16 = (b: Uint8Array, i: number): number => b[i]! | (b[i + 1]! << 8);

/** Skips data sub-blocks from `i` (a size byte); returns the index after the terminator, or −1. */
function skipSubBlocks(b: Uint8Array, i: number): number {
  while (i < b.length) {
    const n = b[i]!;
    i += 1 + n;
    if (n === 0) return i <= b.length ? i : -1;
  }
  return -1;
}

/** The file's frames, without decoding them; undefined for anything that is not a well-formed GIF. */
function parse(
  b: Uint8Array,
): { width: number; height: number; frames: FrameHeader[] } | undefined {
  if (b.length < 14 || !/^GIF8[79]a$/.test(String.fromCharCode(...b.subarray(0, 6))))
    return undefined;
  const width = u16(b, 6);
  const height = u16(b, 8);
  if (!width || !height) return undefined;
  const flags = b[10]!;
  let i = 13;
  let global: Uint8Array = new Uint8Array(0);
  if (flags & 0x80) {
    const n = 3 << ((flags & 7) + 1);
    if (i + n > b.length) return undefined;
    global = b.subarray(i, i + n);
    i += n;
  }
  const frames: FrameHeader[] = [];
  let transparent = -1;
  let disposal = 0;
  let delay = 0;
  while (i < b.length) {
    const block = b[i]!;
    if (block === 0x3b) return frames.length ? { width, height, frames } : undefined;
    if (block === 0x21) {
      if (i + 2 > b.length) return undefined;
      // A graphic control extension sets the next frame's timing and transparency.
      if (b[i + 1] === 0xf9 && b[i + 2] === 4 && i + 7 < b.length) {
        const p = b[i + 3]!;
        disposal = (p >> 2) & 7;
        delay = u16(b, i + 4);
        transparent = p & 1 ? b[i + 6]! : -1;
      }
      i = skipSubBlocks(b, i + 2);
    } else if (block === 0x2c) {
      if (i + 10 > b.length) return undefined;
      const left = u16(b, i + 1);
      const top = u16(b, i + 3);
      const w = u16(b, i + 5);
      const h = u16(b, i + 7);
      const p = b[i + 9]!;
      i += 10;
      let palette = global;
      if (p & 0x80) {
        const n = 3 << ((p & 7) + 1);
        if (i + n > b.length) return undefined;
        palette = b.subarray(i, i + n);
        i += n;
      }
      if (i >= b.length) return undefined;
      const minCodeSize = b[i]!;
      if (minCodeSize < 1 || minCodeSize > 11) return undefined;
      const dataStart = i + 1;
      frames.push({
        left,
        top,
        width: w,
        height: h,
        interlaced: (p & 0x40) !== 0,
        palette,
        transparent,
        disposal,
        delay,
        minCodeSize,
        dataStart,
      });
      i = skipSubBlocks(b, dataStart);
      transparent = -1;
      disposal = 0;
      delay = 0;
    } else return undefined;
    if (i < 0) return undefined;
  }
  // No trailer: accept what was read (many files end early).
  return frames.length ? { width, height, frames } : undefined;
}

/** A viewer's delay: what browsers do with 0 and 10 ms (they play them as 100 ms). */
const delayMs = (cs: number): number => (cs <= 1 ? 100 : cs * 10);

/** The structure of a GIF: its size, frame count and delays; undefined if it is not a GIF. */
export function gifInfo(b: Uint8Array): GifInfo | undefined {
  const g = parse(b);
  return g
    ? {
        width: g.width,
        height: g.height,
        frames: g.frames.length,
        delays: g.frames.map((f) => delayMs(f.delay)),
      }
    : undefined;
}

/** Decodes LZW-coded GIF data (from its sub-blocks) into `out` (color indices). */
function lzw(b: Uint8Array, start: number, minCodeSize: number, out: Uint8Array): void {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  const prefix = new Int16Array(4096);
  const suffix = new Uint8Array(4096);
  const first = new Uint8Array(4096);
  const stack = new Uint8Array(4097);
  for (let c = 0; c < clear; c++) {
    prefix[c] = -1;
    suffix[c] = c;
    first[c] = c;
  }
  let size = minCodeSize + 1;
  let next = eoi + 1;
  let prev = -1;
  let acc = 0;
  let bits = 0;
  let op = 0;
  let i = start;
  let left = 0; // bytes left in the current sub-block
  const emit = (code: number): void => {
    let sp = 0;
    let c = code;
    while (c >= clear && sp < 4096) {
      stack[sp++] = suffix[c]!;
      c = prefix[c]!;
    }
    stack[sp++] = c;
    while (sp > 0 && op < out.length) out[op++] = stack[--sp]!;
  };
  for (;;) {
    while (bits < size) {
      if (left === 0) {
        if (i >= b.length) return;
        left = b[i++]!;
        if (left === 0) return; // the terminator: the data ended
      }
      if (i >= b.length) return;
      acc |= b[i++]! << bits;
      left--;
      bits += 8;
    }
    const code = acc & ((1 << size) - 1);
    acc >>>= size;
    bits -= size;
    if (code === clear) {
      size = minCodeSize + 1;
      next = eoi + 1;
      prev = -1;
      continue;
    }
    if (code === eoi || op >= out.length) return;
    if (prev < 0) {
      if (code >= clear) return; // a table code before any entry: broken data
      out[op++] = code;
      prev = code;
      continue;
    }
    let head: number;
    if (code < next) {
      emit(code);
      head = first[code]!;
    } else if (code === next) {
      // The string just being defined: the previous one and its own first byte.
      emit(prev);
      head = first[prev]!;
      if (op < out.length) out[op++] = head;
    } else return;
    if (next < 4096) {
      prefix[next] = prev;
      suffix[next] = head;
      first[next] = first[prev]!;
      next++;
      if (next === 1 << size && size < 12) size++;
    }
    prev = code;
  }
}

/** Interlaced rows in file order: every 8th from 0, every 8th from 4, every 4th from 2, every 2nd from 1. */
function interlacedRows(h: number): number[] {
  const rows: number[] = [];
  for (const [start, step] of [
    [0, 8],
    [4, 8],
    [2, 4],
    [1, 2],
  ] as const)
    for (let y = start; y < h; y += step) rows.push(y);
  return rows;
}

export interface GifFrame {
  index: number;
  /** The whole screen, RGBA, as shown at this frame. The buffer is reused by the next step. */
  rgba: Uint8ClampedArray<ArrayBuffer>;
  delay: number;
}

/**
 * The frames of a GIF, composited, one at a time. Call `gifInfo` first to
 * check the size and the frame count; this throws on a file that is not a GIF.
 */
export function* gifFrames(b: Uint8Array): Generator<GifFrame> {
  const g = parse(b);
  if (!g) throw new Error('This is not a GIF file.');
  const { width: W, height: H } = g;
  const screen = new Uint8ClampedArray(W * H * 4);
  let saved: Uint8ClampedArray | undefined;
  let prev: FrameHeader | undefined;
  for (let index = 0; index < g.frames.length; index++) {
    const f = g.frames[index]!;
    // The previous frame's disposal, before this one is drawn.
    if (prev?.disposal === 2) clearRect(screen, W, H, prev);
    else if (prev?.disposal === 3 && saved) screen.set(saved);
    if (f.disposal === 3) saved = screen.slice();
    const indices = new Uint8Array(f.width * f.height);
    lzw(b, f.dataStart, f.minCodeSize, indices);
    const rows = f.interlaced ? interlacedRows(f.height) : undefined;
    const colors = f.palette.length / 3;
    for (let r = 0; r < f.height; r++) {
      const y = f.top + (rows ? rows[r]! : r);
      if (y >= H) continue;
      for (let x = 0; x < f.width; x++) {
        const sx = f.left + x;
        if (sx >= W) break;
        const c = indices[r * f.width + x]!;
        if (c === f.transparent || c >= colors) continue;
        const o = (y * W + sx) * 4;
        screen[o] = f.palette[c * 3]!;
        screen[o + 1] = f.palette[c * 3 + 1]!;
        screen[o + 2] = f.palette[c * 3 + 2]!;
        screen[o + 3] = 255;
      }
    }
    yield { index, rgba: screen, delay: delayMs(f.delay) };
    prev = f;
  }
}

function clearRect(screen: Uint8ClampedArray, W: number, H: number, f: FrameHeader): void {
  for (let y = f.top; y < Math.min(H, f.top + f.height); y++)
    screen.fill(0, (y * W + f.left) * 4, (y * W + Math.min(W, f.left + f.width)) * 4);
}
