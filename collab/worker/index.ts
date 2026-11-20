/**
 * The collaboration signaling server as a Cloudflare Worker
 * (docs/collaboration.md, "Run it on Cloudflare"), beside the Node one
 * (collab/server.ts), with the same rooms (src/core/collab/rooms.ts), routes
 * and limits.
 *
 * - **`/ws?room=<id>`:** the WebSocket. Each room is a Durable Object of its
 *   own (`RoomObject`), named after the room id, with WebSocket
 *   hibernation: between messages it sleeps, its rooms written to its
 *   storage, and the alarm wakes it for the grace and the expiry.
 * - **`/join/<room>`:** the invitation's page. **`/health`:** counts only.
 * - **Limits:** one address's connections and rooms are counted in a
 *   Durable Object named after a hash of the address (`AddressObject`); the
 *   address itself is not stored. Message size and rate per connection.
 * - **Relay:** Cloudflare's TURN service, with the key as a Worker secret
 *   (collab/worker/turn.ts); STUN only without one.
 * - **Logging:** none. The code writes no logs, and the configuration
 *   (wrangler.toml) turns Workers Logs off.
 */
import { JOIN_PAGE } from '../../src/core/collab/joinPage.ts';
import {
  addressLimitSettings,
  AddressLimits,
  LIMITS,
  RateWindow,
  type AddressLimitsSnapshot,
} from '../../src/core/collab/limits.ts';
import {
  parseClientMessage,
  ROOM_ID,
  type ClientMessage,
  type ServerMessage,
} from '../../src/core/collab/protocol.ts';
import { Rooms, type Connection, type RoomsSnapshot } from '../../src/core/collab/rooms.ts';
import type {
  DurableObjectNamespace,
  DurableObjectState,
  HibernatableWebSocket,
} from './cloudflare.ts';
import { cloudflareIceServers, DEFAULT_TURN_TTL } from './turn.ts';

export interface Env {
  ROOMS: DurableObjectNamespace;
  ADDRESSES: DurableObjectNamespace;
  COUNTS: DurableObjectNamespace;
  /** Cloudflare's TURN key (`wrangler secret put`); without them, STUN only. */
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
  /** Seconds the relay credentials last (default 13 hours). */
  TURN_TTL?: string;
  /** The TURN service's address (tests use a stand-in). */
  TURN_API?: string;
  /** The limits per address, if not the defaults (src/core/collab/limits.ts). */
  LIMIT_CONNECTIONS_PER_ADDRESS?: string;
  LIMIT_ROOMS_PER_ADDRESS?: string;
  LIMIT_NEW_CONNECTIONS_PER_MINUTE?: string;
}

/** What the Worker tells a room's object about a new connection. */
const H_CONN = 'x-mochi-conn';
const H_ADDRESS = 'x-mochi-address';
const H_ROOM = 'x-mochi-room';

/** A WebSocket that is told why and closed at once (the app shows the reason). */
function refusedSocket(reason: 'busy' | 'no-room'): Response {
  const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
  (server as unknown as { accept(): void }).accept();
  server.send(JSON.stringify({ t: 'refused', reason } satisfies ServerMessage));
  server.close(1000);
  return new Response(null, { status: 101, webSocket: client } as ResponseInit);
}

async function hashHex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'GET' && /^\/join\/[0-9a-f]{1,64}$/.test(url.pathname))
      return new Response(JOIN_PAGE, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      });
    if (req.method === 'GET' && url.pathname === '/health')
      return env.COUNTS.get(env.COUNTS.idFromName('all')).fetch('https://counts/get');
    if (url.pathname !== '/ws') return new Response(null, { status: 404 });
    if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket')
      return new Response('A WebSocket is expected here.', { status: 426 });
    const room = url.searchParams.get('room') ?? '';
    if (!ROOM_ID.test(room)) return refusedSocket('no-room');
    // Limits per address, counted under a hash of it: the address is not kept.
    const address = await hashHex(req.headers.get('cf-connecting-ip') ?? '');
    const conn = crypto.randomUUID();
    const admit = await env.ADDRESSES.get(env.ADDRESSES.idFromName(address)).fetch(
      'https://addresses/admit',
      { method: 'POST', body: JSON.stringify({ conn, room }) },
    );
    if (((await admit.json()) as { refusal?: string }).refusal) return refusedSocket('busy');
    const headers = new Headers(req.headers);
    headers.set(H_CONN, conn);
    headers.set(H_ADDRESS, address);
    headers.set(H_ROOM, room);
    return env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(new Request(req, { headers }));
  },
};

