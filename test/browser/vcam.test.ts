import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron, type ElectronApplication, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { yuyvToRgb } from '../../src/core/yuv';
import { syntheticModelZip } from './harness';

/**
 * The virtual camera on Linux, in the desktop app.
 *
 * - **With a fake device** (MOCHI_DESKTOP_TEST=1): the app writes each frame
 *   to a file instead of /dev/videoN (MOCHI_VCAM_FAKE_DEVICE), and the test
 *   reads it: the format, the size, the half-transparent body over the
 *   background, the stage's background, the mirror. Runs here, after
 *   `npm run desktop:build` (with `npm run build:v4l2` for the native
 *   conversion).
 * - **With the real device** (MOCHI_VCAM_TEST=1, for the Ubuntu runner): a
 *   v4l2loopback device labelled "Mochi Studio Camera" must exist (the
 *   workflow loads it); ffmpeg reads one frame from it as a camera app would.
 *   Skipped, saying why, when there is no such device.
 *
 * The model's body is tinted to half opacity: (240, 180, 150) at alpha 0.5
 * comes from the page as (120, 90, 75, 128), premultiplied, and over key
 * green (0, 177, 64) is (120, 178, 107).
 */
const W = 1280;
const H = 720;
const GREEN = [0x00, 0xb1, 0x40];
const BODY_OVER_GREEN = [120, 90 + 88, 75 + 32];
/** The body, right of the middle (the model is turned: ParamAngleX 30 slides it right). */
const BODY = { x: 0.38, y: 0.1 };
/** A model point to frame pixels: the fitted view, 95% of the shorter side, centred, y up. */
const at = (p: { x: number; y: number }, mirror = false) => {
  const k = 0.95 * Math.min(W, H);
  const x = Math.round(W / 2 + p.x * k);
  return { x: mirror ? W - 1 - x : x, y: Math.round(H / 2 - p.y * k) };
};
const near = (a: number[], b: number[], tol = 6) => a.every((v, i) => Math.abs(v - b[i]!) <= tol);

async function launch(env: Record<string, string>) {
  const home = mkdtempSync(join(tmpdir(), 'mochi-vcam-'));
  const electron = (await import('electron')).default as unknown as string;
  const app = await _electron.launch({
    executablePath: electron,
    // As desktop.test.ts: root in a container needs --no-sandbox, and a display without a GPU
    // software WebGL (SwiftShader); a normal desktop needs neither.
    args: [
      '--no-sandbox',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      'desktop/dist/app',
    ],
    env: {
      ...process.env,
      MOCHI_STUDIO_PORT: String(47_800 + Math.floor(Math.random() * 90)),
      MOCHI_STUDIO_BRIDGE_HOME: home,
      MOCHI_STUDIO_USER_DATA: join(home, 'app-data'),
      ...env,
    } as Record<string, string>,
  });
  const win = await app.firstWindow();
  win.on('pageerror', (e) => console.log('Page error:', e.message));
  await win.waitForFunction(() => (window as any).mochiAgentLink?.state === 'connected', null, {
    timeout: 60_000,
  });
  const zip = join(home, 'Test.zip');
  writeFileSync(zip, syntheticModelZip());
  await win.locator('#model-zip').setInputFiles(zip);
  await win.waitForFunction(() => (window as any).mochiStudio.settings !== undefined);
  await win.evaluate(() => {
    const s = (window as any).mochiStudio;
    s.runtime.setEffect?.('breath', false);
    s.setOverrides({ ParamAngleX: 30, ParamMouthOpenY: 0 });
    s.setModelTints([['ArtMeshBody', [1, 1, 1, 0.5]]]);
  });
  return { app, win, home };
}

const setCamera = (win: Page, args: Record<string, unknown>) =>
  win.evaluate((a) => (window as any).mochiStudio.run('set_virtual_camera', a), args);
const cameraState = (win: Page) =>
  win.evaluate(async () => {
    const s = (window as any).mochiStudio;
    await s.refreshVirtualCamera();
    return s.virtualCameraStatus();
  });

/** The RGB at a pixel of a YUYV frame. */
const rgb = (f: Uint8Array, p: { x: number; y: number }) => yuyvToRgb(f, W, p.x, p.y);

