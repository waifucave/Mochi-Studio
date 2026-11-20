/**
 * The signaling server's rooms (docs/collaboration.md, section 4), without
 * a transport: the Node server (collab/server.ts) and the Worker
 * (collab/worker/) feed it connections and messages. Time and ids are
 * given, so tests drive both. The Worker's rooms sleep between messages
 * (WebSocket hibernation), so the state can be written out (`snapshot`)
 * and read back with new connections (`Rooms.restore`).
 *
 * - **The door:** a knock goes to the host, who lets in or declines; a
 *   locked or full room refuses; a kicked app's key is refused for the
 *   rest of the room's life.
 * - **The host:** if its connection drops, the room waits HOST_GRACE_MS for
 *   it (`resume` with its token), then ends. A host who leaves ends it.
 * - **Expiry:** a room ends ROOM_LIFETIME_MS after it opens.
 * - **Signals** pass only between members of the same room.
 * - **Nothing is logged:** `stats()` gives counts, and that is all the
 *   server keeps about anyone.
 */
import {
  COLLAB_VERSION,
  HOST_GRACE_MS,
  ROOM_LIFETIME_MS,
  type ClientMessage,
  type IceServer,
  type Member,
  type RefusalReason,
  type ServerMessage,
} from './protocol';

/** One app's connection, as the transport gives it. */
export interface Connection {
  send(m: ServerMessage): void;
  /** Closes the connection (after the last message sent). */
  close(): void;
  /** The transport's id for it, for snapshots (a transport that never sleeps needs none). */
  id?: string;
}

export interface RoomsOptions {
  now?: () => number;
  /** Random ids: rooms, peers, tokens. */
  randomId?: (bytes: number) => string;
  /**
   * Relay servers with short-lived credentials for a member; none without a
   * TURN server. A provider's API answers later, so it may return a promise.
   */
  relay?: (
    peer: string,
  ) =>
    | { iceServers: IceServer[]; expires: number }
    | Promise<{ iceServers: IceServer[]; expires: number }>;
}

/** A peer in a snapshot: its connection by id (absent: none, or not one this transport knows). */
interface PeerSnapshot {
  id: string;
  conn?: string;
  name: string;
  key?: string;
  role: Peer['role'];
  token?: string;
  awayUntil?: number;
}

/** Everything the rooms hold, as JSON. */
export interface RoomsSnapshot {
  rooms: Array<
    Omit<Room, 'members' | 'knocks' | 'banned'> & {
      members: PeerSnapshot[];
      knocks: PeerSnapshot[];
      banned: string[];
    }
  >;
  /** Connected peers in no room yet. */
  loose: PeerSnapshot[];
}

/** A connection that is gone: a member away within its grace. */
const GONE: Connection = { send: () => {}, close: () => {} };

interface Peer {
  id: string;
  conn: Connection;
  name: string;
  /** The app's key for this room (knocks only). */
  key?: string;
  room?: Room;
  /** Member (let in), knocking, or the host. */
  role: 'host' | 'member' | 'knocking';
  /** A member's token for coming back after a dropped connection. */
  token?: string;
  /** While its connection is down: when it is given up. */
  awayUntil?: number;
}

interface Room {
  id: string;
  hostId: string;
  hostName: string;
  token: string;
  max: number;
  locked: boolean;
  opened: number;
  expires: number;
  members: Map<string, Peer>;
  knocks: Map<string, Peer>;
  banned: Set<string>;
  /** The current invitation's door token: knocks with another are refused (an old link). */
  door: string;
  /** While the host is away: when the room ends. */
  hostAwayUntil?: number;
}

function defaultRandomId(bytes: number): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

export class Rooms {
  private rooms = new Map<string, Room>();
  private peers = new Map<Connection, Peer>();
  private now: () => number;
  private randomId: (bytes: number) => string;
  private relay: RoomsOptions['relay'];

  constructor(o: RoomsOptions = {}) {
    this.now = o.now ?? (() => Date.now());
    this.randomId = o.randomId ?? defaultRandomId;
    this.relay = o.relay;
  }

  /** Counts only: what the server may log. */
  stats(): { rooms: number; members: number; knocking: number; connections: number } {
    let members = 0;
    let knocking = 0;
    for (const r of this.rooms.values()) {
      members += r.members.size;
      knocking += r.knocks.size;
    }
    return { rooms: this.rooms.size, members, knocking, connections: this.peers.size };
  }

