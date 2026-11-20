/**
 * The phone tracker: a small page on the local network that
 * a phone opens, where MediaPipe tracks the face in the phone's browser;
 * only the tracking values come back, over a WebSocket, and go to Mochi
 * Studio like its own camera's. Off until the person switches it on.
 *
 * What is exposed, while it is on:
 *
 * - one port (27890, or the next free one) on this computer's addresses,
 *   over https with a certificate made on this computer (bridge/src/cert.ts;
 *   phones' browsers open the camera only on secure pages);
 * - the phone page, its scripts and MediaPipe's face-tracking files (all
 *   public code); nothing else: no other page, no file, no command;
 * - the tracking WebSocket (`/track`): a phone pairs with the code shown in
 *   Mochi Studio (one phone per code; the code changes after five wrong
 *   tries), then sends face values. Nothing but pairing answers goes back.
 *
 * Approved phones are kept in `phones.json` (only a hash of each token) and
 * can be revoked; the certificate and its key in `phone-tls.json`, both
 * readable by the user only.
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { existsSync, readFile, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer, type Server } from 'node:https';
import type { AddressInfo, Socket } from 'node:net';
import { networkInterfaces } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import {
  DEFAULT_PHONE_PORT,
  MAX_PAIR_FAILURES,
  PHONE_PORT_TRIES,
  parsePhoneFrame,
  type BridgeToHostPhone,
  type BridgeToPhone,
  type PhoneInfo,
} from '../../src/core/phoneProtocol.ts';
import { fingerprint, selfSignedCertificate, type TlsIdentity } from './cert.ts';
import { guardSocket, guardWebSocket } from './socketGuard.ts';

export interface PhoneServerOptions {
  /** The bridge's folder (phones.json and phone-tls.json go there). */
  dir: string;
  /** The built Mochi Studio pages (phone.html, its scripts, MediaPipe's files). */
  staticDir?: string;
  /** First port to try (default 27890); the next ones follow when taken. */
  port?: number;
  /** Where to listen (default every address, for the local network; tests use 127.0.0.1). */
  host?: string;
  /** This computer's addresses for phones (default: its network interfaces' IPv4 addresses). */
  addresses?: () => string[];
  log: (m: string) => void;
  toHost: (m: BridgeToHostPhone) => boolean;
}

/** This computer's IPv4 addresses on its networks, private ranges first (no IPv6: often public). */
export function localAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces()))
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  const rank = (ip: string): number =>
    /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip) ? 0 : ip.startsWith('169.254.') ? 2 : 1;
  return [...new Set(out)].sort((a, b) => rank(a) - rank(b));
}

interface PhoneRecord {
  id: string;
  name: string;
  hash: string;
  created: number;
  lastSeen: number | null;
}

const hash = (token: string): string => createHash('sha256').update(token).digest('hex');
const same = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

class PhoneStore {
  private file: string;
  private tlsFile: string;
  records: PhoneRecord[];

  constructor(dir: string) {
    this.file = join(dir, 'phones.json');
    this.tlsFile = join(dir, 'phone-tls.json');
    this.records = this.load();
  }

