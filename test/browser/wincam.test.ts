import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron, type ElectronApplication, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nv12ToRgb } from '../../src/core/yuv';
import { syntheticModelZip } from './harness';

/**
 * The virtual camera on Windows, in the desktop app, on GitHub's Windows
 * runner (virtual-camera.yml, after `npm run build:wincam` and
 * `npm run desktop:build`):
 *
 * - Uninstall and Install from the Camera tab (regsvr32 through one elevated
 *   command; the runner's user is an administrator);
 * - the camera on, with a key-green background: ffmpeg's DirectShow input
 *   reads it as an app does, and the test checks the size, the background,
 *   the half-transparent body over it, the stage's own background and the
 *   mirror, as the Linux test does.
 *
 * MOCHI_WINCAM_APP_TEST=1 turns it on.
 */
const run = process.platform === 'win32' && !!process.env.MOCHI_WINCAM_APP_TEST;
const W = 1280;
const H = 720;
const GREEN = [0x00, 0xb1, 0x40];
// (240, 180, 150) at alpha 0.5 over key green.
const BODY_OVER_GREEN = [120, 90 + 88, 75 + 32];
const BODY = { x: 0.38, y: 0.1 };
const at = (p: { x: number; y: number }, mirror = false) => {
  const k = 0.95 * Math.min(W, H);
  const x = Math.round(W / 2 + p.x * k);
  return { x: mirror ? W - 1 - x : x, y: Math.round(H / 2 - p.y * k) };
};
const near = (a: number[], b: number[], tol = 8) => a.every((v, i) => Math.abs(v - b[i]!) <= tol);

/**
 * One frame as an app reads the camera (ffmpeg, DirectShow, NV12), as RGB rows.
 * Asynchronous: Playwright, attached to every page of the app (the camera's
 * hidden page too), must go on answering while ffmpeg runs, or that page's
 * loading stalls.
 */
function grab(): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    execFile(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'dshow',
        '-video_size',
        `${W}x${H}`,
        '-pixel_format',
        'nv12',
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
        '-',
      ],
      { maxBuffer: 64 << 20, timeout: 60_000, encoding: 'buffer' },
      (e, out) => (e ? reject(e) : resolve(out)),
    ),
  );
}
/** Grabs until the frame passes the check (the camera's page reloads after a change), for up to 30 s. */
async function grabUntil(check: (f: Buffer) => boolean): Promise<Buffer> {
  const deadline = Date.now() + 30_000;
  let f = await grab();
  while (!check(f) && Date.now() < deadline) f = await grab();
  if (!check(f)) {
    console.log(`The last frame, coarsely:\n${sketch(f)}`);
    // The frame ring itself, as the app wrote it: is the page's picture there?
    const ring = (
      createRequire(import.meta.url)(
        join(process.cwd(), 'native/wincam/build/Release/mochi_wincam.node'),
      ) as {
        peek(): { sequence?: number; width?: number; height?: number; frame?: Uint8Array };
      }
    ).peek();
    if (ring.frame)
      console.log(
        `The ring: frame ${ring.sequence}, ${ring.width} x ${ring.height}, corner ${nv12ToRgb(ring.frame, W, H, 2, 2)}, body ${nv12ToRgb(ring.frame, W, H, at(BODY).x, at(BODY).y)}, mirrored body ${nv12ToRgb(ring.frame, W, H, at(BODY, true).x, at(BODY, true).y)}`,
      );
    else console.log('The ring:', JSON.stringify(ring));
  }
  return f;
}
/** A 64 × 18 map of a frame: . key green, b the body over green, W white, # dark, o other. */
function sketch(f: Buffer): string {
  const rows: string[] = [];
  for (let gy = 0; gy < 18; gy++) {
    let row = '';
    for (let gx = 0; gx < 64; gx++) {
      const c = rgb(f, {
        x: Math.floor(((gx + 0.5) * W) / 64),
        y: Math.floor(((gy + 0.5) * H) / 18),
      });
      row += near(c, GREEN, 16)
        ? '.'
        : near(c, BODY_OVER_GREEN, 16)
          ? 'b'
          : c.every((v) => v > 230)
            ? 'W'
            : c.every((v) => v < 60)
              ? '#'
              : 'o';
    }
    rows.push(row);
  }
  return rows.join('\n');
}
const rgb = (f: Buffer, p: { x: number; y: number }) => {
  const i = (p.y * W + p.x) * 3;
  return [f[i]!, f[i + 1]!, f[i + 2]!];
};