interface Attachment {
  conn: string;
  address: string;
}

/** One room: its connections (hibernatable WebSockets) and its state, in its storage. */
export class RoomObject {
  private state: DurableObjectState;
  private env: Env;
  private rooms: Rooms | undefined;
  private room = '';
  private sockets = new Map<string, HibernatableWebSocket>();
  private connections = new Map<string, Connection>();
  private rates = new Map<string, RateWindow>();
  private lastCounts = '';

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  /** The rooms, read back from storage the first time after waking. */
  private async load(): Promise<Rooms> {
    if (this.rooms) return this.rooms;
    const [snap, room] = await Promise.all([
      this.state.storage.get<RoomsSnapshot>('rooms'),
      this.state.storage.get<string>('room'),
    ]);
    this.room = room ?? this.room;
    for (const ws of this.state.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a) this.wire(ws, a);
    }
    const options = {
      relay: (peer: string) => this.relay(peer),
    };
    this.rooms = snap ? Rooms.restore(snap, this.connections, options) : new Rooms(options);
    // A socket the snapshot didn't know yet (it came just before a sleep).
    for (const c of this.connections.values()) if (!this.rooms.knows(c)) this.rooms.connect(c);
    return this.rooms;
  }

  private wire(ws: HibernatableWebSocket, a: Attachment): Connection {
    const c: Connection = {
      id: a.conn,
      send: (m) => {
        try {
          ws.send(JSON.stringify(m));
        } catch {
          // Closed already.
        }
      },
      close: () => {
        try {
          ws.close(1000);
        } catch {
          // Closed already.
        }
        void this.release(a);
      },
    };
    this.sockets.set(a.conn, ws);
    this.connections.set(a.conn, c);
    return c;
  }

  private relay(_peer: string) {
    const now = Date.now();
    const ttlSeconds = Number(this.env.TURN_TTL) || DEFAULT_TURN_TTL;
    if (!this.env.TURN_KEY_ID || !this.env.TURN_KEY_API_TOKEN)
      return {
        iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }],
        expires: now + ttlSeconds * 1000,
      };
    return cloudflareIceServers(
      {
        keyId: this.env.TURN_KEY_ID,
        apiToken: this.env.TURN_KEY_API_TOKEN,
        ttlSeconds,
        ...(this.env.TURN_API ? { api: this.env.TURN_API } : {}),
      },
      now,
    );
  }

  private async release(a: Attachment): Promise<void> {
    await this.env.ADDRESSES.get(this.env.ADDRESSES.idFromName(a.address))
      .fetch('https://addresses/release', {
        method: 'POST',
        body: JSON.stringify({ conn: a.conn }),
      })
      .catch(() => undefined);
  }

  /** Writes the rooms out, sets the alarm for the next deadline, and reports the counts. */
  private async save(): Promise<void> {
    const rooms = this.rooms!;
    const s = rooms.stats();
    const counts = JSON.stringify({ rooms: s.rooms, members: s.members, knocking: s.knocking });
    if (counts !== this.lastCounts) {
      this.lastCounts = counts;
      await this.env.COUNTS.get(this.env.COUNTS.idFromName('all'))
        .fetch('https://counts/set', {
          method: 'POST',
          body: JSON.stringify({ room: this.room, ...JSON.parse(counts) }),
        })
        .catch(() => undefined);
    }
    if (rooms.empty && !this.state.getWebSockets().length) {
      // Nothing is kept after a room ends.
      await this.state.storage.deleteAlarm();
      await this.state.storage.deleteAll();
      return;
    }
    await this.state.storage.put('rooms', rooms.snapshot());
    const next = rooms.nextDeadline();
    if (next === undefined) await this.state.storage.deleteAlarm();
    else await this.state.storage.setAlarm(next);
  }

  async fetch(req: Request): Promise<Response> {
    const conn = req.headers.get(H_CONN);
    const address = req.headers.get(H_ADDRESS);
    const room = req.headers.get(H_ROOM);
    if (!conn || !address || !room) return new Response(null, { status: 400 });
    const rooms = await this.load();
    if (!this.room) {
      this.room = room;
      await this.state.storage.put('room', room);
    }
    const [client, server] = Object.values(new WebSocketPair()) as [
      WebSocket,
      HibernatableWebSocket,
    ];
    this.state.acceptWebSocket(server);
    const a: Attachment = { conn, address };
    server.serializeAttachment(a);
    rooms.connect(this.wire(server, a));
    await this.save();
    return new Response(null, { status: 101, webSocket: client } as ResponseInit);
  }

  async webSocketMessage(ws: HibernatableWebSocket, data: string | ArrayBuffer): Promise<void> {
    const rooms = await this.load();
    const a = ws.deserializeAttachment() as Attachment | null;
    const conn = a && this.connections.get(a.conn);
    if (!a || !conn) return;
    let rate = this.rates.get(a.conn);
    if (!rate) this.rates.set(a.conn, (rate = new RateWindow()));
    if (typeof data !== 'string' || !rate.allow(Date.now())) return;
    if (data.length > LIMITS.messageBytes)
      return conn.send({ t: 'error', code: 'bad_message', message: 'Too long.' });
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      return conn.send({ t: 'error', code: 'bad_message', message: 'Not JSON.' });
    }
    const m = parseClientMessage(raw);
    if (!m) return conn.send({ t: 'error', code: 'bad_message', message: 'Not a message.' });
    // This object holds one room: a message naming another finds none here.
    if (hasRoom(m) && m.room !== this.room) {
      conn.send({ t: 'refused', reason: 'no-room' });
      conn.close();
    } else await rooms.message(conn, m);
    await this.save();
  }

  async webSocketClose(ws: HibernatableWebSocket): Promise<void> {
    await this.closed(ws);
  }

  async webSocketError(ws: HibernatableWebSocket): Promise<void> {
    await this.closed(ws);
  }

  private async closed(ws: HibernatableWebSocket): Promise<void> {
    const rooms = await this.load();
    const a = ws.deserializeAttachment() as Attachment | null;
    if (!a) return;
    const conn = this.connections.get(a.conn);
    this.connections.delete(a.conn);
    this.sockets.delete(a.conn);
    this.rates.delete(a.conn);
    try {
      ws.close(1000);
    } catch {
      // Closed already.
    }
    if (conn) rooms.disconnect(conn);
    await this.release(a);
    await this.save();
  }

  /** The grace's end or the room's expiry. */
  async alarm(): Promise<void> {
    const rooms = await this.load();
    rooms.sweep();
    await this.save();
  }
}

