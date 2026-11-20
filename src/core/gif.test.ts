import { describe, expect, it } from 'vitest';
import { encodeGif, testAnimation } from '../../test/support/gif';
import { gifFrames, gifInfo } from './gif';

const red: [number, number, number] = [255, 0, 0];
const green: [number, number, number] = [0, 255, 0];
const blue: [number, number, number] = [0, 0, 255];
const white: [number, number, number] = [255, 255, 255];

const pixel = (rgba: Uint8ClampedArray, w: number, x: number, y: number): number[] => [
  ...rgba.subarray((y * w + x) * 4, (y * w + x) * 4 + 4),
];

describe('the GIF decoder', () => {
  it('reads the structure: size, frames and delays', () => {
    const g = testAnimation(40, 30, 5, 4);
    expect(gifInfo(g)).toEqual({ width: 40, height: 30, frames: 5, delays: [40, 40, 40, 40, 40] });
    // Delays of 0 and 1 cs play as 100 ms, as in browsers.
    const quick = encodeGif(2, 2, [red, green], [{ indices: new Uint8Array(4), delay: 0 }]);
    expect(gifInfo(quick)!.delays).toEqual([100]);
    expect(gifInfo(new TextEncoder().encode('GIF89a nonsense'))).toBeUndefined();
    expect(gifInfo(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeUndefined();
  });

  it('decodes LZW data through code-size changes and table resets', () => {
    // 256 × 256 of varied indices: thousands of codes, so the table fills and is cleared.
    const w = 256;
    const h = 256;
    const palette = Array.from({ length: 256 }, (_, i) => [i, 255 - i, (i * 7) & 255] as const);
    const indices = new Uint8Array(w * h);
    let seed = 7;
    for (let i = 0; i < indices.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      // Runs of repeated values compress, random ones grow the table fast.
      indices[i] = i % 3 === 0 ? (seed >> 16) & 255 : indices[Math.max(0, i - 1)]!;
    }
    const g = encodeGif(w, h, palette, [{ indices }]);
    const [f] = [...gifFrames(g)];
    for (const i of [0, 1, 2, 1000, 33333, w * h - 1]) {
      const c = palette[indices[i]!]!;
      expect(pixel(f!.rgba, w, i % w, Math.floor(i / w))).toEqual([c[0], c[1], c[2], 255]);
    }
  });

  it('composites frames: placement, transparency and the disposal methods', () => {
    const W = 4;
    const H = 4;
    const all = (c: number): Uint8Array => new Uint8Array(W * H).fill(c);
    const g = encodeGif(
      W,
      H,
      [red, green, blue, white],
      [
        // 0: red everywhere.
        { indices: all(0) },
        // 1: a green 2 × 2 at (1, 1), drawn over red (no disposal of frame 0).
        { indices: new Uint8Array(4).fill(1), left: 1, top: 1, width: 2, height: 2, disposal: 2 },
        // 2: frame 1's rectangle was cleared (disposal 2); a blue pixel with a transparent rest.
        {
          indices: Uint8Array.from([2, 3, 3, 3]),
          left: 0,
          top: 0,
          width: 2,
          height: 2,
          transparent: 3,
          disposal: 3,
        },
        // 3: frame 2 is undone (disposal 3): white at (3, 3) only.
        { indices: Uint8Array.from([3]), left: 3, top: 3, width: 1, height: 1 },
      ],
    );
    // Copied as they come: the decoder reuses one buffer.
    const frames = Array.from(gifFrames(g), (f) => f.rgba.slice());
    expect(frames).toHaveLength(4);
    expect(pixel(frames[0]!, W, 2, 2)).toEqual([255, 0, 0, 255]);
    expect(pixel(frames[1]!, W, 1, 1)).toEqual([0, 255, 0, 255]);
    expect(pixel(frames[1]!, W, 0, 0)).toEqual([255, 0, 0, 255]);
    // Disposal 2 left the rectangle transparent; the blue pixel is drawn, the transparent ones are not.
    expect(pixel(frames[2]!, W, 0, 0)).toEqual([0, 0, 255, 255]);
    expect(pixel(frames[2]!, W, 1, 1)).toEqual([0, 0, 0, 0]);
    expect(pixel(frames[2]!, W, 3, 0)).toEqual([255, 0, 0, 255]);
    // Disposal 3 restored the screen as it was before frame 2.
    expect(pixel(frames[3]!, W, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(pixel(frames[3]!, W, 1, 1)).toEqual([0, 0, 0, 0]);
    expect(pixel(frames[3]!, W, 3, 3)).toEqual([255, 255, 255, 255]);
  });

  it('reads interlaced frames', () => {
    const W = 3;
    const H = 9;
    const indices = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) indices.fill(y % 3, y * W, (y + 1) * W);
    const g = encodeGif(W, H, [red, green, blue], [{ indices, interlaced: true }]);
    const [f] = [...gifFrames(g)];
    for (let y = 0; y < H; y++)
      expect(pixel(f!.rgba, W, 1, y)).toEqual([...[red, green, blue][y % 3]!, 255]);
  });
});
