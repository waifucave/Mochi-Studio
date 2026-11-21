import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { nv12ToRgb, premultipliedToNv12, premultipliedToYuyv } from './yuv';

/** A BGRA frame of one premultiplied color. */
const solid = (w: number, h: number, [r, g, b, a]: number[]) => {
  const f = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) f.set([b!, g!, r!, a!], i * 4);
  return f;
};

/**
 * Test vectors for the other implementations (the Windows module in C++, the
 * macOS camera in Swift): premultiplied BGRA frames, the color under them,
 * and the NV12 bytes the reference gives. MOCHI_UPDATE_FIXTURES=1 rewrites
 * them; the test below checks they are still the reference's.
 */
const VECTORS = new URL('../../test/fixtures/nv12-vectors.json', import.meta.url);
/** The Swift package's copy (its tests' resources stay inside the package). */
const SWIFT_VECTORS = new URL(
  '../../native/maccam/Tests/MochiCameraCoreTests/nv12-vectors.json',
  import.meta.url,
);
interface Vector {
  width: number;
  height: number;
  under: number;
  bgra: number[];
  nv12: number[];
}
function vectors(): Vector[] {
  const out: Vector[] = [];
  for (const [w, h, under, seed] of [
    [2, 2, 0x000000, 1],
    [8, 4, 0x00b140, 7],
    [6, 6, 0x3366cc, 13],
  ] as const) {
    const bgra = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      // Every kind of pixel: clear, half-transparent and opaque, colors no brighter than alpha.
      const a = [0, 64, 128, 200, 255][(i * seed) % 5]!;
      bgra.set([(i * 37 + seed) % (a + 1), (i * 59) % (a + 1), (i * 83 + 1) % (a + 1), a], i * 4);
    }
    out.push({
      width: w,
      height: h,
      under,
      bgra: [...bgra],
      nv12: [...premultipliedToNv12(bgra, w, h, under)],
    });
  }
  return out;
}

describe('the camera’s NV12 (BT.709, limited range)', () => {
  it('gives the reference levels for black, white and the primaries', () => {
    const v = (rgb: number[]) => [...premultipliedToNv12(solid(2, 2, [...rgb, 255]), 2, 2, 0)];
    expect(v([0, 0, 0])).toEqual([16, 16, 16, 16, 128, 128]);
    expect(v([255, 255, 255])).toEqual([235, 235, 235, 235, 128, 128]);
    const near = (a: number[], b: number[]) => a.every((x, i) => Math.abs(x - b[i]!) <= 1);
    expect(near(v([255, 0, 0]), [63, 63, 63, 63, 102, 240])).toBe(true);
    expect(near(v([0, 255, 0]), [173, 173, 173, 173, 42, 26])).toBe(true);
    expect(near(v([0, 0, 255]), [32, 32, 32, 32, 240, 118])).toBe(true);
  });

  it('agrees with the YUYV conversion on Y, and on a block of one color', () => {
    const f = solid(4, 2, [200, 100, 50, 255]);
    const n = premultipliedToNv12(f, 4, 2, 0);
    const y = premultipliedToYuyv(f, 4, 2, 0);
    expect([...n.subarray(0, 8)]).toEqual([y[0], y[2], y[4], y[6], y[8], y[10], y[12], y[14]]);
    expect([n[8], n[9]]).toEqual([y[1], y[3]]);
  });

  it('puts transparent parts over the background color, and reads back within a level or two', () => {
    const green = 0x00b140;
    const clear = premultipliedToNv12(solid(2, 2, [0, 0, 0, 0]), 2, 2, green);
    expect(nv12ToRgb(clear, 2, 2, 1, 1)).toSatisfy((c: number[]) =>
      [0, 0xb1, 0x40].every((v, i) => Math.abs(c[i]! - v) <= 2),
    );
    for (const c of [
      [240, 180, 150],
      [20, 60, 200],
      [90, 200, 40],
    ]) {
      const f = premultipliedToNv12(solid(4, 4, [...c, 255]), 4, 4, 0);
      expect(nv12ToRgb(f, 4, 4, 3, 3)).toSatisfy((r: number[]) =>
        r.every((v, i) => Math.abs(v - c[i]!) <= 2),
      );
    }
  });

  it('takes RGBA as well, and refuses odd sizes', () => {
    const rgba = new Uint8Array(16).fill(255);
    for (let i = 0; i < 4; i++) rgba.set([255, 0, 0, 255], i * 4);
    expect(premultipliedToNv12(rgba, 2, 2, 0, undefined, 'rgba')[0]).toBe(
      premultipliedToNv12(solid(2, 2, [255, 0, 0, 255]), 2, 2, 0)[0],
    );
    expect(() => premultipliedToNv12(new Uint8Array(24), 3, 2, 0)).toThrow(/even/);
    expect(() => premultipliedToNv12(new Uint8Array(24), 2, 3, 0)).toThrow(/even/);
  });

  it('keeps the test vectors of the other implementations current', () => {
    const v = vectors();
    for (const file of [VECTORS, SWIFT_VECTORS]) {
      if (process.env.MOCHI_UPDATE_FIXTURES || !existsSync(file))
        writeFileSync(file, JSON.stringify(v) + '\n');
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(v);
    }
  });

  it('converts a 1280 × 720 frame in a few milliseconds', () => {
    const w = 1280;
    const h = 720;
    const src = solid(w, h, [120, 80, 60, 200]);
    const out = new Uint8Array((w * h * 3) / 2);
    const t = performance.now();
    for (let i = 0; i < 5; i++) premultipliedToNv12(src, w, h, 0x00b140, out);
    const ms = (performance.now() - t) / 5;
    console.log(`NV12 conversion, 1280 × 720: ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(100);
  });
});
