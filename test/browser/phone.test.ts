import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { BridgeServer } from '../../bridge/src/server.ts';
import { BridgeStore } from '../../bridge/src/store.ts';
import { openSection, startHarness, syntheticModelZip, type Harness } from './harness';

/**
 * A phone as a face tracker, end to end: the bridge's phone
 * tracker on 127.0.0.1 serving the built phone page (dist/), Mochi Studio's
 * Camera tab, a scripted phone sending face values, the webcam taking over
 * when the phone loses the face, revoking, and the real phone page with
 * MediaPipe on the fake camera.
 */
let H: Harness;
let bridge: BridgeServer;
let page: Page;
let storeDir: string;
const errors: string[] = [];
const FACE_MODEL = existsSync('dist/mediapipe/face_landmarker.task');

/** A head pose as MediaPipe's facial transformation matrix (column-major): a turn about y. */
function yawMatrix(deg: number): number[] {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, -40, 1];
}

async function scriptedPhone(port: number) {
  const ca = (
    JSON.parse(readFileSync(join(storeDir, 'phone-tls.json'), 'utf8')) as { cert: string }
  ).cert;
  const ws = new WebSocket(`wss://127.0.0.1:${port}/track`, {
    ca,
    origin: `https://127.0.0.1:${port}`,
  });
  const inbox: Array<Record<string, unknown>> = [];
  ws.on('message', (d) => inbox.push(JSON.parse(String(d))));
  const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  const next = async (): Promise<Record<string, unknown>> => {
    await expect.poll(() => inbox.length, { timeout: 5000 }).toBeGreaterThan(0);
    return inbox.shift()!;
  };
  let timer: ReturnType<typeof setInterval> | undefined;
  return {
    ws,
    next,
    closed,
    send: (m: unknown) => ws.send(JSON.stringify(m)),
    /** Sends this face 30 times a second until changed. */
    hold(face: boolean, yaw: number) {
      clearInterval(timer);
      timer = setInterval(
        () =>
          ws.readyState === WebSocket.OPEN &&
          ws.send(
            JSON.stringify({
              type: 'frame',
              face,
              blendshapes: { jawOpen: 0.1 },
              ...(face ? { matrix: yawMatrix(yaw) } : {}),
            }),
          ),
        33,
      );
    },
    stop: () => clearInterval(timer),
  };
}

beforeAll(async () => {
  H = await startHarness();
  storeDir = mkdtempSync(join(tmpdir(), 'mochi-phone-'));
  const store = new BridgeStore(storeDir);
  bridge = new BridgeServer({
    port: 0,
    store,
    log: () => undefined,
    plugins: { port: 25_400 + Math.floor(Math.random() * 500), broadcastPort: 9 },
    phone: {
      port: 26_000 + Math.floor(Math.random() * 1000),
      host: '127.0.0.1',
      addresses: () => ['127.0.0.1'],
      staticDir: join(process.cwd(), 'dist'),
    },
  });
  const port = await bridge.listen();
  page = await H.context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(H.url);
  await page.waitForFunction(() => 'mochiStudio' in window);
  await page.locator('#model-zip').setInputFiles({
    name: 'Test.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(syntheticModelZip()),
  });
  await page.waitForFunction(() => (window as any).mochiStudio.settings !== undefined);
  await openSection(page, 'Agents');
  await page.locator('#bridge-url').fill(`ws://127.0.0.1:${port}`);
  await page.keyboard.press('Escape');
  // Off by default: nothing listens.
  expect(bridge.phone.enabled).toBe(false);
  await openSection(page, 'Tracking');
  expect(await page.locator('#phone-toggle').isChecked()).toBe(false);
  await page.locator('#phone-toggle').check();
  // A browser pairs with the bridge first (the desktop app does that by itself).
  await page.locator('#phone-bridge-code').waitFor({ state: 'visible' });
  await page.locator('#phone-bridge-code').fill(store.pairingCode());
  await page.locator('#phone-bridge-code ~ button').click();
  await page.locator('#phone-code').waitFor({ state: 'visible', timeout: 15_000 });
}, 60_000);
afterAll(async () => {
  await bridge?.close();
  await H?.close();
});

