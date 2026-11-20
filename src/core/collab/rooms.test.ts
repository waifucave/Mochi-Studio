import { describe, expect, it } from 'vitest';
import { HOST_GRACE_MS, ROOM_LIFETIME_MS, type ServerMessage } from './protocol';
import { Rooms, type Connection } from './rooms';

/** A fake connection: it keeps what the server sent and whether it closed. */
function conn() {
  const c = {
    got: [] as ServerMessage[],
    closed: false,
    send(m: ServerMessage) {
      c.got.push(m);
    },
    close() {
      c.closed = true;
    },
    last<T extends ServerMessage['t']>(t: T) {
      return [...c.got].reverse().find((m) => m.t === t) as Extract<ServerMessage, { t: T }>;
    },
  };
  return c;
}

let roomN = 0;
function setup() {
  let now = 1_000_000;
  let n = 0;
  const rooms = new Rooms({ now: () => now, randomId: () => `id${++n}` });
  const join = (c: ReturnType<typeof conn>) => {
    rooms.connect(c as Connection);
    return c;
  };
  const say = (c: ReturnType<typeof conn>, m: Parameters<Rooms['message']>[1]) =>
    rooms.message(c as Connection, m);
  return {
    rooms,
    join,
    say,
    advance: (ms: number) => {
      now += ms;
      rooms.sweep();
    },
    /** A host with a room. */
    host() {
      const h = join(conn());
      say(h, {
        t: 'host',
        v: 1,
        door: 'd1',
        room: `${'a'.repeat(15)}${++roomN}`,
        name: 'enc:Host',
        max: 3,
      });
      return { h, room: h.last('hosted').room, token: h.last('hosted').token };
    },
  };
}

