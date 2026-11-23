import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { CameraFeed, type CameraDevice } from './cameraFeed';
import {
  cameraPageUrl,
  DEFAULT_VIRTUAL_CAMERA,
  parseVirtualCamera,
  parseVirtualCameraConfig,
  virtualCameraConfig,
} from './virtualCamera';
import { premultipliedToYuyv, yuyvToRgb } from './yuv';

/** A BGRA frame of one premultiplied color. */
const solid = (w: number, h: number, [r, g, b, a]: number[]) => {
  const f = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) f.set([b!, g!, r!, a!], i * 4);
  return f;
};

describe('the camera’s YUYV (BT.709, limited range)', () => {
  it('gives the reference levels for black, white and the primaries', () => {
    const y = (rgb: number[]) => [...premultipliedToYuyv(solid(2, 1, [...rgb, 255]), 2, 1, 0)];
    expect(y([0, 0, 0])).toEqual([16, 128, 16, 128]);
    expect(y([255, 255, 255])).toEqual([235, 128, 235, 128]);
    // BT.709 limited range: red Y 63, Cb 102, Cr 240; green 173, 42, 26; blue 32, 240, 118.
    const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]!) <= 1);
    expect(near(y([255, 0, 0]), [63, 102, 63, 240])).toBe(true);
    expect(near(y([0, 255, 0]), [173, 42, 173, 26])).toBe(true);
    expect(near(y([0, 0, 255]), [32, 240, 32, 118])).toBe(true);
  });

  it('puts transparent parts over the background color, and half-transparent ones half', () => {
    const green = 0x00b140;
    const clear = premultipliedToYuyv(solid(2, 1, [0, 0, 0, 0]), 2, 1, green);
    expect(yuyvToRgb(clear, 2, 0, 0)).toSatisfy((c: number[]) =>
      [0, 0xb1, 0x40].every((v, i) => Math.abs(c[i]! - v) <= 2),
    );
    // White at half opacity (premultiplied 128) over black is mid grey.
    const half = premultipliedToYuyv(solid(2, 1, [128, 128, 128, 128]), 2, 1, 0);
    expect(yuyvToRgb(half, 2, 1, 0)).toSatisfy((c: number[]) =>
      c.every((v) => Math.abs(v - 128) <= 2),
    );
  });

  it('reads back to the colors it was given, within a level or two', () => {
    const colors = [
      [240, 180, 150],
      [20, 60, 200],
      [90, 200, 40],
    ];
    for (const c of colors) {
      const f = premultipliedToYuyv(solid(4, 2, [...c, 255]), 4, 2, 0);
      expect(yuyvToRgb(f, 4, 3, 1)).toSatisfy((r: number[]) =>
        r.every((v, i) => Math.abs(v - c[i]!) <= 2),
      );
    }
  });

  it('takes RGBA as well, and refuses odd widths', () => {
    const rgba = new Uint8Array([255, 0, 0, 255, 255, 0, 0, 255]);
    expect([...premultipliedToYuyv(rgba, 2, 1, 0, undefined, 'rgba')][0]).toBeCloseTo(63, -0.5);
    expect(() => premultipliedToYuyv(new Uint8Array(12), 3, 1, 0)).toThrow(/even/);
  });

  it('converts a 1280 × 720 frame in a few milliseconds', () => {
    const f = solid(1280, 720, [120, 90, 75, 128]);
    const out = new Uint8Array(1280 * 720 * 2);
    premultipliedToYuyv(f, 1280, 720, 0, out);
    const t = performance.now();
    for (let i = 0; i < 10; i++) premultipliedToYuyv(f, 1280, 720, 0, out);
    const ms = (performance.now() - t) / 10;
    console.log(`YUYV conversion, 1280 × 720: ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(33);
  });
});

/** A fake device: it keeps the format and the frames written. */
function fakeDevice(): CameraDevice & { format?: number[]; writes: Uint8Array[]; closed: boolean } {
  const d = {
    path: '/dev/fake',
    format: undefined as number[] | undefined,
    writes: [] as Uint8Array[],
    closed: false,
    setFormat(w: number, h: number, fps: number) {
      d.format = [w, h, fps];
    },
    write(f: Uint8Array) {
      d.writes.push(f.slice());
    },
    close() {
      d.closed = true;
    },
  };
  return d;
}

/** Timers the test moves by hand. */
function fakeTimers() {
  let now = 0;
  const intervals: { fn: () => void; ms: number; next: number }[] = [];
  return {
    now: () => now,
    setInterval: (fn: () => void, ms: number) => {
      const t = { fn, ms, next: now + ms };
      intervals.push(t);
      return t;
    },
    clearInterval: (t: unknown) => {
      intervals.splice(intervals.indexOf(t as never), 1);
    },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const t = intervals.sort((a, b) => a.next - b.next)[0];
        if (!t || t.next > end) break;
        now = t.next;
        t.next += t.ms;
        t.fn();
      }
      now = end;
    },
  };
}

describe('the camera’s writer, against a fake device', () => {
  const o = { width: 4, height: 2, fps: 30, under: 0 };

  it('sets the format, and writes the newest frame at the camera’s rate, new or repeated', () => {
    const d = fakeDevice();
    const t = fakeTimers();
    const feed = new CameraFeed(d, o, t);
    feed.start();
    expect(d.format).toEqual([4, 2, 30]);
    // Nothing yet: nothing is written.
    t.advance(200);
    expect(d.writes).toHaveLength(0);
    feed.frame(solid(4, 2, [255, 255, 255, 255]), 4, 2);
    expect(d.writes).toHaveLength(1);
    expect(d.writes[0]![0]).toBe(235);
    expect(d.writes[0]).toHaveLength(4 * 2 * 2);
    // Painting every frame: 30 a second, no more.
    for (let i = 0; i < 30; i++) {
      t.advance(1000 / 30);
      feed.frame(solid(4, 2, [0, 0, 0, 255]), 4, 2);
    }
    expect(d.writes.length).toBeGreaterThanOrEqual(30);
    expect(d.writes.length).toBeLessThanOrEqual(32);
    // A still page: the last frame again, 30 a second.
    let before = d.writes.length;
    t.advance(1000);
    expect(d.writes.length - before).toBeGreaterThanOrEqual(29);
    expect(d.writes.length - before).toBeLessThanOrEqual(31);
    // A page held to 10 frames a second: still 30 a second.
    before = d.writes.length;
    for (let i = 0; i < 10; i++) {
      feed.frame(solid(4, 2, [0, 0, 0, 255]), 4, 2);
      t.advance(100);
    }
    expect(d.writes.length - before).toBeGreaterThanOrEqual(29);
    expect(d.writes.length - before).toBeLessThanOrEqual(31);
    expect(d.writes.at(-1)![0]).toBe(16);
    expect(feed.converted).toBe(41);
    feed.stop();
    expect(d.closed).toBe(true);
    const after = d.writes.length;
    t.advance(1000);
    expect(d.writes.length).toBe(after);
  });

  it('keeps the error of a frame of the wrong size or a failed write, and goes on', () => {
    const d = fakeDevice();
    const t = fakeTimers();
    const feed = new CameraFeed(d, o, t);
    feed.start();
    feed.frame(solid(2, 2, [0, 0, 0, 255]), 2, 2);
    expect(feed.error).toMatch(/2 × 2 for a camera of 4 × 2/);
    expect(d.writes).toHaveLength(0);
    d.write = () => {
      throw new Error('No space left on device');
    };
    feed.frame(solid(4, 2, [0, 0, 0, 255]), 4, 2);
    expect(feed.error).toBe('No space left on device');
    // A size error ends with a frame of the right size (a page still laid out).
    feed.frame(solid(2, 2, [0, 0, 0, 255]), 2, 2);
    d.write = (f) => d.writes.push(f.slice());
    feed.frame(solid(4, 2, [0, 0, 0, 255]), 4, 2);
    // Written at the next tick: the error ends with it.
    t.advance(1000 / 30);
    expect(feed.error).toBeUndefined();
    d.writes.length = 0;
    feed.frame(solid(4, 2, [0, 0, 0, 255]), 4, 2);
    t.advance(1000 / 30);
    expect(feed.error).toBeUndefined();
    expect(d.writes).toHaveLength(1);
  });
});

describe('the camera’s settings', () => {
  it('reads what is valid and keeps defaults for the rest', () => {
    expect(parseVirtualCamera(undefined)).toEqual(DEFAULT_VIRTUAL_CAMERA);
    expect(
      parseVirtualCamera({
        enabled: true,
        width: 1920,
        height: 1080,
        fps: 60,
        mirror: true,
        background: { kind: 'color', color: '#00b140' },
      }),
    ).toEqual({
      enabled: true,
      width: 1920,
      height: 1080,
      fps: 60,
      mirror: true,
      background: { kind: 'color', color: '#00B140' },
    });
    // Sizes and rates the camera doesn't offer, and a bad color.
    expect(
      parseVirtualCamera({
        width: 1000,
        height: 1000,
        fps: 25,
        background: { kind: 'color', color: 'red' },
      }),
    ).toMatchObject({ width: 1280, height: 720, fps: 30, background: { kind: 'stage' } });
  });

  it('turns them into the main process’s configuration, which checks them again', () => {
    const page = 'http://127.0.0.1:4000/app/output.html';
    const c = virtualCameraConfig(
      { ...DEFAULT_VIRTUAL_CAMERA, enabled: true, background: { kind: 'color', color: '#00B140' } },
      page,
    );
    expect(c).toMatchObject({ under: 0x00b140, stageBackground: false });
    expect(cameraPageUrl(c)).toBe(`${page}?camera=1&transparent=1`);
    expect(cameraPageUrl({ ...c, stageBackground: true, mirror: true })).toBe(
      `${page}?camera=1&mirror=1`,
    );
    expect(parseVirtualCameraConfig(c, 'http://127.0.0.1:4000')).toEqual(c);
    // Another origin or page, a size not offered: refused.
    expect(parseVirtualCameraConfig(c, 'http://127.0.0.1:5000')).toBeUndefined();
    expect(
      parseVirtualCameraConfig(
        { ...c, page: 'http://127.0.0.1:4000/app/index.html' },
        'http://127.0.0.1:4000',
      ),
    ).toBeUndefined();
    expect(
      parseVirtualCameraConfig({ ...c, width: 640, height: 480 }, 'http://127.0.0.1:4000'),
    ).toBeUndefined();
  });
});

// The native module's conversion (native/v4l2, Linux), when it was built: the same bytes.
const nativePath = new URL('../../native/v4l2/build/Release/mochi_v4l2.node', import.meta.url);
const native = (() => {
  if (process.platform !== 'linux' || !existsSync(nativePath)) return undefined;
  return createRequire(import.meta.url)(nativePath.pathname) as {
    convert(s: Uint8Array, w: number, h: number, u: number, d: Uint8Array, rgba?: boolean): void;
  };
})();
describe.skipIf(!native)('the native module’s conversion (Linux, after npm run build:v4l2)', () => {
  it('gives the same bytes as the reference, much faster', () => {
    const w = 1280;
    const h = 720;
    const src = new Uint8Array(w * h * 4);
    // Every premultiplied value: colors no brighter than their alpha.
    for (let i = 0; i < w * h; i++) {
      const a = (i * 7) % 256;
      src.set([(i * 13) % (a + 1), (i * 29) % (a + 1), (i * 31) % (a + 1), a], i * 4);
    }
    for (const [under, rgba] of [
      [0x000000, false],
      [0x00b140, false],
      [0x3366cc, true],
    ] as const) {
      const a = premultipliedToYuyv(src, w, h, under, undefined, rgba ? 'rgba' : 'bgra');
      const b = new Uint8Array(w * h * 2);
      native!.convert(src, w, h, under, b, rgba);
      expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).toBe(0);
    }
    const out = new Uint8Array(w * h * 2);
    const t = performance.now();
    for (let i = 0; i < 20; i++) native!.convert(src, w, h, 0, out);
    const ms = (performance.now() - t) / 20;
    console.log(`Native YUYV conversion, 1280 × 720: ${ms.toFixed(2)} ms`);
    expect(ms).toBeLessThan(10);
  });
});
