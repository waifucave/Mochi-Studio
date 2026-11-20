/**
 * The signaling server's limits, the same for the Node server and the
 * Worker (docs/collaboration.md, "Hosting a server"). They keep one address
 * from draining a server, a free plan's included requests above all, while
 * leaving room for a household or a small office behind one address.
 *
 * Pure and with time given, so tests drive them and both servers keep the
 * same numbers.
 */

export const LIMITS = {
  /** The largest WebSocket message, in bytes (a signal is at most MAX_SIGNAL_LENGTH). */
  messageBytes: 64 * 1024,
  /** Messages a second on one connection (ICE candidates come in bursts). */
  messagesPerSecond: 200,
  /** Open connections from one address. */
  connectionsPerAddress: 20,
  /** Rooms one address takes part in at once (hosting or joining). */
  roomsPerAddress: 6,
  /** New connections from one address in a minute (reconnects included). */
  newConnectionsPerMinute: 60,
} as const;

export type LimitRefusal = 'too-many-connections' | 'too-many-rooms' | 'too-fast';

/** The limits per address an operator may change (the rest are the protocol's). */
export interface AddressLimitSettings {
  connectionsPerAddress: number;
  roomsPerAddress: number;
  newConnectionsPerMinute: number;
}

/** Settings from strings (the Worker's variables, the CLI's environment); bad ones keep the default. */
export function addressLimitSettings(
  v: Partial<Record<keyof AddressLimitSettings, string | number | undefined>>,
): AddressLimitSettings {
  const n = (x: string | number | undefined, d: number) => {
    const k = Number(x);
    return x !== undefined && x !== '' && Number.isInteger(k) && k > 0 ? k : d;
  };
  return {
    connectionsPerAddress: n(v.connectionsPerAddress, LIMITS.connectionsPerAddress),
    roomsPerAddress: n(v.roomsPerAddress, LIMITS.roomsPerAddress),
    newConnectionsPerMinute: n(v.newConnectionsPerMinute, LIMITS.newConnectionsPerMinute),
  };
}

/** Counts messages in one-second windows. */
export class RateWindow {
  private start = 0;
  private count = 0;
  private readonly perSecond: number;
  constructor(perSecond: number = LIMITS.messagesPerSecond) {
    this.perSecond = perSecond;
  }

  /** Whether a message at `now` (ms) is within the rate. */
  allow(now: number): boolean {
    if (now - this.start >= 1000) {
      this.start = now;
      this.count = 0;
    }
    return ++this.count <= this.perSecond;
  }
}

export interface AddressLimitsSnapshot {
  open: Array<[string, string]>;
  recent: number[];
}

/**
 * One address's connections: which are open, to which rooms, and how many
 * came in the last minute. The Node server keeps one per address; the
 * Worker keeps each in a Durable Object of its own, named after a hash of
 * the address (the address itself is never stored).
 */
export class AddressLimits {
  /** Connection id → room id. */
  private open = new Map<string, string>();
  /** When the connections of the last minute came. */
  private recent: number[] = [];
  private limits: AddressLimitSettings;

  constructor(limits: AddressLimitSettings = LIMITS) {
    this.limits = limits;
  }

  /** Takes a place for a new connection to `room`, or says why not. */
  admit(conn: string, room: string, now: number): LimitRefusal | undefined {
    this.recent = this.recent.filter((t) => now - t < 60_000);
    if (this.recent.length >= this.limits.newConnectionsPerMinute) return 'too-fast';
    if (this.open.size >= this.limits.connectionsPerAddress) return 'too-many-connections';
    const rooms = new Set(this.open.values());
    if (!rooms.has(room) && rooms.size >= this.limits.roomsPerAddress) return 'too-many-rooms';
    this.recent.push(now);
    this.open.set(conn, room);
    return undefined;
  }

  /** The connection closed. */
  release(conn: string): void {
    this.open.delete(conn);
  }

  /** Nothing open and nothing recent: the entry can go. */
  idle(now: number): boolean {
    return !this.open.size && this.recent.every((t) => now - t >= 60_000);
  }

  snapshot(): AddressLimitsSnapshot {
    return { open: [...this.open.entries()], recent: [...this.recent] };
  }

  static restore(
    s: AddressLimitsSnapshot | undefined,
    limits: AddressLimitSettings = LIMITS,
  ): AddressLimits {
    const a = new AddressLimits(limits);
    if (s) {
      a.open = new Map(s.open);
      a.recent = [...s.recent];
    }
    return a;
  }
}

/** Every address's limits, for a server that sees all of them (the Node one). */
export class LimitsByAddress {
  private byAddress = new Map<string, AddressLimits>();
  private limits: AddressLimitSettings;

  constructor(limits: AddressLimitSettings = LIMITS) {
    this.limits = limits;
  }

  admit(address: string, conn: string, room: string, now: number): LimitRefusal | undefined {
    let a = this.byAddress.get(address);
    if (!a) this.byAddress.set(address, (a = new AddressLimits(this.limits)));
    return a.admit(conn, room, now);
  }

  release(address: string, conn: string, now: number): void {
    const a = this.byAddress.get(address);
    if (!a) return;
    a.release(conn);
    if (a.idle(now)) this.byAddress.delete(address);
  }
}