  connect(conn: Connection): void {
    this.peers.set(conn, { id: this.randomId(8), conn, name: '', role: 'knocking' });
  }

  /**
   * A message from a connection. It returns a promise only when an answer
   * comes later (relay credentials from a provider's API).
   */
  message(conn: Connection, m: ClientMessage): void | Promise<void> {
    const p = this.peers.get(conn);
    if (!p) return;
    const err = (code: string, message: string) => conn.send({ t: 'error', code, message });
    switch (m.t) {
      case 'host': {
        if (m.v !== COLLAB_VERSION) return this.refuse(p, 'version');
        if (p.room) return err('in_room', 'This connection is in a room already.');
        if (this.rooms.has(m.room)) return err('room_taken', 'That room id is in use.');
        const now = this.now();
        const room: Room = {
          id: m.room,
          hostId: p.id,
          hostName: m.name,
          token: this.randomId(16),
          max: m.max,
          locked: false,
          opened: now,
          expires: now + ROOM_LIFETIME_MS,
          members: new Map([[p.id, p]]),
          knocks: new Map(),
          banned: new Set(),
          door: m.door,
        };
        p.role = 'host';
        p.name = m.name;
        p.room = room;
        p.token = room.token;
        this.rooms.set(room.id, room);
        conn.send({
          t: 'hosted',
          room: room.id,
          you: p.id,
          token: room.token,
          expires: room.expires,
        });
        return;
      }
      case 'resume': {
        // A host or a member whose connection dropped, back within the grace, under its old id.
        const room = this.rooms.get(m.room);
        const back = room && [...room.members.values()].find((x) => x.token === m.token);
        if (!room || !back) return this.refuse(p, 'no-room');
        // Its old connection may not have closed here yet (the app came back at once): this one
        // takes over, and the old one's close changes nothing.
        this.peers.delete(conn);
        if (back.conn !== conn) {
          this.peers.delete(back.conn);
          back.conn.close();
        }
        back.conn = conn;
        back.awayUntil = undefined;
        this.peers.set(conn, back);
        const isHost = back.id === room.hostId;
        if (isHost) room.hostAwayUntil = undefined;
        conn.send({
          t: 'resumed',
          room: room.id,
          you: back.id,
          members: this.memberList(room, back.id),
          knocks: isHost ? [...room.knocks.values()].map((k) => ({ id: k.id, name: k.name })) : [],
          locked: room.locked,
        });
        if (isHost) this.broadcast(room, { t: 'host-back' }, back.id);
        return;
      }
      case 'knock': {
        if (m.v !== COLLAB_VERSION) return this.refuse(p, 'version');
        const room = this.rooms.get(m.room);
        if (!room) return this.refuse(p, 'no-room');
        if (p.room) return err('in_room', 'This connection is in a room already.');
        if (room.banned.has(m.key)) return this.refuse(p, 'kicked');
        if (m.door !== room.door) return this.refuse(p, 'old-link');
        if (room.locked) return this.refuse(p, 'locked');
        if (room.members.size >= room.max) return this.refuse(p, 'full');
        p.name = m.name;
        p.key = m.key;
        p.room = room;
        p.role = 'knocking';
        room.knocks.set(p.id, p);
        conn.send({ t: 'waiting', you: p.id });
        this.host(room)?.conn.send({ t: 'knocking', peer: p.id, name: p.name });
        return;
      }
      case 'admit':
      case 'decline': {
        const room = this.hostRoom(p);
        if (!room) return err('not_host', 'Only the host can answer a knock.');
        const k = room.knocks.get(m.peer);
        if (!k) return err('no_knock', 'That knock has gone.');
        room.knocks.delete(k.id);
        if (m.t === 'decline') {
          k.room = undefined;
          return this.refuse(k, 'declined');
        }
        if (room.members.size >= room.max) {
          k.room = undefined;
          return this.refuse(k, 'full');
        }
        k.role = 'member';
        k.token = this.randomId(16);
        k.conn.send({
          t: 'admitted',
          you: k.id,
          host: room.hostId,
          members: this.memberList(room),
          expires: room.expires,
          token: k.token,
        });
        this.broadcast(room, { t: 'joined', peer: k.id, name: k.name });
        room.members.set(k.id, k);
        return;
      }
      case 'kick': {
        const room = this.hostRoom(p);
        if (!room) return err('not_host', 'Only the host can remove someone.');
        if (m.peer === p.id) return err('self', 'The host leaves instead.');
        const k = room.members.get(m.peer) ?? room.knocks.get(m.peer);
        if (!k) return err('no_member', 'No such participant.');
        if (k.key) room.banned.add(k.key);
        const wasMember = room.members.delete(k.id);
        room.knocks.delete(k.id);
        k.room = undefined;
        k.conn.send({ t: 'kicked' });
        k.conn.close();
        this.peers.delete(k.conn);
        if (wasMember) this.broadcast(room, { t: 'left', peer: k.id, reason: 'kicked' });
        return;
      }
      case 'door': {
        const room = this.hostRoom(p);
        if (!room) return err('not_host', 'Only the host can make a new invitation.');
        room.door = m.door;
        // Knocks that came with the old link go too.
        for (const k of [...room.knocks.values()]) {
          room.knocks.delete(k.id);
          k.room = undefined;
          this.refuse(k, 'old-link');
        }
        return;
      }
      case 'lock': {
        const room = this.hostRoom(p);
        if (!room) return err('not_host', 'Only the host can lock the session.');
        room.locked = m.locked;
        this.broadcast(room, { t: 'locked', locked: m.locked });
        return;
      }
      case 'signal': {
        const room = p.room;
        if (!room || !room.members.has(p.id)) return err('not_member', 'Join the room first.');
        const to = room.members.get(m.to);
        if (!to) return err('no_member', 'No such participant.');
        to.conn.send({ t: 'signal', from: p.id, data: m.data });
        return;
      }
      case 'relay': {
        if (!p.room || !p.room.members.has(p.id)) return err('not_member', 'Join the room first.');
        const r = this.relay?.(p.id) ?? { iceServers: [], expires: this.now() + 60 * 60 * 1000 };
        if (r instanceof Promise) return r.then((x) => conn.send({ t: 'relay', ...x }));
        conn.send({ t: 'relay', ...r });
        return;
      }
      case 'leave':
        this.leave(p, 'left');
        conn.close();
        this.peers.delete(conn);
        return;
    }
  }

