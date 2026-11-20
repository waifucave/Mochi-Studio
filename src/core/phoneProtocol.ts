/**
 * A phone as a face tracker: the messages between the phone's
 * page, the bridge's phone server (bridge/src/phone.ts) and Mochi Studio.
 *
 * The phone's browser tracks the face with MediaPipe and sends only the
 * tracking values (the blendshapes and the head's transformation matrix,
 * the same as Mochi Studio's own camera tracker gives). The camera picture
 * never leaves the phone.
 */

/** The phone tracker's first port; the next ones follow when it is taken. */
export const DEFAULT_PHONE_PORT = 27_890;
export const PHONE_PORT_TRIES = 10;
/** Wrong pairing codes before the code changes. */
export const MAX_PAIR_FAILURES = 5;

/** The phone page → the bridge (over wss, path /track). */
export type PhoneToBridge =
  /** On connecting: an approved phone's token, if it has one. */
  | { type: 'hello'; token?: string; name: string }
  /** The pairing code shown in Mochi Studio, typed on the phone. */
  | { type: 'pair'; code: string; name: string }
  | { type: 'frame'; face: boolean; blendshapes: Record<string, number>; matrix?: number[] };

/** The bridge → the phone page. */
export type BridgeToPhone =
  | { type: 'welcome'; name: string }
  | { type: 'pair_needed' }
  | { type: 'paired'; token: string; name: string }
  | { type: 'pair_failed'; message: string };

export interface PhoneInfo {
  id: string;
  name: string;
  connected: boolean;
  /** Milliseconds since 1970, or null before its first connection. */
  lastSeen: number | null;
}

/** Mochi Studio → the bridge. */
export type HostToBridgePhone =
  { type: 'phone_options'; on: boolean } | { type: 'phone_revoke'; phoneId: string };

/** The bridge → Mochi Studio. */
export type BridgeToHostPhone =
  | {
      type: 'phone_state';
      on: boolean;
      /** The port in use, or null when off. */
      port: number | null;
      /** The addresses to open on the phone (https, this computer's local-network addresses). */
      urls: string[];
      /** The pairing code to type on the phone, while the server is on. */
      code: string | null;
      /** The certificate's SHA-256 fingerprint, as the phone's browser shows it. */
      fingerprint: string | null;
      /** Why the server could not start. */
      problem?: string;
      phones: PhoneInfo[];
    }
  | {
      type: 'phone_frame';
      phoneId: string;
      face: boolean;
      blendshapes: Record<string, number>;
      matrix?: number[];
    };

const NAME = /^[A-Za-z0-9_]{1,40}$/;

/** A phone's frame, checked: at most 64 named blendshapes from 0 to 1, a 4 × 4 matrix. */
export function parsePhoneFrame(
  m: Record<string, unknown>,
): { face: boolean; blendshapes: Record<string, number>; matrix?: number[] } | undefined {
  if (typeof m.face !== 'boolean') return undefined;
  const b = m.blendshapes;
  if (typeof b !== 'object' || b === null || Array.isArray(b)) return undefined;
  const entries = Object.entries(b as Record<string, unknown>);
  if (entries.length > 64) return undefined;
  const blendshapes: Record<string, number> = {};
  for (const [k, v] of entries) {
    if (!NAME.test(k) || typeof v !== 'number' || !Number.isFinite(v)) return undefined;
    blendshapes[k] = Math.max(0, Math.min(1, v));
  }
  let matrix: number[] | undefined;
  if (m.matrix !== undefined) {
    if (
      !Array.isArray(m.matrix) ||
      m.matrix.length !== 16 ||
      !m.matrix.every((v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e4)
    )
      return undefined;
    matrix = m.matrix as number[];
  }
  return { face: m.face, blendshapes, ...(matrix ? { matrix } : {}) };
}

/** A short name for the phone from its browser (shown in Mochi Studio's list). */
export function phoneName(userAgent: string): string {
  if (/iPad/.test(userAgent)) return 'iPad';
  if (/iPhone/.test(userAgent)) return 'iPhone';
  if (/Android/.test(userAgent)) return 'Android phone';
  return 'Phone';
}