describe('a phone as the face tracker', () => {
  it('shows the address, a QR code and the pairing code, and pairs a phone with it', async () => {
    const port = bridge.phone.port!;
    expect(bridge.phone.enabled).toBe(true);
    expect(await page.locator('#phone-url').textContent()).toBe(`https://127.0.0.1:${port}/`);
    expect(await page.locator('#phone-qr svg').getAttribute('aria-label')).toBe(
      `QR code of https://127.0.0.1:${port}/`,
    );
    const code = (await page.locator('#phone-code').textContent())!;
    expect(code).toBe(bridge.phone.pairingCode);
    expect(await page.locator('#phone-status').textContent()).toContain('No phone connected');

    const phone = await scriptedPhone(port);
    phone.send({ type: 'hello', name: 'iPhone' });
    expect(await phone.next()).toEqual({ type: 'pair_needed' });
    phone.send({ type: 'pair', code, name: 'iPhone' });
    expect(await phone.next()).toMatchObject({ type: 'paired', name: 'iPhone' });
    await expect
      .poll(() => page.locator('#phone-list .phone').textContent())
      .toContain('connected');
    // A new code for the next phone.
    await expect.poll(() => page.locator('#phone-code').textContent()).not.toBe(code);

    // The phone's face drives the model: a 20° turn (mirrored, as the webcam's would be).
    phone.hold(true, 20);
    const yaw = () => page.evaluate(() => (window as any).mochiStudio.lastInputs.HeadYaw ?? 0);
    const source = () => page.evaluate(() => (window as any).mochiStudio.faceSource);
    await expect.poll(async () => Math.abs(Math.abs(await yaw()) - 20) < 3).toBe(true);
    const sign = Math.sign(await yaw());
    expect(await source()).toBe('phone');
    await expect
      .poll(() => page.locator('#phone-status').textContent())
      .toMatch(/iPhone connected · face found · \d+ frames a second/);
    // Calibrating needs only the phone: this computer's camera is off.
    expect(await page.evaluate(() => (window as any).mochiStudio.cameraOn)).toBe(false);
    expect(
      await page.evaluate(() => (window as any).mochiStudio.commands.dispatch('calibrate', {})),
    ).toEqual({ calibrated: true });
    // The turn is the neutral pose now; the calibration goes again for the checks below.
    await page.evaluate(() => (window as any).mochiStudio.clearCalibration());

    // This computer's camera turned the other way, 30 times a second.
    await page.evaluate((m) => {
      const w = window as any;
      w.webcamFace = true;
      w.webcamFeed = setInterval(
        () =>
          w.mochiStudio.feedFrame(
            w.webcamFace
              ? { t: performance.now(), face: true, blendshapes: {}, matrix: m }
              : { t: performance.now(), face: false, blendshapes: {} },
            'webcam',
          ),
        33,
      );
    }, yawMatrix(-15));
    // Both see the face: the webcam's wins (the default), the other way round.
    await expect.poll(source).toBe('webcam');
    await expect.poll(async () => Math.abs((await yaw()) + sign * 15) < 3).toBe(true);
    // The webcam loses the face: the phone takes over, and gives it back.
    await page.evaluate(() => ((window as any).webcamFace = false));
    await expect.poll(source).toBe('phone');
    await expect.poll(async () => Math.abs((await yaw()) - sign * 20) < 3).toBe(true);
    await page.evaluate(() => ((window as any).webcamFace = true));
    await expect.poll(source).toBe('webcam');
    // The person prefers the phone: it wins while it sees the face.
    expect(await page.locator('#face-priority').inputValue()).toBe('webcam');
    await page.locator('#face-priority').selectOption('phone');
    await expect.poll(source).toBe('phone');
    await expect
      .poll(() =>
        page.evaluate(async () => (await (window as any).mochiStudio.store.getApp()).facePriority),
      )
      .toBe('phone');
    // The phone loses the face: the webcam takes over.
    phone.hold(false, 0);
    await expect.poll(source).toBe('webcam');
    phone.hold(true, 20);
    await expect.poll(source).toBe('phone');
    await page.locator('#face-priority').selectOption('webcam');
    await page.evaluate(() => clearInterval((window as any).webcamFeed));

    // Revoked in the Camera tab: the phone is disconnected and must pair again.
    await page.locator('#phone-list .phone-revoke').click();
    expect(await phone.closed).toBe(4401);
    await expect.poll(() => page.locator('#phone-list .phone').count()).toBe(0);
    phone.stop();
  });

  it.skipIf(!FACE_MODEL)(
    'runs the real phone page: Connect to PC with the code, then MediaPipe on the phone’s camera',
    async () => {
      const port = bridge.phone.port!;
      const code = (await page.locator('#phone-code').textContent())!;
      const ctx = await H.browser.newContext({
        ignoreHTTPSErrors: true,
        permissions: ['camera'],
        viewport: { width: 390, height: 844 },
      });
      const phonePage = await ctx.newPage();
      const phoneErrors: string[] = [];
      phonePage.on('pageerror', (e) => phoneErrors.push(e.message));
      await phonePage.goto(`https://127.0.0.1:${port}/`);
      expect(await phonePage.locator('#connect').textContent()).toBe('Connect to PC');
      await phonePage.locator('#connect').click();
      await phonePage.locator('#code').waitFor({ state: 'visible' });
      await phonePage.locator('#code').fill(code);
      await phonePage.locator('#connect').click();
      await phonePage.waitForFunction(() => (window as any).mochiPhone.linked === true);
      // The fake camera shows no face; the tracker runs, and its frames arrive.
      await phonePage.waitForFunction(() => (window as any).mochiPhone.tracking === true, null, {
        timeout: 30_000,
      });
      await expect
        .poll(() => page.locator('#phone-status').textContent(), { timeout: 30_000 })
        .toMatch(/connected · no face · [1-9]\d* frames a second/);
      expect(await phonePage.locator('#status').textContent()).toContain(
        'Connected to Mochi Studio',
      );
      // No camera picture on the phone page, and none sent.
      expect(await phonePage.locator('video').count()).toBe(0);
      // Reloaded, the approved phone connects at once with its token.
      await phonePage.reload();
      await phonePage.waitForFunction(() => (window as any).mochiPhone.linked === true);
      expect(phoneErrors).toEqual([]);
      await ctx.close();
    },
    90_000,
  );

  it('turns off, closing the port', async () => {
    const port = bridge.phone.port!;
    await page.locator('#phone-toggle').uncheck();
    await expect.poll(() => bridge.phone.enabled).toBe(false);
    expect(await page.locator('#phone-status').textContent()).toContain('Nothing listens');
    await expect(
      fetch(`https://127.0.0.1:${port}/`).catch((e: Error) => {
        throw e;
      }),
    ).rejects.toThrow();
    expect(errors).toEqual([]);
  });
});