  /** The transport's connection closed. */
  disconnect(conn: Connection): void {
    const p = this.peers.get(conn);
    if (!p) return;
    this.peers.delete(conn);
    // A connection replaced by a resume: nothing to do.
    if (p.conn !== conn) return;
    const room = p.room;
    if (room && room.members.get(p.id) === p && p.token && this.rooms.has(room.id)) {
      // A member (the host too) gets a grace to come back; its WebRTC links may well stay up.
      p.awayUntil = this.now() + HOST_GRACE_MS;
      if (p.role === 'host') {
        room.hostAwayUntil = p.awayUntil;
        this.broadcast(room, { t: 'host-away', until: room.hostAwayUntil }, p.id);
      }
      return;
    }
    this.leave(p, 'gone');
  }

  /** When `sweep` next has something to do (a room's expiry, a grace's end), if ever. */
  nextDeadline(): number | undefined {
    let next: number | undefined;
    const at = (t: number | undefined) => {
      if (t !== undefined && (next === undefined || t < next)) next = t;
    };
    for (const room of this.rooms.values()) {
      at(room.expires);
      at(room.hostAwayUntil);
      for (const m of room.members.values()) at(m.awayUntil);
    }
    return next;
  }

  /** Whether anything is left: rooms, or connections waiting to host or knock. */
  get empty(): boolean {
    return !this.rooms.size && !this.peers.size;
  }

