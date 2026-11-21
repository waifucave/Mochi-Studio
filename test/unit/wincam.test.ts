import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nv12ToRgb, premultipliedToNv12 } from '../../src/core/yuv';

/**
 * The Windows virtual camera's native parts (docs/virtual-camera.md), on
 * GitHub's Windows runner (desktop.yml, the wincam job), after
 * `npm run build:wincam` and `regsvr32` of the DirectShow camera:
 *
 * - the module's NV12 conversion gives the reference's bytes;
 * - the module writes frames to the ring, and a DirectShow app (ffmpeg's
 *   dshow input, as an app opens a camera) lists "Mochi Studio Camera" and
 *   reads them, in NV12, YUY2 and RGB32, at the size sent and scaled;
 * - while nothing is sent, it reads the still card;
 * - Windows 11's camera (Media Foundation): the module makes it, Media
 *   Foundation lists it, and another process reads the frames sent and the
 *   card, as an app does. Where the system can't make it (no Frame Server),
 *   the test says why and skips.
 *
 * MOCHI_WINCAM_TEST=1 turns it on; the cameras must be registered.
 */
const run = process.platform === 'win32' && !!process.env.MOCHI_WINCAM_TEST;
const modulePath = join(process.cwd(), 'native/wincam/build/Release/mochi_wincam.node');

interface WincamAddon {
  open(w: number, h: number, fps: number): { local: boolean; global: boolean };
  write(frame: Uint8Array): number;
  close(): void;
  convert(s: Uint8Array, w: number, h: number, u: number, d: Uint8Array, rgba?: boolean): void;
  installed(): {
    dshow: boolean;
    dshowPath: string;
    dshow32: boolean;
    mf: boolean;
    mfPath: string;
    mfAvailable: boolean;
  };
  peek(): { open: boolean; sequence?: number; width?: number; height?: number };
  mfState(): MfState;
  mfStart(): MfState;
  mfStop(): MfState;
  mfDevices(): string[];
}
interface MfState {
  available: boolean;
  problem?: string;
  running: boolean;
  error?: string;
}
const addon = (): WincamAddon => createRequire(import.meta.url)(modulePath) as WincamAddon;

/** A BGRA frame: four quadrants (red, green, blue, white), opaque. */
function quadrants(w: number, h: number): Uint8Array {
  const f = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const q = (y < h / 2 ? 0 : 2) + (x < w / 2 ? 0 : 1);
      const [r, g, b] = [
        [255, 0, 0],
        [0, 255, 0],
        [0, 0, 255],
        [255, 255, 255],
      ][q]!;
      f.set([b!, g!, r!, 255], (y * w + x) * 4);
    }
  return f;
}

/** One frame from the camera, as ffmpeg's DirectShow input reads it, as RGB. */
function grab(size: string, pixelFormat: string): { rgb: Buffer; width: number; height: number } {
  const out = join(mkdtempSync(join(tmpdir(), 'mochi-dshow-')), 'frame.rgb');
  const [width, height] = size.split('x').map(Number) as [number, number];
  execFileSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'dshow',
      '-video_size',
      size,
      '-pixel_format',
      pixelFormat,
      '-i',
      'video=Mochi Studio Camera',
      // A few frames in (the first may predate the latest write); the camera's YUV is
      // BT.709 limited range, which ffmpeg doesn't assume for an untagged frame.
      '-vf',
      'select=gte(n\\,5),scale=in_color_matrix=bt709:in_range=tv',
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-y',
      out,
    ],
    { timeout: 60_000, stdio: ['ignore', 'inherit', 'inherit'] },
  );
  return { rgb: readFileSync(out), width, height };
}

const at = (f: { rgb: Buffer; width: number }, x: number, y: number) => {
  const i = (y * f.width + x) * 3;
  return [f.rgb[i]!, f.rgb[i + 1]!, f.rgb[i + 2]!];
};
const near = (a: number[], b: number[], d = 12) => a.every((v, i) => Math.abs(v - b[i]!) <= d);

