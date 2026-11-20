/**
 * The collaboration signaling server under Node (docs/collaboration.md,
 * section 4): the rooms of src/core/collab/rooms.ts
 * over WebSockets, at `/ws`.
 *
 * - `GET /join/<room>`: the invitation link's page. It says to open the
 *   link in Mochi Studio; the secret after `#` never reaches the server.
 * - `GET /health`: counts only.
 * - **Relay (TURN):** with TURN_URLS and TURN_SECRET set, short-lived
 *   credentials in the TURN REST form that coturn's `use-auth-secret`
 *   accepts; without them, none.
 * - **Limits** (src/core/collab/limits.ts): message size and rate, and one
 *   address's connections and rooms.
 * - **Logging:** counts, once a minute while anything is open. Nothing about
 *   anyone.
 */
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { JOIN_PAGE } from '../src/core/collab/joinPage.ts';
import {
  LIMITS,
  LimitsByAddress,
  RateWindow,
  type AddressLimitSettings,
} from '../src/core/collab/limits.ts';
import { parseClientMessage, ROOM_ID, type IceServer } from '../src/core/collab/protocol.ts';
import { Rooms, type Connection, type RoomsOptions } from '../src/core/collab/rooms.ts';

export interface SignalingOptions {
  port?: number;
  host?: string;
  /** TURN servers (turn:… or turns:… URLs) and the shared secret for their REST credentials. */
  turn?: { urls: string[]; secret: string; ttlSeconds?: number };
  /** STUN servers, given as they are. */
  stun?: string[];
  log?: (m: string) => void;
  now?: RoomsOptions['now'];
  /** How often rooms are swept (expiry, the host's grace). */
  sweepMs?: number;
  /**
   * Behind a TLS proxy: take the address from its `X-Forwarded-For` (the
   * proxy's own address would count everyone as one).
   */
  trustProxy?: boolean;
  /** The limits per address (src/core/collab/limits.ts), if not the defaults. */
  limits?: AddressLimitSettings;
}

export interface SignalingServer {
  /** http://host:port */
  url: string;
  /** ws://host:port/ws */
  wsUrl: string;
  rooms: Rooms;
  /** What `/health` says. */
  stats(): Promise<{ rooms: number; members: number; knocking: number }>;
  close(): Promise<void>;
}

/** TURN REST credentials: username "expiry:peer", password base64(HMAC-SHA1(secret, username)). */
export function turnCredentials(
  secret: string,
  peer: string,
  expires: number,
): { username: string; credential: string } {
  const username = `${Math.floor(expires / 1000)}:${peer}`;
  return { username, credential: createHmac('sha1', secret).update(username).digest('base64') };
}

export async function startSignalingServer(o: SignalingOptions = {}): Promise<SignalingServer> {
  const log = o.log ?? ((m: string) => console.log(`[mochi-collab] ${m}`));
  const ttl = (o.turn?.ttlSeconds ?? 3600) * 1000;
  const rooms = new Rooms({
    ...(o.now ? { now: o.now } : {}),
    relay: (peer) => {
      const expires = Date.now() + ttl;
      const iceServers: IceServer[] = [];
      if (o.stun?.length) iceServers.push({ urls: o.stun });
      if (o.turn?.urls.length)
        iceServers.push({ urls: o.turn.urls, ...turnCredentials(o.turn.secret, peer, expires) });
      return { iceServers, expires };
    },
  });
  const http: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    if (req.method === 'GET' && /^\/join\/[0-9a-f]{1,64}$/.test(path)) {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(JOIN_PAGE);
      return;
    }
    if (req.method === 'GET' && path === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(rooms.stats()));
      return;
    }
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.messageBytes });
  const limits = new LimitsByAddress(o.limits);
  let connections = 0;
  http.on('upgrade', (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    const forwarded = o.trustProxy
      ? String(req.headers['x-forwarded-for'] ?? '')
          .split(',')[0]!
          .trim()
      : '';
    const address = forwarded || req.socket.remoteAddress || '';
    const room = url.searchParams.get('room') ?? '';
    wss.handleUpgrade(req, socket, head, (ws) =>
      wss.emit('connection', ws, { address, room: ROOM_ID.test(room) ? room : '' }),
    );
  });
  wss.on('connection', (ws: WebSocket, at: { address: string; room: string }) => {
    ws.on('error', () => ws.terminate());
    const id = `c${++connections}`;
    const conn: Connection = {
      send: (m) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
      },
      close: () => ws.close(1000),
    };
    // One address's connections and rooms (src/core/collab/limits.ts).
    if (limits.admit(at.address, id, at.room, Date.now())) {
      conn.send({ t: 'refused', reason: 'busy' });
      conn.close();
      return;
    }
    rooms.connect(conn);
    const rate = new RateWindow();
    ws.on('message', (data, binary) => {
      if (!rate.allow(Date.now()) || binary) return;
      let raw: unknown;
      try {
        raw = JSON.parse(String(data));
      } catch {
        return conn.send({ t: 'error', code: 'bad_message', message: 'Not JSON.' });
      }
      const m = parseClientMessage(raw);
      if (!m) return conn.send({ t: 'error', code: 'bad_message', message: 'Not a message.' });
      void rooms.message(conn, m);
    });
    ws.on('close', () => {
      limits.release(at.address, id, Date.now());
      rooms.disconnect(conn);
    });
  });
  const sweep = setInterval(() => rooms.sweep(), o.sweepMs ?? 5000);
  let lastLog = '';
  const counts = setInterval(() => {
    const s = rooms.stats();
    const line = `rooms ${s.rooms}, members ${s.members}, knocking ${s.knocking}`;
    if (line !== lastLog && (s.rooms || lastLog)) log(line);
    lastLog = line;
  }, 60_000);
  await new Promise<void>((resolve) => http.listen(o.port ?? 0, o.host ?? '127.0.0.1', resolve));
  const a = http.address() as AddressInfo;
  const hostPart = a.family === 'IPv6' ? `[${a.address}]` : a.address;
  return {
    url: `http://${hostPart}:${a.port}`,
    wsUrl: `ws://${hostPart}:${a.port}/ws`,
    rooms,
    stats: async () => rooms.stats(),
    close: async () => {
      clearInterval(sweep);
      clearInterval(counts);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      await new Promise<void>((r) => http.close(() => r()));
    },
  };
}