  /** The state as JSON, connections by their `id`. */
  snapshot(): RoomsSnapshot {
    const peer = (p: Peer): PeerSnapshot => ({
      id: p.id,
      ...(p.conn.id && this.peers.get(p.conn) === p ? { conn: p.conn.id } : {}),
      name: p.name,
      ...(p.key !== undefined ? { key: p.key } : {}),
      role: p.role,
      ...(p.token !== undefined ? { token: p.token } : {}),
      ...(p.awayUntil !== undefined ? { awayUntil: p.awayUntil } : {}),
    });
    const inRooms = new Set<Peer>();
    const rooms = [...this.rooms.values()].map((r) => {
      for (const p of [...r.members.values(), ...r.knocks.values()]) inRooms.add(p);
      const { members, knocks, banned, ...rest } = r;
      return {
        ...rest,
        members: [...members.values()].map(peer),
        knocks: [...knocks.values()].map(peer),
        banned: [...banned],
      };
    });
    const loose = [...this.peers.values()].filter((p) => !inRooms.has(p)).map(peer);
    return { rooms, loose };
  }

  /**
   * Rooms from a snapshot, with the transport's connections by id. A peer
   * whose connection is not among them is away (its grace runs on).
   */
  static restore(
    s: RoomsSnapshot,
    connections: ReadonlyMap<string, Connection>,
    o: RoomsOptions = {},
  ): Rooms {
    const rooms = new Rooms(o);
    const peer = (x: PeerSnapshot, room?: Room): Peer => {
      const conn = (x.conn && connections.get(x.conn)) || GONE;
      const p: Peer = {
        id: x.id,
        conn,
        name: x.name,
        role: x.role,
        ...(x.key !== undefined ? { key: x.key } : {}),
        ...(x.token !== undefined ? { token: x.token } : {}),
        ...(x.awayUntil !== undefined ? { awayUntil: x.awayUntil } : {}),
        ...(room ? { room } : {}),
      };
      if (conn !== GONE) rooms.peers.set(conn, p);
      return p;
    };
    for (const r of s.rooms) {
      const room: Room = {
        ...r,
        members: new Map(),
        knocks: new Map(),
        banned: new Set(r.banned),
      };
      for (const m of r.members) room.members.set(m.id, peer(m, room));
      for (const k of r.knocks) room.knocks.set(k.id, peer(k, room));
      rooms.rooms.set(room.id, room);
    }
    for (const l of s.loose) peer(l);
    return rooms;
  }

  /** Whether the transport's connection is one these rooms know. */
  knows(conn: Connection): boolean {
    return this.peers.has(conn);
  }

  /** Ends expired rooms and those whose host did not come back. Call every few seconds. */
  sweep(): void {
    const now = this.now();
    for (const room of [...this.rooms.values()]) {
      if (now >= room.expires) this.end(room, 'expired');
      else if (room.hostAwayUntil !== undefined && now >= room.hostAwayUntil)
        this.end(room, 'host-left');
      else
        for (const m of [...room.members.values()])
          if (m.awayUntil !== undefined && now >= m.awayUntil) this.leave(m, 'gone');
    }
  }

  private leave(p: Peer, reason: 'left' | 'gone'): void {
    const room = p.room;
    if (!room) return;
    p.room = undefined;
    if (p.role === 'host') return this.end(room, 'host-left', p.id);
    if (room.knocks.delete(p.id)) {
      this.host(room)?.conn.send({ t: 'knock-gone', peer: p.id });
      return;
    }
    if (room.members.delete(p.id)) this.broadcast(room, { t: 'left', peer: p.id, reason });
  }

  private end(room: Room, reason: 'host-left' | 'expired', except?: string): void {
    this.rooms.delete(room.id);
    for (const q of [...room.members.values(), ...room.knocks.values()]) {
      q.room = undefined;
      if (q.id === except) continue;
      q.conn.send({ t: 'ended', reason });
      q.conn.close();
      this.peers.delete(q.conn);
    }
  }

  private refuse(p: Peer, reason: RefusalReason): void {
    p.conn.send({ t: 'refused', reason });
    p.conn.close();
    this.peers.delete(p.conn);
  }

  private host(room: Room): Peer | undefined {
    return room.members.get(room.hostId);
  }

  private hostRoom(p: Peer): Room | undefined {
    return p.role === 'host' && p.room && p.room.hostId === p.id ? p.room : undefined;
  }

  private memberList(room: Room, except?: string): Member[] {
    return [...room.members.values()]
      .filter((m) => m.id !== except)
      .map((m) => ({ id: m.id, name: m.name }));
  }

  private broadcast(room: Room, m: ServerMessage, except?: string): void {
    for (const q of room.members.values()) if (q.id !== except) q.conn.send(m);
  }
}