  private load(): PhoneRecord[] {
    if (!existsSync(this.file)) return [];
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { phones?: unknown };
      return Array.isArray(raw.phones)
        ? (raw.phones as PhoneRecord[]).filter(
            (r) => r && typeof r.id === 'string' && typeof r.hash === 'string',
          )
        : [];
    } catch {
      return [];
    }
  }

  private save(): void {
    writeFileSync(this.file, JSON.stringify({ version: 1, phones: this.records }, null, 2), {
      mode: 0o600,
    });
  }

  add(name: string): { token: string; record: PhoneRecord } {
    const token = randomBytes(24).toString('base64url');
    const record: PhoneRecord = {
      id: `phone-${randomBytes(4).toString('hex')}`,
      name,
      hash: hash(token),
      created: Date.now(),
      lastSeen: Date.now(),
    };
    this.records.push(record);
    this.save();
    return { token, record };
  }

  byToken(token: string): PhoneRecord | undefined {
    const h = hash(token);
    return this.records.find((r) => same(r.hash, h));
  }

  touch(id: string): void {
    const r = this.records.find((x) => x.id === id);
    if (!r) return;
    r.lastSeen = Date.now();
    this.save();
  }

  remove(id: string): boolean {
    const n = this.records.length;
    this.records = this.records.filter((r) => r.id !== id);
    if (this.records.length === n) return false;
    this.save();
    return true;
  }

  /** The certificate for these names: the kept one, or a new one when the names changed or it runs out. */
  tls(names: readonly string[]): TlsIdentity {
    try {
      const t = JSON.parse(readFileSync(this.tlsFile, 'utf8')) as TlsIdentity;
      const want = new Set(['localhost', ...names]);
      if (
        typeof t.cert === 'string' &&
        typeof t.key === 'string' &&
        Array.isArray(t.names) &&
        t.names.length === want.size &&
        t.names.every((n) => want.has(n)) &&
        t.notAfter - Date.now() > 7 * 86_400_000
      )
        return t;
    } catch {
      /* none yet */
    }
    const t = selfSignedCertificate(names);
    writeFileSync(this.tlsFile, JSON.stringify(t), { mode: 0o600 });
    return t;
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
};
/** The phone page may load only its own files, MediaPipe's, and talk to this server. */
const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "connect-src 'self'",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');
/** Frames closer than this (ms) are dropped: at most about 60 a second. */
const MIN_FRAME_GAP_MS = 15;

interface Connection {
  phoneId?: string;
  name: string;
  lastFrame: number;
  alive: boolean;
}

export class PhoneServer {
  private on = false;
  private server: Server | undefined;
  private wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  private actualPort: number | null = null;
  private problem: string | undefined;
  private code: string | null = null;
  private failures = 0;
  private connections = new Map<WebSocket, Connection>();
  private store: PhoneStore;
  private identity: TlsIdentity | undefined;
  /** The phone page's own files under /assets/ (from the build's manifest). */
  private assets = new Set<string>();
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private starting: Promise<void> | undefined;
  private opts: PhoneServerOptions & { port: number; host: string; addresses: () => string[] };

  constructor(o: PhoneServerOptions) {
    this.opts = {
      ...o,
      port: o.port ?? DEFAULT_PHONE_PORT,
      host: o.host ?? '0.0.0.0',
      addresses: o.addresses ?? localAddresses,
    };
    this.store = new PhoneStore(o.dir);
  }

  get enabled(): boolean {
    return this.on;
  }
  get port(): number | null {
    return this.actualPort;
  }
  /** The pairing code (for tests and the log). */
  get pairingCode(): string | null {
    return this.code;
  }

  async setEnabled(on: boolean): Promise<void> {
    await this.starting;
    if (on === this.on) return this.sendState();
    this.on = on;
    if (on) {
      this.starting = this.start();
      await this.starting;
      this.starting = undefined;
    } else await this.stop();
    this.sendState();
  }

  private async start(): Promise<void> {
    this.problem = undefined;
    const dir = this.opts.staticDir;
    if (!dir || !existsSync(join(dir, 'phone.html'))) {
      this.problem = 'The phone page is missing: build Mochi Studio first (npm run build).';
      this.on = false;
      return;
    }
    this.assets = phoneAssets(dir);
    const names = this.opts.addresses();
    try {
      this.identity = this.store.tls(names);
    } catch (e) {
      this.problem = `The phone tracker could not make its certificate: ${(e as Error).message}`;
      this.on = false;
      return;
    }
    for (let i = 0; i < PHONE_PORT_TRIES; i++) {
      const server = createServer({ key: this.identity.key, cert: this.identity.cert }, (q, s) =>
        this.serve(q, s),
      );
      server.on('upgrade', (q, socket, head) => this.upgrade(q, socket as Socket, head));
      try {
        await new Promise<void>((res, rej) => {
          server.once('error', rej);
          server.listen(this.opts.port + i, this.opts.host, () => {
            server.off('error', rej);
            res();
          });
        });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') continue;
        this.problem = `The phone tracker could not start: ${(e as Error).message}`;
        this.on = false;
        return;
      }
      this.server = server;
      this.actualPort = (server.address() as AddressInfo).port;
      this.code = newCode();
      this.failures = 0;
      this.heartbeat = setInterval(() => this.ping(), 10_000);
      this.opts.log(
        `Phone tracker on ${this.urls()[0] ?? `port ${this.actualPort}`} (local network).`,
      );
      return;
    }
    this.problem = `The phone tracker could not start: ports ${this.opts.port}–${this.opts.port + PHONE_PORT_TRIES - 1} are taken.`;
    this.on = false;
  }

