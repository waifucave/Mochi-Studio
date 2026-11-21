import { execFile, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron, type ElectronApplication, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nv12ToRgb } from '../../src/core/yuv';
import { syntheticModelZip } from './harness';

/**
 * The Windows 11 camera in the desktop app, on GitHub's Windows runner
 * (virtual-camera.yml, after the native tests):
 *
 * - Install with the default choice: the Media Foundation camera alone (the
 *   second, DirectShow camera is for older apps, on request);
 * - the camera on, with a key-green background: another process reads it
 *   through Media Foundation, as the Camera app or a browser does, and the
 *   test checks the size, the background and the half-transparent body;
 * - what DirectShow apps list meanwhile;
 * - Uninstall.
 *
 * MOCHI_WINCAM11_APP_TEST=1 turns it on.
 */
const run = process.platform === 'win32' && !!process.env.MOCHI_WINCAM11_APP_TEST;
const modulePath = join(process.cwd(), 'native/wincam/build/Release/mochi_wincam.node');
const W = 1280;
const H = 720;
const GREEN = [0x00, 0xb1, 0x40];
// (240, 180, 150) at alpha 0.5 over key green.
const BODY_OVER_GREEN = [120, 90 + 88, 75 + 32];
const BODY = { x: 0.38, y: 0.1 };
const at = (p: { x: number; y: number }) => {
  const k = 0.95 * Math.min(W, H);
  return { x: Math.round(W / 2 + p.x * k), y: Math.round(H / 2 - p.y * k) };
};
const near = (a: number[], b: number[], tol = 10) => a.every((v, i) => Math.abs(v - b[i]!) <= tol);

/** One NV12 frame, read through Media Foundation by another process. */
async function mfGrab(skip: number): Promise<{ width: number; height: number; nv12: Buffer }> {
  const out = join(mkdtempSync(join(tmpdir(), 'mochi-mf-app-')), 'frame.nv12');
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

describe.skipIf(!run)('the Windows 11 camera, in the desktop app', () => {
  let app: ElectronApplication;
  let win: Page;

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), 'mochi-wincam11-'));
    const electron = (await import('electron')).default as unknown as string;
    app = await _electron.launch({
      executablePath: electron,
      args: ['desktop/dist/app'],
      env: {
        ...process.env,
        MOCHI_STUDIO_PORT: String(47_900 + Math.floor(Math.random() * 90)),
        MOCHI_STUDIO_BRIDGE_HOME: home,
        MOCHI_STUDIO_USER_DATA: join(home, 'app-data'),
      } as Record<string, string>,
    });
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

  it('installs the Windows 11 camera alone by default', async () => {
    if (!(await win.locator('#main-menu').isVisible())) await win.locator('#menu-button').click();
    await win.locator('#menu-settings').click();
    await win.getByRole('tab', { name: 'Camera', exact: true }).click();
    await expect.poll(async () => (await state()).install).toBeDefined();
    expect(await win.locator('#vcam-older-apps').count()).toBe(1);
    // Unticked: the second camera only on request.
    if (await win.locator('#vcam-older-apps').isChecked())
      await win.locator('#vcam-older-apps').uncheck();
    await win.locator('#vcam-install-button').click();
    await expect
      .poll(() => win.locator('#vcam-installed').textContent(), { timeout: 60_000 })
      .toBe('Installed');
    const st = await state();
    console.log('After Install:', JSON.stringify(st.install));
    expect(st.install).toMatchObject({ installed: true, olderApps: false });
    expect(st.install.error).toBeUndefined();
  }, 90_000);

  it('is read through Media Foundation: size, the key color, and the half-transparent body', async () => {
    await win.evaluate(() =>
      (window as any).mochiStudio.run('set_virtual_camera', {
        enabled: true,
        background: '#00B140',
      }),
    );
    await expect.poll(async () => (await state()).active, { timeout: 30_000 }).toBe(true);
    const deadline = Date.now() + 40_000;
    let f = await mfGrab(10);
    const body = () => nv12ToRgb(f.nv12, f.width, f.height, at(BODY).x, at(BODY).y);
    while (!near(body(), BODY_OVER_GREEN) && Date.now() < deadline) f = await mfGrab(10);
    console.log(
      `Through Media Foundation: ${f.width} x ${f.height}, corner ${nv12ToRgb(f.nv12, f.width, f.height, 2, 2)}, body ${body()}`,
    );
    expect([f.width, f.height]).toEqual([W, H]);
    expect(nv12ToRgb(f.nv12, f.width, f.height, 2, 2), 'background').toSatisfy((c: number[]) =>
      near(c, GREEN),
    );
    expect(body(), 'the body over green').toSatisfy((c: number[]) => near(c, BODY_OVER_GREEN));
  }, 120_000);

  it('is listed by DirectShow apps once, by its Windows 11 name', () => {
    const r = spawnSync(
      'ffmpeg',
      ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'],
      { encoding: 'utf8', timeout: 60_000 },
    );
    const named = `${r.stdout}${r.stderr}`
      .split('\n')
      .filter((l) => l.includes('"Mochi Studio Camera'));
    console.log(`DirectShow lists:\n${named.join('\n')}`);
    expect(named).toHaveLength(1);
    expect(named[0]).toContain('"Mochi Studio Camera (Windows Virtual Camera)"');
  });

  it('uninstalls', async () => {
    await win.evaluate(() =>
      (window as any).mochiStudio.run('set_virtual_camera', { enabled: false }),
    );
    await win.locator('#vcam-uninstall-button').click();
    await expect
      .poll(() => win.locator('#vcam-installed').textContent(), { timeout: 60_000 })
      .toBe('Not installed');
  }, 90_000);
});
