/**
 * The few parts of the Workers runtime the signaling Worker uses, as types
 * (Cloudflare's documented Durable Objects and WebSocket hibernation API).
 * Declared here rather than taken from a types package, so the project's
 * install stays the same.
 */

export interface DurableObjectId {
  toString(): string;
}

export interface DurableObjectStub {
  fetch(input: string | Request, init?: RequestInit): Promise<Response>;
}

export interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

export interface DurableObjectStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  deleteAll(): Promise<void>;
  setAlarm(at: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

/** A WebSocket the runtime keeps open while its Durable Object sleeps. */
export interface HibernatableWebSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

export interface DurableObjectState {
  storage: DurableObjectStorage;
  acceptWebSocket(ws: HibernatableWebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): HibernatableWebSocket[];
}

declare global {
  /** The runtime's pair of connected WebSockets: one for the client, one for the server. */
  // eslint-disable-next-line no-var
  var WebSocketPair: { new (): { 0: WebSocket; 1: WebSocket } };
}