  async stop(): Promise<void> {
    this.on = false;
    clearInterval(this.heartbeat);
    for (const ws of this.connections.keys()) ws.terminate();
    this.connections.clear();
    const s = this.server;
    this.server = undefined;
    this.actualPort = null;
    this.code = null;
    if (s)
      await new Promise<void>((r) => {
        s.close(() => r());
        s.closeAllConnections();
      });
  }

  /** Takes a phone's approval back: it is disconnected and must pair again. */
  revoke(phoneId: string): void {
    if (!this.store.remove(phoneId)) return;
    for (const [ws, c] of this.connections)
      if (c.phoneId === phoneId) {
        c.phoneId = undefined;
        ws.close(4401, 'revoked');
      }
    this.opts.log('A phone was revoked.');
    this.sendState();
  }

  /** The addresses a phone opens. */
  private urls(): string[] {
    if (this.actualPort === null) return [];
    return this.opts.addresses().map((a) => `https://${a}:${this.actualPort}/`);
  }

  sendState(): void {
    const connected = new Set([...this.connections.values()].map((c) => c.phoneId));
    const phones: PhoneInfo[] = this.store.records.map((r) => ({
      id: r.id,
      name: r.name,
      connected: connected.has(r.id),
      lastSeen: r.lastSeen,
    }));
    this.opts.toHost({
      type: 'phone_state',
      on: this.on,
      port: this.actualPort,
      urls: this.urls(),
      code: this.on ? this.code : null,
      fingerprint: this.on && this.identity ? fingerprint(this.identity.cert) : null,
      ...(this.problem ? { problem: this.problem } : {}),
      phones,
    });
  }

  // --- http ----------------------------------------------------------------------

  /** The Host header must name this server (no DNS rebinding). */
  private hostAllowed(req: IncomingMessage): boolean {
    const host = req.headers.host ?? '';
    const names = ['localhost', '127.0.0.1', ...this.opts.addresses()];
    return names.some((n) => host === `${n}:${this.actualPort}`);
  }