describe.skipIf(!run)('the Windows virtual camera (native, on the runner)', () => {
  let timer: ReturnType<typeof setInterval> | undefined;
  beforeAll(() => {
    expect(existsSync(modulePath), modulePath).toBe(true);
  });
  afterAll(() => {
    if (timer) clearInterval(timer);
    addon().close();
  });

  it('converts to NV12 exactly as the reference, much faster', () => {
    const w = 1280;
    const h = 720;
    const src = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const a = (i * 7) % 256;
      src.set([(i * 13) % (a + 1), (i * 29) % (a + 1), (i * 31) % (a + 1), a], i * 4);
    }
    for (const [under, rgba] of [
      [0x000000, false],
      [0x00b140, false],
      [0x3366cc, true],
    ] as const) {
      const a = premultipliedToNv12(src, w, h, under, undefined, rgba ? 'rgba' : 'bgra');
      const b = new Uint8Array((w * h * 3) / 2);
      addon().convert(src, w, h, under, b, rgba);
      expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).toBe(0);
    }
    const out = new Uint8Array((w * h * 3) / 2);
    const t = performance.now();
    for (let i = 0; i < 20; i++) addon().convert(src, w, h, 0, out);
    const ms = (performance.now() - t) / 20;
    console.log(`Native NV12 conversion, 1280 × 720: ${ms.toFixed(2)} ms`);
    expect(ms).toBeLessThan(15);
  });

  it('is registered for every app, 64-bit and 32-bit', () => {
    const i = addon().installed();
    console.log('Installed:', JSON.stringify(i));
    expect(i.dshow).toBe(true);
    expect(i.dshowPath).toMatch(/mochi_camera_dshow\.dll$/i);
    expect(i.dshow32).toBe(true);
  });

  it('is listed by DirectShow apps as Mochi Studio Camera', () => {
    const r = spawnSync(
      'ffmpeg',
      ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'],
      {
        encoding: 'utf8',
        timeout: 60_000,
      },
    );
    const text = `${r.stdout}${r.stderr}`;
    console.log(text);
    expect(text).toContain('"Mochi Studio Camera"');
  });

  it('shows the still card while nothing is sent', () => {
    const f = grab('1280x720', 'nv12');
    // The card's dark background at the corner (#222633), and lighter text in the middle row.
    expect(near(at(f, 4, 4), [0x22, 0x26, 0x33])).toBe(true);
    let light = 0;
    for (let x = 0; x < 1280; x += 2) if (at(f, x, 330)[0]! > 150) light++;
    console.log(`Card: corner ${at(f, 4, 4)}, light pixels in the title row: ${light}`);
  });

  it('reads the frames sent, in NV12, YUY2 and RGB32, at their size and scaled', () => {
    const w = 1280;
    const h = 720;
    const a = addon();
    expect(a.open(w, h, 30).local).toBe(true);
    const nv12 = new Uint8Array((w * h * 3) / 2);
    a.convert(quadrants(w, h), w, h, 0, nv12);
    a.write(nv12);
    timer = setInterval(() => a.write(nv12), 33);
    expect(a.peek()).toMatchObject({ open: true, width: w, height: h });
    for (const [size, format] of [
      ['1280x720', 'nv12'],
      ['1280x720', 'yuyv422'],
      ['1280x720', 'bgr0'],
      ['1920x1080', 'nv12'],
      ['960x540', 'yuyv422'],
    ] as const) {
      const f = grab(size, format);
      const q = (fx: number, fy: number) =>
        at(f, Math.round(f.width * fx), Math.round(f.height * fy));
      console.log(
        `${size} ${format}: ${[q(0.25, 0.25), q(0.75, 0.25), q(0.25, 0.75), q(0.75, 0.75)]}`,
      );
      expect(near(q(0.25, 0.25), [255, 0, 0]), `${size} ${format} red`).toBe(true);
      expect(near(q(0.75, 0.25), [0, 255, 0]), `${size} ${format} green`).toBe(true);
      expect(near(q(0.25, 0.75), [0, 0, 255]), `${size} ${format} blue`).toBe(true);
      expect(near(q(0.75, 0.75), [255, 255, 255]), `${size} ${format} white`).toBe(true);
    }
  });
});

/**
 * One NV12 frame from Windows 11's camera, read by another process (as an app
 * does) while this one keeps sending; after `skip` frames.
 */
async function mfGrab(skip: number): Promise<{ width: number; height: number; nv12: Buffer }> {
  const out = join(mkdtempSync(join(tmpdir(), 'mochi-mf-')), 'frame.nv12');
  const script = [
    `const a = require(${JSON.stringify(modulePath)});`,
    `const r = a.mfGrab('Mochi Studio Camera', ${skip});`,
    `if (r.frame) require('fs').writeFileSync(${JSON.stringify(out)}, Buffer.from(r.frame));`,
    'delete r.frame;',
    'console.log(JSON.stringify(r));',
  ].join('\n');
  const stdout = await new Promise<string>((resolve, reject) =>
    execFile(process.execPath, ['-e', script], { timeout: 60_000 }, (e, so, se) =>
      e ? reject(new Error(`${e.message}\n${se}`)) : resolve(so),
    ),
  );
  const r = JSON.parse(stdout.trim().split('\n').pop()!) as {
    width?: number;
    height?: number;
    error?: string;
  };
  if (r.error) throw new Error(`Reading Windows 11's camera: ${r.error}`);
  return { width: r.width!, height: r.height!, nv12: readFileSync(out) };
}

