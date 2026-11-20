import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { PhoneServer } from '../../bridge/src/phone.ts';
import type { BridgeToHostPhone } from '../../src/core/phoneProtocol.ts';

/**
 * The phone tracker's server, on 127.0.0.1 with its own
 * certificate (trusted here as the phone's browser would be told to), and a
 * made-up build: the phone page, its scripts and MediaPipe's files.
 */
function fakeBuild(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mochi-phone-build-'));
  mkdirSync(join(dir, 'assets'));
  mkdirSync(join(dir, 'mediapipe', 'wasm'), { recursive: true });
  writeFileSync(join(dir, 'phone.html'), '<!doctype html><title>phone</title>');
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>the app</title>');
  for (const f of ['phone-1.js', 'shared-2.js', 'vision-3.js', 'main-4.js'])
    writeFileSync(join(dir, 'assets', f), `// ${f}`);
  writeFileSync(join(dir, 'mediapipe', 'face_landmarker.task'), 'face model');
  writeFileSync(join(dir, 'mediapipe', 'hand_landmarker.task'), 'hand model');
  writeFileSync(join(dir, 'mediapipe', 'wasm', 'vision_wasm_internal.wasm'), 'wasm');
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      'phone.html': { file: 'assets/phone-1.js', imports: ['_shared-2.js'] },
      '_shared-2.js': { file: 'assets/shared-2.js', dynamicImports: ['vision'] },
      vision: { file: 'assets/vision-3.js' },
      'index.html': { file: 'assets/main-4.js', imports: ['_shared-2.js'] },
    }),
  );
  return dir;
}

let server: PhoneServer | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
});

async function start(): Promise<{
  s: PhoneServer;
  port: number;
  ca: string;
  states: Extract<BridgeToHostPhone, { type: 'phone_state' }>[];
  frames: Extract<BridgeToHostPhone, { type: 'phone_frame' }>[];
}> {
  const dir = mkdtempSync(join(tmpdir(), 'mochi-phone-store-'));
  const states: Extract<BridgeToHostPhone, { type: 'phone_state' }>[] = [];
  const frames: Extract<BridgeToHostPhone, { type: 'phone_frame' }>[] = [];
  server = new PhoneServer({
    dir,
    staticDir: fakeBuild(),
    port: 0,
    host: '127.0.0.1',
    addresses: () => ['127.0.0.1'],
    log: () => undefined,
    toHost: (m) => {
      if (m.type === 'phone_state') states.push(m);
      else frames.push(m);
      return true;
    },
  });
  expect(server.enabled).toBe(false);
  await server.setEnabled(true);
  const ca = (JSON.parse(readFileSync(join(dir, 'phone-tls.json'), 'utf8')) as { cert: string })
    .cert;
  return { s: server, port: server.port!, ca, states, frames };
}

function get(
  port: number,
  ca: string,
  path: string,
  o: { method?: string; host?: string } = {},
): Promise<{ status: number; type?: string; csp?: string; body: string }> {
  return new Promise((resolve, reject) => {
    const r = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: o.method ?? 'GET',
        ca,
        headers: { host: o.host ?? `127.0.0.1:${port}` },
        // Another Host header (the rebinding check): the client checks the certificate for the
        // address it dials, not for that header, so the server is the one that answers.
        ...(o.host ? { checkServerIdentity: () => undefined } : {}),
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            type: res.headers['content-type'],
            csp: res.headers['content-security-policy'] as string | undefined,
            body,
          }),
        );
      },
    );
    r.on('error', reject);
    r.end();
  });
}

/** A phone: a WebSocket from the page's own origin, with its messages queued. */
async function phone(port: number, ca: string, origin = `https://127.0.0.1:${port}`) {
  const ws = new WebSocket(`wss://127.0.0.1:${port}/track`, { ca, origin });
  const inbox: Array<Record<string, unknown>> = [];
  const waiters: Array<() => void> = [];
  ws.on('message', (d) => {
    inbox.push(JSON.parse(String(d)));
    waiters.splice(0).forEach((w) => w());
  });
  const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  const next = async (timeout = 3000): Promise<Record<string, unknown>> => {
    const t0 = Date.now();
    while (!inbox.length) {
      if (Date.now() - t0 > timeout) throw new Error('No message in time.');
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, 50);
      });
    }
    return inbox.shift()!;
  };
  return { ws, next, closed, send: (m: unknown) => ws.send(JSON.stringify(m)) };
}

