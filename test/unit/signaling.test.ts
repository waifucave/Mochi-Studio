import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { startSignalingServer, turnCredentials } from '../../collab/server';
import { startLocalWorker } from '../../collab/worker/local';
import { signalingUrl } from '../../src/core/collab/protocol';

/**
 * The signaling protocol, the same tests against both servers: the Node one
 * (collab/server.ts) and the Worker (collab/worker/), run locally by
 * Miniflare with no Cloudflare account. Only the relay's credentials differ:
 * coturn's REST form from the Node server, Cloudflare's TURN service (a
 * stand-in here) from the Worker.
 */
interface Server_ {
  url: string;
  wsUrl: string;
  stats(): Promise<{ rooms: number; members: number; knocking: number }>;
  close(): Promise<void>;
}

/** A stand-in for Cloudflare's TURN API: what it was asked, and its documented answer. */
interface TurnStandIn {
  url: string;
  asked: Array<{ path: string; auth: string | undefined; body: unknown }>;
  close(): Promise<void>;
}

async function turnStandIn(): Promise<TurnStandIn> {
  const asked: TurnStandIn['asked'] = [];
  const read = (req: IncomingMessage) =>
    new Promise<string>((r) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => r(b));
    });
  const srv: Server = createServer(async (req, res) => {
    asked.push({
      path: req.url ?? '',
      auth: req.headers.authorization,
      body: JSON.parse(await read(req)),
    });
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        iceServers: [
          { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] },
          {
            urls: [
              'turn:turn.cloudflare.com:3478?transport=udp',
              'turn:turn.cloudflare.com:53?transport=udp',
              'turns:turn.cloudflare.com:443?transport=tcp',
            ],
            username: 'cf-user',
            credential: 'cf-secret',
          },
        ],
      }),
    );
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
    asked,
    close: () => new Promise<void>((r) => srv.close(() => r())),
  };
}

/** Limits high enough for a test file's many connections from 127.0.0.1. */
const ROOMY = { connectionsPerAddress: 500, roomsPerAddress: 500, newConnectionsPerMinute: 5000 };
const roomyVars = {
  LIMIT_CONNECTIONS_PER_ADDRESS: '500',
  LIMIT_ROOMS_PER_ADDRESS: '500',
  LIMIT_NEW_CONNECTIONS_PER_MINUTE: '5000',
};

let room = 0;
/** A fresh room id for each test (18 hex digits, as the app makes them). */
const newRoom = () => (++room).toString(16).padStart(18, '0');

function client(s: Server_, roomId: string) {
  const ws = new WebSocket(signalingUrl(s.wsUrl, roomId));
  const got: any[] = [];
  const waiters: (() => void)[] = [];
  let closed = false;
  ws.on('message', (d) => {
    got.push(JSON.parse(String(d)));
    waiters.splice(0).forEach((w) => w());
  });
  ws.on('close', () => {
    closed = true;
    waiters.splice(0).forEach((w) => w());
  });
  const opened = new Promise<void>((r) => ws.on('open', () => r()));
  return {
    ws,
    opened,
    get closed() {
      return closed;
    },
    send: (m: unknown) => ws.send(JSON.stringify(m)),
    /** The next message of a type (or one already received). */
    async next(t: string, ms = 5000): Promise<any> {
      const deadline = Date.now() + ms;
      for (;;) {
        const m = got.find((x) => x.t === t);
        if (m) {
          got.splice(got.indexOf(m), 1);
          return m;
        }
        if (Date.now() > deadline) throw new Error(`no "${t}" (got ${JSON.stringify(got)})`);
        await new Promise<void>((r) => {
          waiters.push(r);
          setTimeout(r, 100);
        });
      }
    },
  };
}