/** Windows lists a virtual camera with " (Windows Virtual Camera)" after its name. */
const isOurs = (name: string) => /^Mochi Studio Camera( \(|$)/.test(name);

describe.skipIf(!run)('the Windows 11 camera (Media Foundation, on the runner)', () => {
  let timer: ReturnType<typeof setInterval> | undefined;
  let why = '';
  afterAll(() => {
    if (timer) clearInterval(timer);
    addon().close();
    addon().mfStop();
  }, 60_000);

  it('is registered where the Frame Server finds it, and made for this session', (ctx) => {
    const i = addon().installed();
    console.log('Installed:', JSON.stringify(i));
    expect(i.mf, 'the source is registered').toBe(true);
    expect(i.mfPath).toMatch(/ProgramData.*mochi_camera_mf\.dll$/i);
    const before = addon().mfState();
    console.log('Before:', JSON.stringify(before));
    if (!before.available) {
      why = before.problem ?? 'not available';
      console.log(`Skipped: ${why}`);
      return ctx.skip();
    }
    const st = addon().mfStart();
    console.log('Started:', JSON.stringify(st));
    if (st.error) {
      why = st.error;
      console.log(`Skipped: this system can't make the camera: ${why}`);
      return ctx.skip();
    }
    expect(st.running).toBe(true);
  }, 60_000);

  it('is listed by Media Foundation; DirectShow apps may list it too', async (ctx) => {
    if (why) return ctx.skip();
    let devices: string[] = [];
    for (let i = 0; i < 50 && !devices.some(isOurs); i++) {
      devices = addon().mfDevices();
      if (!devices.some(isOurs)) await new Promise((r) => setTimeout(r, 200));
      if (i % 10 === 0) console.log('Media Foundation lists (so far):', JSON.stringify(devices));
    }
    console.log('Media Foundation lists:', JSON.stringify(devices));
    expect(devices.some(isOurs), JSON.stringify(devices)).toBe(true);
    // The question docs/virtual-camera.md leaves open: does DirectShow list it as well?
    const r = spawnSync(
      'ffmpeg',
      ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'],
      { encoding: 'utf8', timeout: 60_000 },
    );
    const named = `${r.stdout}${r.stderr}`
      .split('\n')
      .filter((l) => l.includes('"Mochi Studio Camera'));
    console.log(
      `DirectShow lists "Mochi Studio Camera" ${named.length} time(s):\n${named.join('\n')}`,
    );
  }, 60_000);

  it('shows the still card while nothing is sent', async (ctx) => {
    if (why) return ctx.skip();
    const f = await mfGrab(3);
    console.log(
      `Card: ${f.width} x ${f.height}, corner ${nv12ToRgb(f.nv12, f.width, f.height, 4, 4)}`,
    );
    expect([f.width, f.height]).toEqual([1280, 720]);
    expect(f.nv12.length).toBe((1280 * 720 * 3) / 2);
    expect(near(nv12ToRgb(f.nv12, f.width, f.height, 4, 4), [0x22, 0x26, 0x33])).toBe(true);
  }, 60_000);

  it('gives the frames sent, read by another process', async (ctx) => {
    if (why) return ctx.skip();
    const w = 1280;
    const h = 720;
    const a = addon();
    a.open(w, h, 30);
    const nv12 = new Uint8Array((w * h * 3) / 2);
    a.convert(quadrants(w, h), w, h, 0, nv12);
    timer = setInterval(() => a.write(nv12), 33);
    // A second in: the module opens the source's ring once the source has made it.
    const f = await mfGrab(30);
    const q = (fx: number, fy: number) =>
      nv12ToRgb(f.nv12, f.width, f.height, Math.round(f.width * fx), Math.round(f.height * fy));
    console.log(`Frames: ${[q(0.25, 0.25), q(0.75, 0.25), q(0.25, 0.75), q(0.75, 0.75)]}`);
    expect(near(q(0.25, 0.25), [255, 0, 0]), 'red').toBe(true);
    expect(near(q(0.75, 0.25), [0, 255, 0]), 'green').toBe(true);
    expect(near(q(0.25, 0.75), [0, 0, 255]), 'blue').toBe(true);
    expect(near(q(0.75, 0.75), [255, 255, 255]), 'white').toBe(true);
    clearInterval(timer);
    timer = undefined;
  }, 60_000);

  it('is gone from the list once the app lets go of it', async (ctx) => {
    if (why) return ctx.skip();
    expect(addon().mfStop().running).toBe(false);
    let devices = addon().mfDevices();
    for (let i = 0; i < 50 && devices.some(isOurs); i++) {
      await new Promise((r) => setTimeout(r, 200));
      devices = addon().mfDevices();
    }
    expect(devices.some(isOurs), JSON.stringify(devices)).toBe(false);
  }, 60_000);
});
