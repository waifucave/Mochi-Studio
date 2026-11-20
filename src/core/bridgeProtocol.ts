/**
 * The Mochi Studio bridge protocol, version 1: the messages between the
 * local bridge (`mochi-studio-bridge`, a Node process) and
 *
 * - the **host** (the Mochi Studio page), on `ws://127.0.0.1:<port>/host`,
 *   which runs the commands;
 * - **clients** (programs and agents), on `ws://127.0.0.1:<port>/api`;
 * - **views** (output views, such as an OBS browser source), on
 *   `ws://127.0.0.1:<port>/view`, with files over HTTP from `/files/…`.
 *
 * Every message is one JSON object in a text frame, with a `type`.
 * docs/agent-api.md ("The bridge protocol") describes it for other apps.
 * This file holds only types and constants, so the bridge (run by Node
 * directly) and the page share it.
 */

export const PROTOCOL_VERSION = 1;
export const DEFAULT_PORT = 47830;
/** The largest message, in bytes (screenshots and audio travel as base64). */
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

export type ScopeName = 'read' | 'control' | 'screenshot';

export interface ErrorInfo {
  /** Stable code: unauthorized, forbidden, invalid_message, invalid_arguments, unknown_command,
   * studio_not_connected, rate_limited, timeout, no_model, failed, … */
  code: string;
  /** What went wrong and what to do about it. */
  message: string;
}

export interface CommandInfoWire {
  name: string;
  summary: string;
  details?: string;
  scope: ScopeName;
  undoable: boolean;
  readOnly: boolean;
  inputSchema: Record<string, unknown>;
}

export interface ClientInfo {
  /** Connection id. */
  id: string;
  /** The token's name. */
  name: string;
  scopes: ScopeName[];
  connectedAt: number;
}

export interface TokenInfo {
  id: string;
  name: string;
  scopes: ScopeName[];
  created: number;
  lastUsed: number | null;
}

// --- host (the page) <-> bridge ---------------------------------------------

export type HostToBridge =
  | { type: 'host_hello'; protocol: number; app: string; version: string; hostToken?: string }
  | { type: 'pair'; code: string }
  | { type: 'catalog'; commands: CommandInfoWire[]; events: string[] }
  | { type: 'result'; id: string; ok: true; result: unknown }
  | { type: 'result'; id: string; ok: false; error: ErrorInfo }
  | { type: 'event'; name: string; data: unknown }
  | { type: 'token_create'; requestId: string; name: string; scopes: ScopeName[] }
  | { type: 'token_list'; requestId: string }
  | { type: 'token_revoke'; requestId: string; id: string }
  /** Whether agents may connect (agent access on or off in the page). */
  | { type: 'host_options'; agents: boolean }
  /** A message for every output view (an encoded SyncMessage, see encodeSync). */
  | { type: 'sync'; message: unknown }
  /** The key output views use; `renew` makes a new one (the old one stops working). */
  | { type: 'view_key'; requestId: string; renew: boolean }
  /** A file request could not be served. File contents travel as binary frames (encodeFileChunk). */
  | { type: 'file_error'; id: string; message: string }
  /**
   * Desktop app: the model `owner` (its key) is the folder `folderId` on disk,
   * which the app registered with the bridge; views read it from there.
   */
  | {
      type: 'disk_source';
      scope: 'model' | 'item';
      owner: string;
      folderId: string;
      /** The manifest's folder inside it ('' at the top): file paths are relative to it. */
      prefix: string;
    };

export type BridgeToHost =
  | { type: 'pair_required'; message: string }
  | { type: 'paired'; hostToken: string }
  | { type: 'pair_failed'; message: string }
  | { type: 'host_welcome'; protocol: number; bridge: { version: string; port: number } }
  | {
      type: 'command';
      id: string;
      client: { id: string; name: string; scopes: ScopeName[] };
      name: string;
      args: unknown;
    }
  | { type: 'clients'; clients: ClientInfo[] }
  | { type: 'token_created'; requestId: string; token: string; info: TokenInfo }
  | { type: 'tokens'; requestId: string; tokens: TokenInfo[] }
  | { type: 'token_revoked'; requestId: string; id: string }
  | { type: 'error'; error: ErrorInfo; requestId?: string }
  /** A message from an output view (hello, bye), with its viewId. */
  | { type: 'sync'; message: unknown }
  | { type: 'views'; count: number }
  | { type: 'view_key'; requestId: string; key: string | null }
  /** A view wants a file: of the model (`owner` = model key) or an item (`owner` = item id). */
  | { type: 'file_request'; id: string; scope: 'model' | 'item'; owner: string; path: string };