const until = async (ok: () => boolean, timeout = 3000): Promise<void> => {
  const t0 = Date.now();
  while (!ok()) {
    if (Date.now() - t0 > timeout) throw new Error('Not in time.');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('the phone tracker server', () => {
  it('serves only the phone page, its scripts and the face model, to its own host names', async () => {
    const { port, ca } = await start();
    const page = await get(port, ca, '/');
    expect(page).toMatchObject({ status: 200, type: 'text/html; charset=utf-8' });
    expect(page.csp).toContain("default-src 'self'");
    expect((await get(port, ca, '/assets/phone-1.js')).status).toBe(200);
    expect((await get(port, ca, '/assets/shared-2.js')).status).toBe(200);
    expect((await get(port, ca, '/assets/vision-3.js')).status).toBe(200);
    expect(
      (await get(port, ca, '/mediapipe/face_landmarker.task', { method: 'HEAD' })).status,
    ).toBe(200);
    expect((await get(port, ca, '/mediapipe/wasm/vision_wasm_internal.wasm')).type).toBe(
      'application/wasm',
    );
    // The app itself, its other scripts, other models and anything outside: not here.
    for (const path of [
      '/index.html',
      '/assets/main-4.js',
      '/mediapipe/hand_landmarker.task',
      '/manifest.json',
      '/mediapipe/wasm/../../index.html',
      '/files/x',
    ])
      expect((await get(port, ca, path)).status, path).toBe(404);
    expect((await get(port, ca, '/', { method: 'POST' })).status).toBe(405);
    // Another host name (a rebinding page): refused.
    expect((await get(port, ca, '/', { host: `evil.example:${port}` })).status).toBe(403);
  });

  it('pairs a phone with the code, forwards its frames, and lets the person revoke it', async () => {
    const { s, port, ca, states, frames } = await start();
    const code = s.pairingCode!;
    expect(code).toMatch(/^\d{6}$/);
    expect(states.at(-1)).toMatchObject({
      on: true,
      port,
      urls: [`https://127.0.0.1:${port}/`],
      code,
      phones: [],
    });
    expect(states.at(-1)!.fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    // Another origin cannot open the tracking connection.
    await expect(phone(port, ca, 'https://evil.example')).rejects.toThrow(/403/);

    const p = await phone(port, ca);
    p.send({ type: 'hello', name: 'iPhone' });
    expect(await p.next()).toEqual({ type: 'pair_needed' });
    // Frames before pairing go nowhere.
    p.send({ type: 'frame', face: true, blendshapes: {} });
    p.send({ type: 'pair', code: code === '000000' ? '111111' : '000000', name: 'iPhone' });
    expect(await p.next()).toMatchObject({ type: 'pair_failed' });
    p.send({ type: 'pair', code, name: 'iPhone' });
    const paired = await p.next();
    expect(paired).toMatchObject({ type: 'paired', name: 'iPhone' });
    const token = paired.token as string;
    // One phone per code; the phone shows as connected.
    expect(s.pairingCode).not.toBe(code);
    await until(() => states.at(-1)!.phones[0]?.connected === true);
    const id = states.at(-1)!.phones[0]!.id;
    expect(frames).toEqual([]);

    p.send({ type: 'frame', face: true, blendshapes: { jawOpen: 0.4 }, matrix: Array(16).fill(0) });
    await until(() => frames.length === 1);
    expect(frames[0]).toEqual({
      type: 'phone_frame',
      phoneId: id,
      face: true,
      blendshapes: { jawOpen: 0.4 },
      matrix: Array(16).fill(0),
    });
    // Malformed frames are dropped.
    await new Promise((r) => setTimeout(r, 20));
    p.send({ type: 'frame', face: true, blendshapes: { jawOpen: 'wide' } });
    await new Promise((r) => setTimeout(r, 20));
    p.send({ type: 'frame', face: 'yes', blendshapes: {} });
    await new Promise((r) => setTimeout(r, 50));
    expect(frames).toHaveLength(1);
    p.ws.close();
    await until(() => states.at(-1)!.phones[0]?.connected === false);

    // Back later with its token: no code needed.
    const again = await phone(port, ca);
    again.send({ type: 'hello', token, name: 'iPhone' });
    expect(await again.next()).toEqual({ type: 'welcome', name: 'iPhone' });
    // Revoked: disconnected, and the token no longer works.
    s.revoke(id);
    expect(await again.closed).toBe(4401);
    expect(states.at(-1)!.phones).toEqual([]);
    const third = await phone(port, ca);
    third.send({ type: 'hello', token, name: 'iPhone' });
    expect(await third.next()).toEqual({ type: 'pair_needed' });
    third.ws.close();
  });

  it('changes the code after five wrong tries, and is gone when switched off', async () => {
    const { s, port, ca, states } = await start();
    const first = s.pairingCode!;
    const p = await phone(port, ca);
    p.send({ type: 'hello', name: 'Phone' });
    await p.next();
    const wrong = first === '123456' ? '654321' : '123456';
    for (let i = 0; i < 5; i++) p.send({ type: 'pair', code: wrong, name: 'Phone' });
    await until(() => s.pairingCode !== first);
    expect(states.at(-1)!.code).toBe(s.pairingCode);
    // The old code no longer pairs.
    p.send({ type: 'pair', code: first, name: 'Phone' });
    for (let i = 0; i < 6; i++) expect((await p.next(4000)).type).toBe('pair_failed');

    await s.setEnabled(false);
    expect(await p.closed).toBeGreaterThan(0);
    expect(states.at(-1)).toMatchObject({ on: false, port: null, code: null, urls: [] });
    await expect(get(port, ca, '/')).rejects.toThrow();
  }, 15_000);

  it('says so when the phone page has not been built', async () => {
    const states: BridgeToHostPhone[] = [];
    server = new PhoneServer({
      dir: mkdtempSync(join(tmpdir(), 'mochi-phone-store-')),
      staticDir: mkdtempSync(join(tmpdir(), 'mochi-phone-empty-')),
      port: 0,
      host: '127.0.0.1',
      log: () => undefined,
      toHost: (m) => states.push(m) > 0,
    });
    await server.setEnabled(true);
    expect(server.enabled).toBe(false);
    expect(states.at(-1)).toMatchObject({
      on: false,
      problem: expect.stringContaining('npm run build'),
    });
  });
});