  private serve(req: IncomingMessage, res: ServerResponse): void {
    if (!this.hostAllowed(req)) return void res.writeHead(403).end();
    if (req.method !== 'GET' && req.method !== 'HEAD') return void res.writeHead(405).end();
    const path = (req.url ?? '/').split('?')[0]!;
    const root = resolve(this.opts.staticDir!);
    let file: string | undefined;
    if (path === '/' || path === '/phone.html') file = join(root, 'phone.html');
    else if (path.startsWith('/assets/') && this.assets.has(path.slice('/assets/'.length)))
      file = join(root, 'assets', path.slice('/assets/'.length));
    else if (path === '/mediapipe/face_landmarker.task')
      file = join(root, 'mediapipe', 'face_landmarker.task');
    else if (/^\/mediapipe\/wasm\/[A-Za-z0-9_.-]+$/.test(path))
      file = join(root, 'mediapipe', 'wasm', path.slice('/mediapipe/wasm/'.length));
    if (!file || !resolve(file).startsWith(root + sep)) return void res.writeHead(404).end();
    readFile(file, (err, data) => {
      if (err) return void res.writeHead(404).end();
      const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
      res.writeHead(200, {
        'content-type': type,
        'content-length': String(data.length),
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        ...(type.startsWith('text/html') ? { 'content-security-policy': PAGE_CSP } : {}),
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  }

  private upgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    guardSocket(socket);
    const path = (req.url ?? '').split('?')[0];
    // Only the phone page itself (this server's origin) may connect.
    if (
      path !== '/track' ||
      !this.hostAllowed(req) ||
      req.headers.origin !== `https://${req.headers.host}`
    ) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) =>
      this.onPhone(guardWebSocket(ws, this.opts.log, 'A phone')),
    );
  }

  // --- phones --------------------------------------------------------------------

  private onPhone(ws: WebSocket): void {
    const c: Connection = { name: 'Phone', lastFrame: 0, alive: true };
    this.connections.set(ws, c);
    const send = (m: BridgeToPhone): void => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
    };
    ws.on('pong', () => (c.alive = true));
    ws.on('message', (raw: RawData) => {
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      if (typeof m !== 'object' || m === null) return;
      const name =
        typeof m.name === 'string' && m.name.trim() ? m.name.trim().slice(0, 60) : c.name;
      switch (m.type) {
        case 'hello': {
          c.name = name;
          const r = typeof m.token === 'string' ? this.store.byToken(m.token) : undefined;
          if (!r) return send({ type: 'pair_needed' });
          c.phoneId = r.id;
          this.store.touch(r.id);
          send({ type: 'welcome', name: r.name });
          return this.sendState();
        }
        case 'pair': {
          if (c.phoneId) return;
          const code = typeof m.code === 'string' ? m.code.replace(/\D/g, '') : '';
          if (!this.code || !same(code, this.code)) {
            this.failures++;
            if (this.failures >= MAX_PAIR_FAILURES) {
              this.code = newCode();
              this.failures = 0;
              this.opts.log('Too many wrong pairing codes: the phone code changed.');
              this.sendState();
            }
            // A second's wait makes guessing slow.
            setTimeout(
              () =>
                send({
                  type: 'pair_failed',
                  message: 'That is not the code Mochi Studio shows. Check it and try again.',
                }),
              1000,
            );
            return;
          }
          const { token, record } = this.store.add(name);
          c.phoneId = record.id;
          // One phone per code.
          this.code = newCode();
          this.failures = 0;
          this.opts.log(`A phone was paired: ${record.name}.`);
          send({ type: 'paired', token, name: record.name });
          return this.sendState();
        }
        case 'frame': {
          if (!c.phoneId) return;
          const now = Date.now();
          if (now - c.lastFrame < MIN_FRAME_GAP_MS) return;
          const f = parsePhoneFrame(m);
          if (!f) return;
          c.lastFrame = now;
          this.opts.toHost({ type: 'phone_frame', phoneId: c.phoneId, ...f });
          return;
        }
      }
    });
    ws.on('close', () => {
      const had = !!c.phoneId;
      this.connections.delete(ws);
      if (had) {
        if (c.phoneId) this.store.touch(c.phoneId);
        this.sendState();
      }
    });
  }

  private ping(): void {
    for (const [ws, c] of this.connections) {
      if (!c.alive) {
        ws.terminate();
        continue;
      }
      c.alive = false;
      ws.ping();
    }
  }
}

/** Six digits. */
function newCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/** The phone page's files under assets/: its entry, the chunks it imports and its styles (Vite's manifest). */
export function phoneAssets(staticDir: string): Set<string> {
  const out = new Set<string>();
  let manifest: Record<
    string,
    {
      file: string;
      imports?: string[];
      dynamicImports?: string[];
      css?: string[];
      assets?: string[];
    }
  >;
  try {
    manifest = JSON.parse(readFileSync(join(staticDir, 'manifest.json'), 'utf8'));
  } catch {
    return out;
  }
  const seen = new Set<string>();
  const visit = (key: string): void => {
    const e = manifest[key];
    if (!e || seen.has(key)) return;
    seen.add(key);
    for (const f of [e.file, ...(e.css ?? []), ...(e.assets ?? [])])
      if (f.startsWith('assets/')) out.add(f.slice('assets/'.length));
    for (const k of [...(e.imports ?? []), ...(e.dynamicImports ?? [])]) visit(k);
  };
  visit('phone.html');
  return out;
}