const servers: Array<{
  name: string;
  start(turn: TurnStandIn): Promise<Server_>;
  relay(turn: TurnStandIn, peer: string, iceServers: any[]): void;
}> = [
  {
    name: 'Node',
    start: () =>
      startSignalingServer({
        log: () => {},
        turn: { urls: ['turn:turn.example:3478'], secret: 'shh' },
        stun: ['stun:stun.example:3478'],
        limits: ROOMY,
      }),
    relay: (_turn, peer, iceServers) => {
      expect(iceServers[0]).toEqual({ urls: ['stun:stun.example:3478'] });
      const { username, credential } = iceServers[1];
      expect(iceServers[1].urls).toEqual(['turn:turn.example:3478']);
      expect(username).toMatch(new RegExp(`^\\d+:${peer}$`));
      const [expiry] = username.split(':');
      expect(credential).toBe(turnCredentials('shh', peer, Number(expiry) * 1000).credential);
    },
  },
  {
    name: 'Worker',
    start: (turn) =>
      startLocalWorker({
        bindings: {
          ...roomyVars,
          TURN_KEY_ID: 'key-id',
          TURN_KEY_API_TOKEN: 'key-token',
          TURN_API: turn.url,
        },
      }),
    relay: (turn, _peer, iceServers) => {
      // Asked with the key, for 13 hours (past a room's 12).
      expect(turn.asked.at(-1)).toEqual({
        path: '/v1/turn/keys/key-id/credentials/generate-ice-servers',
        auth: 'Bearer key-token',
        body: { ttl: 13 * 3600 },
      });
      // The service's answer, without its port-53 addresses.
      expect(iceServers).toEqual([
        { urls: ['stun:stun.cloudflare.com:3478'] },
        {
          urls: [
            'turn:turn.cloudflare.com:3478?transport=udp',
            'turns:turn.cloudflare.com:443?transport=tcp',
          ],
          username: 'cf-user',
          credential: 'cf-secret',
        },
      ]);
    },
  },
];

