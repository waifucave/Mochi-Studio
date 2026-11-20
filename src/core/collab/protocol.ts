/**
 * Collaboration (docs/collaboration.md): the messages between
 * the apps and the signaling server, over a WebSocket, as JSON.
 *
 * The server introduces apps to each other and keeps the room's door. It
 * never sees the invitation's secret: nicknames arrive encrypted with the
 * session key (src/core/collab/crypto.ts), and everything else the apps
 * exchange goes over WebRTC once they are connected.
 */

export const COLLAB_VERSION = 1;
export const MAX_PEOPLE = 6;
export const MIN_PEOPLE = 2;
/** A room ends 12 hours after it opens. */
export const ROOM_LIFETIME_MS = 12 * 60 * 60 * 1000;
/** A host whose connection drops has this long to come back. */
export const HOST_GRACE_MS = 60_000;
/** The longest encrypted nickname the server passes on. */
export const MAX_NAME_LENGTH = 400;
/** The largest signal (an offer, an answer or an ICE candidate). */
export const MAX_SIGNAL_LENGTH = 32_000;

/** From an app to the server. */
export type ClientMessage =
  /**
   * Opens a room; the sender is its host. The app picks the room's id (random,
   * hex), so it can encrypt its name with the room's key from the start.
   */
  | { t: 'host'; v: number; room: string; name: string; max: number; door: string }
  /**
   * The host makes a new invitation: knocks must bring this door
   * token from now on, so the old link is refused. It is not the secret.
   */
  | { t: 'door'; door: string }
  /** The host again, after its connection dropped (within the grace). */
  | { t: 'resume'; v: number; room: string; token: string }
  /** Asks to join. `key` is this app's random key for the room (a kicked key is refused). */
  | { t: 'knock'; v: number; room: string; name: string; key: string; door: string }
  | { t: 'admit'; peer: string }
  | { t: 'decline'; peer: string }
  | { t: 'kick'; peer: string }
  | { t: 'lock'; locked: boolean }
  /** WebRTC offers, answers and ICE candidates, to one member. */
  | { t: 'signal'; to: string; data: unknown }
  /** Asks for relay (TURN) servers and short-lived credentials. */
  | { t: 'relay' }
  | { t: 'leave' };

export interface Member {
  id: string;
  /** Encrypted with the session key. */
  name: string;
}

export type RefusalReason =
  | 'locked'
  | 'full'
  | 'no-room'
  | 'kicked'
  | 'declined'
  | 'version'
  | 'old-link'
  /** The server's limits for one address (src/core/collab/limits.ts). */
  | 'busy';
export type EndReason = 'host-left' | 'expired';
export type LeaveReason = 'left' | 'kicked' | 'gone';

/** From the server to an app. */
export type ServerMessage =
  | { t: 'hosted'; room: string; you: string; token: string; expires: number }
  | {
      t: 'resumed';
      room: string;
      you: string;
      members: Member[];
      knocks: Member[];
      locked: boolean;
    }
  /** To a knocker: the host has been asked. */
  | { t: 'waiting'; you: string }
  /** To the host: someone asks to join. */
  | { t: 'knocking'; peer: string; name: string }
  /** To the host: a knocker went away before an answer. */
  | { t: 'knock-gone'; peer: string }
  | {
      t: 'admitted';
      you: string;
      host: string;
      members: Member[];
      expires: number;
      /** For coming back after a dropped connection (within the grace). */
      token: string;
    }
  | { t: 'refused'; reason: RefusalReason }
  /** To the members: someone was let in. */
  | { t: 'joined'; peer: string; name: string }
  | { t: 'left'; peer: string; reason: LeaveReason }
  /** To someone the host removed. */
  | { t: 'kicked' }
  | { t: 'host-away'; until: number }
  | { t: 'host-back' }
  | { t: 'locked'; locked: boolean }
  | { t: 'signal'; from: string; data: unknown }
  | { t: 'relay'; iceServers: IceServer[]; expires: number }
  | { t: 'ended'; reason: EndReason }
  | { t: 'error'; code: string; message: string };

export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

/** Room ids: 16 to 64 hex digits, picked by the host's app. */
export const ROOM_ID = /^[0-9a-f]{16,64}$/;

/**
 * The address an app connects to for a room: the server's `/ws` with the
 * room as `?room=`. A server that keeps each room apart (the Worker, one
 * Durable Object per room) routes by it; the Node server reads it for its
 * limits. The messages name the room as before.
 */
export function signalingUrl(server: string, room: string): string {
  const u = new URL(server);
  u.searchParams.set('room', room);
  return u.href;
}

const str = (v: unknown, max = 200): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= max;

/** Checks a message from an app; undefined when it is not one. */
export function parseClientMessage(raw: unknown): ClientMessage | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const m = raw as Record<string, unknown>;
  switch (m.t) {
    case 'host':
      return typeof m.v === 'number' &&
        typeof m.room === 'string' &&
        ROOM_ID.test(m.room) &&
        str(m.name, MAX_NAME_LENGTH) &&
        str(m.door, 64) &&
        typeof m.max === 'number' &&
        Number.isInteger(m.max)
        ? {
            t: 'host',
            v: m.v,
            room: m.room,
            name: m.name,
            door: m.door,
            max: Math.max(MIN_PEOPLE, Math.min(MAX_PEOPLE, m.max)),
          }
        : undefined;
    case 'resume':
      return typeof m.v === 'number' && str(m.room, 64) && str(m.token, 128)
        ? { t: 'resume', v: m.v, room: m.room, token: m.token }
        : undefined;
    case 'knock':
      return typeof m.v === 'number' &&
        str(m.room, 64) &&
        str(m.name, MAX_NAME_LENGTH) &&
        str(m.key, 128) &&
        str(m.door, 64)
        ? { t: 'knock', v: m.v, room: m.room, name: m.name, key: m.key, door: m.door }
        : undefined;
    case 'admit':
    case 'decline':
    case 'kick':
      return str(m.peer, 64) ? { t: m.t, peer: m.peer } : undefined;
    case 'lock':
      return typeof m.locked === 'boolean' ? { t: 'lock', locked: m.locked } : undefined;
    case 'door':
      return str(m.door, 64) ? { t: 'door', door: m.door } : undefined;
    case 'signal': {
      if (!str(m.to, 64)) return undefined;
      const size = JSON.stringify(m.data ?? null).length;
      return size <= MAX_SIGNAL_LENGTH ? { t: 'signal', to: m.to, data: m.data } : undefined;
    }
    case 'relay':
    case 'leave':
      return { t: m.t };
    default:
      return undefined;
  }
}