describe('the signaling server’s rooms', () => {
  it('opens a room, and lets a knocker in only when the host says so', () => {
    const s = setup();
    const { h, room } = s.host();
    expect(h.last('hosted')).toMatchObject({ t: 'hosted', you: expect.any(String) });
    const g = s.join(conn());
    s.say(g, { t: 'knock', v: 1, door: 'd1', room, name: 'enc:Guest', key: 'k1' });
    expect(g.last('waiting')).toBeTruthy();
    const knock = h.last('knocking');
    expect(knock).toMatchObject({ name: 'enc:Guest' });
    // Before the answer, the knocker can't signal anyone.
    s.say(g, { t: 'signal', to: h.last('hosted').you, data: 'x' });
    expect(g.last('error')).toMatchObject({ code: 'not_member' });
    s.say(h, { t: 'admit', peer: knock.peer });
    expect(g.last('admitted')).toMatchObject({
      you: knock.peer,
      host: h.last('hosted').you,
      members: [{ id: h.last('hosted').you, name: 'enc:Host' }],
    });
    // Now signals pass, both ways, and only between members.
    s.say(g, { t: 'signal', to: h.last('hosted').you, data: { sdp: 'offer' } });
    expect(h.last('signal')).toEqual({ t: 'signal', from: knock.peer, data: { sdp: 'offer' } });
    s.say(h, { t: 'signal', to: 'nobody', data: 1 });
    expect(h.last('error')).toMatchObject({ code: 'no_member' });
    expect(s.rooms.stats()).toMatchObject({ rooms: 1, members: 2, knocking: 0 });
  });

  it('tells the members who joined and who left, and a declined knocker why', () => {
    const s = setup();
    const { h, room } = s.host();
    const a = s.join(conn());
    s.say(a, { t: 'knock', v: 1, door: 'd1', room, name: 'enc:A', key: 'ka' });
    s.say(h, { t: 'admit', peer: h.last('knocking').peer });
    const b = s.join(conn());
    s.say(b, { t: 'knock', v: 1, door: 'd1', room, name: 'enc:B', key: 'kb' });
    s.say(h, { t: 'admit', peer: h.last('knocking').peer });
    expect(a.last('joined')).toMatchObject({ name: 'enc:B' });
    expect(b.last('admitted').members).toHaveLength(2);
    s.say(b, { t: 'leave' });
    expect(a.last('left')).toMatchObject({ reason: 'left' });
    expect(b.closed).toBe(true);
    const c = s.join(conn());
    s.say(c, { t: 'knock', v: 1, door: 'd1', room, name: 'enc:C', key: 'kc' });
    s.say(h, { t: 'decline', peer: h.last('knocking').peer });
    expect(c.last('refused')).toEqual({ t: 'refused', reason: 'declined' });
    expect(c.closed).toBe(true);
    // A knocker who goes away before an answer.
    const d = s.join(conn());
    s.say(d, { t: 'knock', v: 1, door: 'd1', room, name: 'enc:D', key: 'kd' });
    s.rooms.disconnect(d as Connection);
    expect(h.last('knock-gone')).toMatchObject({ peer: h.last('knocking').peer });
  });

  it('refuses knocks on a locked or full room, and only the host locks or kicks', () => {
    const s = setup();
    const { h, room } = s.host();
    const a = s.join(conn());
    s.say(a, { t: 'knock', v: 1, door: 'd1', room, name: 'enc:A', key: 'ka' });
    s.say(h, { t: 'admit', peer: h.last('knocking').peer });
    s.say(a, { t: 'lock', locked: true });
    expect(a.last('error')).toMatchObject({ code: 'not_host' });
    s.say(h, { t: 'lock', locked: true });
    expect(a.last('locked')).toEqual({ t: 'locked', locked: true });
    const b = s.join(conn());
    s.say(b, { t: 'knock', v: 1, door: 'd1', room, name: 'enc:B', key: 'kb' });
    expect(b.last('refused').reason).toBe('locked');
    s.say(h, { t: 'lock', locked: false });
    const c = s.join(conn());
    s.say(c, { t: 'knock', v: 1, door: 'd1', room, name: 'enc:C', key: 'kc' });
    s.say(h, { t: 'admit', peer: h.last('knocking').peer });
    // The room was opened for 3.
    const d = s.join(conn());
    s.say(d, { t: 'knock', v: 1, door: 'd1', room, name: 'enc:D', key: 'kd' });
    expect(d.last('refused').reason).toBe('full');
    const e = s.join(conn());
    s.say(e, { t: 'knock', v: 1, door: 'd1', room: 'nope', name: 'enc:E', key: 'ke' });
    expect(e.last('refused').reason).toBe('no-room');
    const f = s.join(conn());
    s.say(f, { t: 'host', v: 99, door: 'd1', room: 'b'.repeat(16), name: 'enc:F', max: 2 });
    expect(f.last('refused').reason).toBe('version');
  });

  it('kicks: the person is told and cut off, the others are told, and the same key is refused', () => {
    const s = setup();
    const { h, room } = s.host();
    const a = s.join(conn());
    s.say(a, { t: 'knock', v: 1, door: 'd1', room, name: 'enc:A', key: 'ka' });
    s.say(h, { t: 'admit', peer: h.last('knocking').peer });
    const b = s.join(conn());
    s.say(b, { t: 'knock', v: 1, door: 'd1', room, name: 'enc:B', key: 'kb' });
    const bId = h.last('knocking').peer;
    s.say(h, { t: 'admit', peer: bId });
    s.say(h, { t: 'kick', peer: bId });
    expect(b.last('kicked')).toBeTruthy();
    expect(b.closed).toBe(true);
    expect(a.last('left')).toEqual({ t: 'left', peer: bId, reason: 'kicked' });
    const again = s.join(conn());
    s.say(again, { t: 'knock', v: 1, door: 'd1', room, name: 'enc:B', key: 'kb' });
    expect(again.last('refused').reason).toBe('kicked');
    s.say(h, { t: 'kick', peer: h.last('hosted').you });
    expect(h.last('error')).toMatchObject({ code: 'self' });
  });

  it('gives a dropped host a grace to come back, then ends the room', () => {
    const s = setup();
    const { h, room, token } = s.host();
    const a = s.join(conn());
    s.say(a, { t: 'knock', v: 1, door: 'd1', room, name: 'enc:A', key: 'ka' });
    s.say(h, { t: 'admit', peer: h.last('knocking').peer });
    s.rooms.disconnect(h as Connection);
    expect(a.last('host-away')).toBeTruthy();
    s.advance(HOST_GRACE_MS / 2);
    const h2 = s.join(conn());
    s.say(h2, { t: 'resume', v: 1, room, token: 'wrong' });
    expect(h2.last('refused').reason).toBe('no-room');
    const h3 = s.join(conn());
    s.say(h3, { t: 'resume', v: 1, room, token });
    expect(h3.last('resumed')).toMatchObject({
      you: h.last('hosted').you,
      members: [{ name: 'enc:A' }],
    });
    expect(a.last('host-back')).toBeTruthy();
    // Away again, and not back in time.
    s.rooms.disconnect(h3 as Connection);
    s.advance(HOST_GRACE_MS + 1);
    expect(a.last('ended')).toEqual({ t: 'ended', reason: 'host-left' });
    expect(a.closed).toBe(true);
    expect(s.rooms.stats().rooms).toBe(0);
  });

  it('gives a dropped guest the same grace, and tells the others only if it doesn’t come back', () => {
    const s = setup();
    const { h, room } = s.host();
    const g = s.join(conn());
    s.say(g, { t: 'knock', v: 1, door: 'd1', room, name: 'enc:G', key: 'kg' });
    s.say(h, { t: 'admit', peer: h.last('knocking').peer });
    const { you, token } = g.last('admitted');
    expect(token).toEqual(expect.any(String));
    s.rooms.disconnect(g as Connection);
    s.advance(HOST_GRACE_MS / 2);
    expect(h.last('left')).toBeUndefined();
    const g2 = s.join(conn());
    s.say(g2, { t: 'resume', v: 1, room, token });
    expect(g2.last('resumed')).toMatchObject({ you, members: [{ name: 'enc:Host' }], knocks: [] });
    // Signals reach it on its new connection.
    s.say(h, { t: 'signal', to: you, data: 'hi' });
    expect(g2.last('signal')).toMatchObject({ data: 'hi' });
    // Dropped again, and not back in time.
    s.rooms.disconnect(g2 as Connection);
    s.advance(HOST_GRACE_MS + 1);
    expect(h.last('left')).toEqual({ t: 'left', peer: you, reason: 'gone' });
    const g3 = s.join(conn());
    s.say(g3, { t: 'resume', v: 1, room, token });
    expect(g3.last('refused').reason).toBe('no-room');
  });

  it('lets a resume take over before the old connection’s close arrives', () => {
    const s = setup();
    const { h, room, token } = s.host();
    const g = s.join(conn());
    s.say(g, { t: 'knock', v: 1, door: 'd1', room, name: 'enc:G', key: 'kg' });
    s.say(h, { t: 'admit', peer: h.last('knocking').peer });
    // The host's app reconnects at once; the server hears of the old close only afterwards.
    const h2 = s.join(conn());
    s.say(h2, { t: 'resume', v: 1, room, token });
    expect(h2.last('resumed')).toBeTruthy();
    expect(h.closed).toBe(true);
    s.rooms.disconnect(h as Connection);
    expect(g.last('host-away')).toBeUndefined();
    s.advance(HOST_GRACE_MS + 1);
    expect(g.last('ended')).toBeUndefined();
    expect(s.rooms.stats().rooms).toBe(1);
  });

  it('ends a room when its host leaves, and after twelve hours', () => {
    const s = setup();
    const one = s.host();
    const a = s.join(conn());
    s.say(a, { t: 'knock', v: 1, door: 'd1', room: one.room, name: 'enc:A', key: 'ka' });
    s.say(one.h, { t: 'admit', peer: one.h.last('knocking').peer });
    s.say(one.h, { t: 'leave' });
    expect(a.last('ended').reason).toBe('host-left');
    const two = s.host();
    s.advance(ROOM_LIFETIME_MS);
    expect(two.h.last('ended').reason).toBe('expired');
    expect(s.rooms.stats()).toEqual({ rooms: 0, members: 0, knocking: 0, connections: 0 });
  });

  it('refuses the old link once the host makes a new one, and drops knocks that came with it', () => {
    const s = setup();
    const { h, room } = s.host();
    const waiting = s.join(conn());
    s.say(waiting, { t: 'knock', v: 1, door: 'd1', room, name: 'enc:W', key: 'kw' });
    s.say(h, { t: 'door', door: 'd2' });
    expect(waiting.last('refused').reason).toBe('old-link');
    expect(h.last('knock-gone')).toBeUndefined();
    const old = s.join(conn());
    s.say(old, { t: 'knock', v: 1, door: 'd1', room, name: 'enc:O', key: 'ko' });
    expect(old.last('refused').reason).toBe('old-link');
    const fresh = s.join(conn());
    s.say(fresh, { t: 'knock', v: 1, door: 'd2', room, name: 'enc:F', key: 'kf' });
    expect(fresh.last('waiting')).toBeTruthy();
    // Only the host makes new links.
    s.say(fresh, { t: 'door', door: 'd3' });
    expect(fresh.last('error')).toMatchObject({ code: 'not_host' });
  });

  it('refuses a room id in use', () => {
    const s = setup();
    const { room } = s.host();
    const h2 = s.join(conn());
    s.say(h2, { t: 'host', v: 1, door: 'd1', room, name: 'enc:X', max: 2 });
    expect(h2.last('error')).toMatchObject({ code: 'room_taken' });
  });

  it('hands out relay servers only to members', () => {
    const s = setup();
    const { h, room } = s.host();
    s.say(h, { t: 'relay' });
    expect(h.last('relay')).toMatchObject({ iceServers: [] });
    const g = s.join(conn());
    s.say(g, { t: 'knock', v: 1, door: 'd1', room, name: 'enc:G', key: 'kg' });
    s.say(g, { t: 'relay' });
    expect(g.last('error')).toMatchObject({ code: 'not_member' });
  });
});