// --- view <-> bridge ---------------------------------------------------------

export type ViewToBridge =
  | { type: 'view_hello'; protocol: number; key: string; viewId: string }
  | { type: 'sync'; message: unknown };

/**
 * The host app (`app` from its host_hello: "Mochi Studio", or another app on
 * this protocol), next to `studio`, which version-1 clients read.
 */
export interface HostInfo {
  connected: boolean;
  app: string | null;
}

export type BridgeToView =
  | { type: 'view_welcome'; protocol: number; studio: { connected: boolean }; host: HostInfo }
  | { type: 'sync'; message: unknown }
  | { type: 'studio'; connected: boolean }
  | ({ type: 'host' } & HostInfo)
  | { type: 'error'; error: ErrorInfo };

/**
 * A chunk of a file, host -> bridge, as one binary frame: a 4-byte
 * big-endian header length, the header as UTF-8 JSON, then the bytes.
 * The first chunk's header has the file's `size`; the last has `done`.
 */
export interface FileChunkHeader {
  id: string;
  size?: number;
  done: boolean;
}
export const FILE_CHUNK_BYTES = 1024 * 1024;

export function encodeFileChunk(header: FileChunkHeader, bytes: Uint8Array): Uint8Array {
  const h = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(4 + h.length + bytes.length);
  new DataView(out.buffer).setUint32(0, h.length);
  out.set(h, 4);
  out.set(bytes, 4 + h.length);
  return out;
}

export function decodeFileChunk(
  frame: Uint8Array,
): { header: FileChunkHeader; bytes: Uint8Array } | undefined {
  if (frame.length < 4) return undefined;
  const n = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0);
  if (4 + n > frame.length) return undefined;
  try {
    const header = JSON.parse(
      new TextDecoder().decode(frame.subarray(4, 4 + n)),
    ) as FileChunkHeader;
    if (typeof header.id !== 'string') return undefined;
    return { header, bytes: frame.subarray(4 + n) };
  } catch {
    return undefined;
  }
}

/** JSON with byte arrays as `{ "$bytes": "<base64>" }`, for SyncMessages over the bridge. */
export function encodeSync(message: unknown): unknown {
  return JSON.parse(
    JSON.stringify(message, (_k, v: unknown) =>
      v instanceof Uint8Array ? { $bytes: toBase64(v) } : v,
    ),
  );
}
export function decodeSync(message: unknown): unknown {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (typeof o.$bytes === 'string' && Object.keys(o).length === 1) return fromBase64(o.$bytes);
      return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  return walk(message);
}
function toBase64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// --- client <-> bridge -------------------------------------------------------

export type ClientToBridge =
  | { type: 'hello'; protocol: number; token: string; client?: { name?: string } }
  | { type: 'command'; id: string; name: string; args?: unknown }
  | { type: 'subscribe'; events: string[] }
  | { type: 'unsubscribe'; events: string[] };

export type BridgeToClient =
  | {
      type: 'welcome';
      protocol: number;
      name: string;
      scopes: ScopeName[];
      studio: { connected: boolean };
      host: HostInfo;
      commands: CommandInfoWire[];
      events: string[];
    }
  | { type: 'result'; id: string; ok: true; result: unknown }
  | { type: 'result'; id: string; ok: false; error: ErrorInfo }
  | { type: 'subscribed'; events: string[] }
  | { type: 'event'; name: string; data: unknown; time: number }
  | { type: 'studio'; connected: boolean }
  | ({ type: 'host' } & HostInfo)
  | { type: 'error'; error: ErrorInfo };

/** Events the page sends (`event` messages), with their payloads described in the docs. */
export const API_EVENTS = [
  'model_loaded',
  'model_unloaded',
  'settings_changed',
  'expression_changed',
  'motion_finished',
  'hotkey_fired',
  'hotkey_released',
  'item_changed',
  'tracking_started',
  'tracking_stopped',
  'tracking_found',
  'tracking_lost',
  'microphone_changed',
  'command_executed',
  'history_changed',
  /** Sent by the bridge itself. */
  'agent_connected',
  'agent_disconnected',
] as const;
export type ApiEventName = (typeof API_EVENTS)[number];

/** Whether an event name matches a subscription pattern (`*`, `tracking_*` or a name). */
export function matchesEvent(pattern: string, name: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) return name.startsWith(pattern.slice(0, -1));
  return pattern === name;
}