const hasRoom = (m: ClientMessage): m is Extract<ClientMessage, { room: string }> => 'room' in m;

/** One address's limits, under a hash of the address. */
export class AddressObject {
  private state: DurableObjectState;
  private env: Env;
  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    const body = (await req.json()) as { conn: string; room?: string };
    const now = Date.now();
    const limits = AddressLimits.restore(
      await this.state.storage.get<AddressLimitsSnapshot>('limits'),
      addressLimitSettings({
        connectionsPerAddress: this.env.LIMIT_CONNECTIONS_PER_ADDRESS,
        roomsPerAddress: this.env.LIMIT_ROOMS_PER_ADDRESS,
        newConnectionsPerMinute: this.env.LIMIT_NEW_CONNECTIONS_PER_MINUTE,
      }),
    );
    const refusal =
      path === '/admit' ? limits.admit(body.conn, body.room ?? '', now) : limits.release(body.conn);
    if (limits.idle(now)) await this.state.storage.deleteAll();
    else await this.state.storage.put('limits', limits.snapshot());
    return json(refusal ? { refusal } : {});
  }
}

/** The counts `/health` gives: rooms, members and knocks, over every room. */
export class CountsObject {
  private state: DurableObjectState;
  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    const all = (await this.state.storage.get<Record<string, [number, number]>>('rooms')) ?? {};
    if (path === '/set') {
      const b = (await req.json()) as {
        room: string;
        rooms: number;
        members: number;
        knocking: number;
      };
      if (b.rooms) all[b.room] = [b.members, b.knocking];
      else delete all[b.room];
      await this.state.storage.put('rooms', all);
      return json({});
    }
    const values = Object.values(all);
    return json({
      rooms: values.length,
      members: values.reduce((n, [m]) => n + m, 0),
      knocking: values.reduce((n, [, k]) => n + k, 0),
    });
  }
}