const fake = !!process.env.MOCHI_DESKTOP_TEST && process.platform === 'linux';
describe.skipIf(!fake)('the virtual camera, with a fake device (Linux)', () => {
  let app: ElectronApplication;
  let win: Page;
  let device: string;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mochi-vcam-dev-'));
    device = join(dir, 'video');
    ({ app, win } = await launch({ MOCHI_VCAM_FAKE_DEVICE: device }));
  }, 120_000);
  afterAll(async () => {
    await app?.close();
  });

  /** The device's next frame of content (a write after `since`). */
  async function frame(since = 0, check?: (f: Uint8Array) => boolean): Promise<Uint8Array> {
    const deadline = Date.now() + 20_000;
    for (;;) {
      if (existsSync(device) && statSync(device).mtimeMs > since) {
        const f = new Uint8Array(readFileSync(device));
        if (f.length === W * H * 2 && (!check || check(f))) return f;
      }
      if (Date.now() > deadline)
        throw new Error(`no frame (state: ${JSON.stringify(await cameraState(win))})`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  it('sends YUYV 1280 × 720, the half-transparent body over the key color', async () => {
    await setCamera(win, { enabled: true, background: '#00B140' });
    const f = await frame(
      0,
      (f) => near(rgb(f, { x: 2, y: 2 }), GREEN) && near(rgb(f, at(BODY)), BODY_OVER_GREEN),
    );
    expect(JSON.parse(readFileSync(`${device}.json`, 'utf8'))).toEqual({
      width: W,
      height: H,
      fps: 30,
      format: 'YUYV',
    });
    expect(rgb(f, { x: 2, y: 2 }), 'background').toSatisfy((c: number[]) => near(c, GREEN));
    expect(rgb(f, at(BODY)), 'the body over green').toSatisfy((c: number[]) =>
      near(c, BODY_OVER_GREEN),
    );
    const st = await cameraState(win);
    expect(st).toMatchObject({
      available: true,
      active: true,
      device,
      width: W,
      height: H,
      fps: 30,
      settings: { enabled: true, background: { kind: 'color', color: '#00B140' } },
    });
    expect(st.frames).toBeGreaterThan(0);
  });

  it('keeps writing while the avatar is still, at about the camera’s rate', async () => {
    const a = (await cameraState(win)).frames;
    await new Promise((r) => setTimeout(r, 2000));
    const b = (await cameraState(win)).frames;
    // 30 a second: new frames and repeats of the last one.
    expect(b - a).toBeGreaterThan(30);
  });

  it('mirrors, and shows the stage’s own background', async () => {
    await setCamera(win, { mirror: true });
    const m = await frame(0, (f) => near(rgb(f, at(BODY, true)), BODY_OVER_GREEN));
    expect(rgb(m, at(BODY)), 'nothing where the body was').toSatisfy((c: number[]) =>
      near(c, GREEN),
    );
    // The stage's background: a color here, so the page draws it.
    await win.evaluate(() =>
      (window as any).mochiStudio.setStage({ background: { kind: 'color', color: '#3366cc' } }),
    );
    await setCamera(win, { mirror: false, background: 'stage' });
    // The half-transparent body over that blue: 120 + 51/2, 90 + 102/2, 75 + 204/2.
    const s = await frame(
      0,
      (f) =>
        near(rgb(f, { x: 2, y: 2 }), [0x33, 0x66, 0xcc]) &&
        near(rgb(f, at(BODY)), [146, 141, 177], 8),
    );
    expect(rgb(s, { x: 2, y: 2 })).toSatisfy((c: number[]) => near(c, [0x33, 0x66, 0xcc]));
  });

  it('stops when switched off, and refuses sizes it does not offer', async () => {
    await expect(setCamera(win, { width: 1600, height: 900 })).rejects.toThrow(/offers 1280×720/);
    await setCamera(win, { enabled: false });
    await expect.poll(async () => (await cameraState(win)).active).toBe(false);
    const t = statSync(device).mtimeMs;
    await new Promise((r) => setTimeout(r, 500));
    expect(statSync(device).mtimeMs).toBe(t);
  });
});

/** The v4l2loopback device labelled "Mochi Studio Camera", if one exists. */
function realDevice(): string | undefined {
  try {
    for (const n of readdirSync('/sys/class/video4linux'))
      if (readFileSync(`/sys/class/video4linux/${n}/name`, 'utf8').trim() === 'Mochi Studio Camera')
        return `/dev/${n}`;
  } catch {
    // No video devices at all.
  }
  return undefined;
}

const real = !!process.env.MOCHI_VCAM_TEST && process.platform === 'linux';
const dev = real ? realDevice() : undefined;
if (real && !dev)
  console.log(
    'The real-device test is skipped: no v4l2loopback device named “Mochi Studio Camera” (the module did not load on this kernel, or was loaded without the label).',
  );
describe.skipIf(!real || !dev)('the virtual camera, with a v4l2loopback device (Linux)', () => {
  let app: ElectronApplication;
  let win: Page;

  beforeAll(async () => {
    ({ app, win } = await launch({}));
  }, 120_000);
  afterAll(async () => {
    await app?.close();
  });

  /**
   * One frame as a camera app reads it (ffmpeg, V4L2 capture, YUYV).
   * Asynchronous: Playwright, attached to every page of the app (the camera's
   * hidden page too), must go on answering while ffmpeg runs.
   */
  const capture = (): Promise<Uint8Array> =>
    new Promise((resolve, reject) =>
      execFile(
        'ffmpeg',
        [
          '-loglevel',
          'error',
          '-f',
          'v4l2',
          '-input_format',
          'yuyv422',
          '-video_size',
          `${W}x${H}`,
          '-i',
          dev!,
          '-frames:v',
          '5',
          '-update',
          '1',
          '-f',
          'rawvideo',
          '-pix_fmt',
          'yuyv422',
          '-',
        ],
        { maxBuffer: 64 << 20, timeout: 30_000, encoding: 'buffer' },
        (e, out) => (e ? reject(e) : resolve(new Uint8Array(out).slice(-W * H * 2))),
      ),
    );

  it('is listed and read by a camera app: size, colors, background and mirror', async () => {
    await setCamera(win, { enabled: true, background: '#00B140' });
    await expect.poll(async () => (await cameraState(win)).active, { timeout: 20_000 }).toBe(true);
    expect((await cameraState(win)).device).toBe(dev);
    const f = await capture();
    expect(f.length).toBe(W * H * 2);
    expect(rgb(f, { x: 2, y: 2 })).toSatisfy((c: number[]) => near(c, GREEN));
    expect(rgb(f, at(BODY))).toSatisfy((c: number[]) => near(c, BODY_OVER_GREEN));
    await setCamera(win, { mirror: true });
    await expect
      .poll(async () => near(rgb(await capture(), at(BODY, true)), BODY_OVER_GREEN), {
        timeout: 20_000,
      })
      .toBe(true);
  });

  it('releases the device when switched off', async () => {
    await setCamera(win, { enabled: false });
    await expect.poll(async () => (await cameraState(win)).device).toBeUndefined();
  });
});