describe.skipIf(!run)('the virtual camera on Windows, in the desktop app', () => {
  let app: ElectronApplication;
  let win: Page;

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), 'mochi-wincam-'));
    const electron = (await import('electron')).default as unknown as string;
    app = await _electron.launch({
      executablePath: electron,
      args: ['desktop/dist/app'],
      env: {
        ...process.env,
        MOCHI_STUDIO_PORT: String(47_800 + Math.floor(Math.random() * 90)),
        MOCHI_STUDIO_BRIDGE_HOME: home,
        MOCHI_STUDIO_USER_DATA: join(home, 'app-data'),
      } as Record<string, string>,
    });
    // The main process's log, for a failure on the runner.
    app.process().stdout?.on('data', (d: Buffer) => console.log('[main]', d.toString().trim()));
    app.process().stderr?.on('data', (d: Buffer) => console.log('[main]', d.toString().trim()));
    win = await app.firstWindow();
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
  }, 120_000);
  afterAll(async () => {
    await app?.close();
  });

  const state = () =>
    win.evaluate(async () => {
      const s = (window as any).mochiStudio;
      await s.refreshVirtualCamera();
      return s.virtualCameraStatus();
    });
  const openCameraTab = async () => {
    if (!(await win.locator('#vcam').isVisible())) {
      if (!(await win.locator('#main-menu').isVisible())) await win.locator('#menu-button').click();
      await win.locator('#menu-settings').click();
      await win.getByRole('tab', { name: 'Camera', exact: true }).click();
    }
  };

  it('uninstalls and installs from the Camera tab', async () => {
    await win.evaluate(() => (window as any).mochiStudio.refreshVirtualCamera());
    await openCameraTab();
    await expect.poll(async () => (await state()).install).toBeDefined();
    if ((await state()).install.installed) {
      await win.locator('#vcam-uninstall-button').click();
      await expect
        .poll(async () => (await state()).install, { timeout: 60_000 })
        .toMatchObject({ installed: false });
    }
    // Uninstall is done once the row says so (the device goes a moment before).
    await expect
      .poll(() => win.locator('#vcam-installed').textContent(), { timeout: 60_000 })
      .toBe('Not installed');
    await win.locator('#vcam-install-button').click();
    await expect
      .poll(() => win.locator('#vcam-installed').textContent(), { timeout: 60_000 })
      .toBe('Installed');
    const st = await state();
    console.log('After Install:', JSON.stringify(st.install));
    expect(st.install.error).toBeUndefined();
    expect(st.install.detail).toMatch(/every app/);
  });

  it('is read by a DirectShow app: size, the key color, and the half-transparent body over it', async () => {
    await win.evaluate(() =>
      (window as any).mochiStudio.run('set_virtual_camera', {
        enabled: true,
        background: '#00B140',
      }),
    );
    // On a timeout, the state says why (a problem, an error, no frames).
    let last: unknown;
    await expect
      .poll(
        async () => {
          last = await state();
          return (last as { active: boolean }).active;
        },
        { timeout: 30_000 },
      )
      .toBe(true)
      .catch((e: Error) => {
        console.log('The camera never became active:', JSON.stringify(last));
        throw e;
      });
    expect(await state()).toMatchObject({ device: 'Mochi Studio Camera', width: W, height: H });
    console.log('Camera state:', JSON.stringify(await state()));
    let f = await grabUntil((f) => near(rgb(f, at(BODY)), BODY_OVER_GREEN));
    console.log('Camera state after the reads:', JSON.stringify(await state()));
    expect(f.length).toBe(W * H * 3);
    console.log('Corner', rgb(f, { x: 2, y: 2 }), 'body', rgb(f, at(BODY)));
    expect(rgb(f, { x: 2, y: 2 }), 'background').toSatisfy((c: number[]) => near(c, GREEN));
    expect(rgb(f, at(BODY)), 'the body over green').toSatisfy((c: number[]) =>
      near(c, BODY_OVER_GREEN),
    );
  });

  it('mirrors, and shows the stage’s own background', async () => {
    await win.evaluate(() =>
      (window as any).mochiStudio.run('set_virtual_camera', { mirror: true }),
    );
    let f = await grabUntil((f) => near(rgb(f, at(BODY, true)), BODY_OVER_GREEN));
    expect(rgb(f, at(BODY, true)), 'the body, mirrored').toSatisfy((c: number[]) =>
      near(c, BODY_OVER_GREEN),
    );
    await win.evaluate(() =>
      (window as any).mochiStudio.setStage({ background: { kind: 'color', color: '#3366cc' } }),
    );
    await win.evaluate(() =>
      (window as any).mochiStudio.run('set_virtual_camera', { mirror: false, background: 'stage' }),
    );
    f = await grabUntil((f) => near(rgb(f, { x: 2, y: 2 }), [0x33, 0x66, 0xcc]));
    expect(rgb(f, { x: 2, y: 2 })).toSatisfy((c: number[]) => near(c, [0x33, 0x66, 0xcc]));
  });

  it('shows the still card once switched off, and uninstalls', async () => {
    await win.evaluate(() =>
      (window as any).mochiStudio.run('set_virtual_camera', { enabled: false }),
    );
    await expect.poll(async () => (await state()).active).toBe(false);
    // The card's dark background (#222633), a moment after the last frame went stale.
    await new Promise((r) => setTimeout(r, 2500));
    const f = await grab();
    expect(rgb(f, { x: 2, y: 2 })).toSatisfy((c: number[]) => near(c, [0x22, 0x26, 0x33], 12));
    await win.locator('#vcam-uninstall-button').click();
    await expect
      .poll(() => win.locator('#vcam-installed').textContent(), { timeout: 60_000 })
      .toBe('Not installed');
    expect((await state()).install).toMatchObject({ installed: false });
  });
});