describe.each(servers)('the signaling protocol ($name)', (def) => {
  let s: Server_;
  let turn: TurnStandIn;
  beforeAll(async () => {
    turn = await turnStandIn();
    s = await def.start(turn);
  }, 60_000);
  afterAll(async () => {
    await s?.close();
    await turn?.close();
  });

  /** A host with a guest let in. */
  async function hostAndGuest(r = newRoom()) {
    const h = client(s, r);
    await h.opened;
    h.send({ t: 'host', v: 1, door: 'd1', room: r, name: 'enc:H', max: 6 });
    const hosted = await h.next('hosted');
    const g = client(s, r);
    await g.opened;
    g.send({ t: 'knock', v: 1, door: 'd1', room: r, name: 'enc:G', key: 'k1' });
    const knock = await h.next('knocking');
    h.send({ t: 'admit', peer: knock.peer });
    const admitted = await g.next('admitted');
    return { r, h, g, hosted, knock, admitted };
  }

  it('hosts, lets in, relays signals, and hands relay servers to members only', async () => {
    const { r, h, g, hosted, knock, admitted } = await hostAndGuest();
    expect(admitted).toMatchObject({ you: knock.peer, host: hosted.you });
    g.send({ t: 'signal', to: hosted.you, data: { type: 'offer', sdp: 'v=0' } });
    expect(await h.next('signal')).toEqual({
      t: 'signal',
      from: knock.peer,
      data: { type: 'offer', sdp: 'v=0' },
    });
    // A connection that knocked but isn't in: no relay servers.
    const k = client(s, r);
    await k.opened;
    k.send({ t: 'relay' });
    expect(await k.next('error')).toMatchObject({ code: 'not_member' });
    // A member: relay servers, with short-lived credentials.
    g.send({ t: 'relay' });
    const relay = await g.next('relay');
    def.relay(turn, knock.peer, relay.iceServers);
    expect(relay.expires).toBeGreaterThan(Date.now() + 50 * 60 * 1000);
    // Counts only.
    expect(await s.stats()).toMatchObject({
      rooms: expect.any(Number),
      members: expect.any(Number),
    });
    for (const c of [h, g, k]) c.ws.close();
  });

  it('keeps the door: an old link, a lock, a kick, a wrong room', async () => {
    const { r, h, g, knock } = await hostAndGuest();
    // A new link: the old door is refused.
    h.send({ t: 'door', door: 'd2' });
    const old = client(s, r);
    await old.opened;
    old.send({ t: 'knock', v: 1, door: 'd1', room: r, name: 'enc:O', key: 'k2' });
    expect(await old.next('refused')).toEqual({ t: 'refused', reason: 'old-link' });
    // Locked: refused.
    h.send({ t: 'lock', locked: true });
    expect(await g.next('locked')).toEqual({ t: 'locked', locked: true });
    const late = client(s, r);
    await late.opened;
    late.send({ t: 'knock', v: 1, door: 'd2', room: r, name: 'enc:L', key: 'k3' });
    expect(await late.next('refused')).toEqual({ t: 'refused', reason: 'locked' });
    h.send({ t: 'lock', locked: false });
    // Kicked, and its key refused after.
    h.send({ t: 'kick', peer: knock.peer });
    expect(await g.next('kicked')).toEqual({ t: 'kicked' });
    const again = client(s, r);
    await again.opened;
    again.send({ t: 'knock', v: 1, door: 'd2', room: r, name: 'enc:G', key: 'k1' });
    expect(await again.next('refused')).toEqual({ t: 'refused', reason: 'kicked' });
    // A room that doesn't exist.
    const none = newRoom();
    const n = client(s, none);
    await n.opened;
    n.send({ t: 'knock', v: 1, door: 'd', room: none, name: 'enc:N', key: 'k4' });
    expect(await n.next('refused')).toEqual({ t: 'refused', reason: 'no-room' });
    h.ws.close();
  });

  it('gives a dropped host its grace, and takes it back with its token', async () => {
    const { r, h, g, hosted } = await hostAndGuest();
    h.ws.close();
    expect(await g.next('host-away')).toMatchObject({ until: expect.any(Number) });
    const back = client(s, r);
    await back.opened;
    back.send({ t: 'resume', v: 1, room: r, token: hosted.token });
    expect(await back.next('resumed')).toMatchObject({ room: r, you: hosted.you });
    expect(await g.next('host-back')).toEqual({ t: 'host-back' });
    // The host leaving ends it for everyone.
    back.send({ t: 'leave' });
    expect(await g.next('ended')).toEqual({ t: 'ended', reason: 'host-left' });
  });

  it('answers bad messages, serves the invitation page, and refuses other paths', async () => {
    const c = client(s, newRoom());
    await c.opened;
    c.ws.send('not json');
    expect(await c.next('error')).toMatchObject({ code: 'bad_message' });
    c.send({ t: 'signal', to: 'x', data: 'y'.repeat(40_000) });
    expect(await c.next('error')).toMatchObject({ code: 'bad_message' });
    c.ws.close();
    const page = await fetch(`${s.url}/join/abc123`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('paste');
    expect((await fetch(`${s.url}/other`)).status).toBe(404);
  });
});

describe.each([
  {
    name: 'Node',
    start: () =>
      startSignalingServer({
        log: () => {},
        limits: { connectionsPerAddress: 3, roomsPerAddress: 2, newConnectionsPerMinute: 100 },
      }),
  },
  {
    name: 'Worker',
    start: () =>
      startLocalWorker({
        bindings: {
          LIMIT_CONNECTIONS_PER_ADDRESS: '3',
          LIMIT_ROOMS_PER_ADDRESS: '2',
          LIMIT_NEW_CONNECTIONS_PER_MINUTE: '100',
        },
      }),
  },
])('the limits per address ($name)', ({ start }) => {
  let s: Server_;
  beforeAll(async () => {
    s = await start();
  }, 60_000);
  afterAll(async () => {
    await s?.close();
  });

  it('refuses a third room and a fourth connection, and frees places when one closes', async () => {
    const [r1, r2, r3] = [newRoom(), newRoom(), newRoom()];
    const a = client(s, r1);
    const b = client(s, r1);
    const c = client(s, r2);
    await Promise.all([a.opened, b.opened, c.opened]);
    // A third room: refused, and told why.
    const d = client(s, r3);
    expect(await d.next('refused')).toEqual({ t: 'refused', reason: 'busy' });
    // Three connections are open: a fourth, even to a room it's in, too.
    const e = client(s, r1);
    expect(await e.next('refused')).toEqual({ t: 'refused', reason: 'busy' });
    // One closes: a place again.
    a.ws.close();
    await new Promise((r) => setTimeout(r, 300));
    const f = client(s, r1);
    await f.opened;
    f.send({ t: 'relay' });
    expect(await f.next('error')).toMatchObject({ code: 'not_member' });
    for (const x of [b, c, f]) x.ws.close();
  });
});