describe('the rooms through a sleep (snapshot and restore)', () => {
  /** A connection with an id, as a hibernating transport has. */
  const idConn = (id: string) => Object.assign(conn(), { id });

  it('carries a room through: the door, the members, a knock, a ban, and a member away', () => {
    let now = 1_000_000;
    let n = 0;
    const o = { now: () => now, randomId: () => `id${++n}` };
    const a = new Rooms(o);
    const h = idConn('h');
    const g = idConn('g');
    const x = idConn('x');
    const k = idConn('k');
    const room = 'b'.repeat(18);
    for (const c of [h, g, x, k]) a.connect(c as Connection);
    a.message(h as Connection, { t: 'host', v: 1, door: 'd1', room, name: 'enc:H', max: 4 });
    a.message(g as Connection, { t: 'knock', v: 1, door: 'd1', room, name: 'enc:G', key: 'kg' });
    a.message(h as Connection, { t: 'admit', peer: h.last('knocking').peer });
    a.message(x as Connection, { t: 'knock', v: 1, door: 'd1', room, name: 'enc:X', key: 'kx' });
    a.message(h as Connection, { t: 'admit', peer: h.last('knocking').peer });
    const xId = x.last('admitted').you;
    a.message(h as Connection, { t: 'kick', peer: xId });
    a.message(k as Connection, { t: 'knock', v: 1, door: 'd1', room, name: 'enc:K', key: 'kk' });
    const gToken = g.last('admitted').token;
    a.disconnect(g as Connection); // away, within its grace
    expect(a.nextDeadline()).toBe(now + HOST_GRACE_MS);

    // The sleep: JSON out, and back with new connection objects for the same sockets.
    const snap = JSON.parse(JSON.stringify(a.snapshot()));
    const h2 = idConn('h');
    const k2 = idConn('k');
    const b = Rooms.restore(
      snap,
      new Map([
        ['h', h2 as Connection],
        ['k', k2 as Connection],
      ]),
      o,
    );
    expect(b.stats()).toEqual(a.stats());
    expect(b.snapshot()).toEqual(snap);
    // The host still answers the knock; the kicked key is still refused.
    b.message(h2 as Connection, { t: 'admit', peer: h.last('knocking').peer });
    expect(k2.last('admitted')).toMatchObject({ host: h.last('hosted').you });
    const x2 = idConn('x2');
    b.connect(x2 as Connection);
    b.message(x2 as Connection, { t: 'knock', v: 1, door: 'd1', room, name: 'enc:X', key: 'kx' });
    expect(x2.last('refused')).toEqual({ t: 'refused', reason: 'kicked' });
    // The member away comes back with its token, under its old id.
    const g2 = idConn('g2');
    b.connect(g2 as Connection);
    b.message(g2 as Connection, { t: 'resume', v: 1, room, token: gToken });
    expect(g2.last('resumed')).toMatchObject({ you: g.last('admitted').you });
    // Or, had it not, its grace would have ended it.
    const c = Rooms.restore(snap, new Map([['h', idConn('h') as Connection]]), o);
    now += HOST_GRACE_MS;
    c.sweep();
    expect(c.stats().members).toBe(1);
    expect(c.nextDeadline()).toBe(1_000_000 + ROOM_LIFETIME_MS);
  });

  it('is empty once the room ends and its connections close', () => {
    const r = new Rooms();
    const h = idConn('h');
    r.connect(h as Connection);
    expect(r.empty).toBe(false);
    r.message(h as Connection, {
      t: 'host',
      v: 1,
      door: 'd',
      room: 'c'.repeat(18),
      name: 'n',
      max: 2,
    });
    r.message(h as Connection, { t: 'leave' });
    expect(r.empty).toBe(true);
    expect(r.nextDeadline()).toBeUndefined();
  });
});
