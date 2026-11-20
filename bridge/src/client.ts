/**
 * A small client for the bridge's `/api` endpoint, for Node programs (the
 * MCP server uses it). Other programs can speak the protocol directly; see
 * docs/agent-api.md.
 */
import { WebSocket } from 'ws';
import {
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  type BridgeToClient,
  type CommandInfoWire,
  type ErrorInfo,
  type ScopeName,
} from '../../src/core/bridgeProtocol.ts';

export class BridgeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface Welcome {
  name: string;
  scopes: ScopeName[];
  studio: { connected: boolean };
  commands: CommandInfoWire[];
  events: string[];
}

export class BridgeClient {
  welcome!: Welcome;
  studioConnected = false;
  private ws!: WebSocket;
  private seq = 0;
  private waiting = new Map<string, { resolve(v: unknown): void; reject(e: Error): void }>();
  private listeners = new Set<(name: string, data: unknown) => void>();
  onclose: ((reason: string) => void) | null = null;

  /** Connects and authenticates. Rejects with a BridgeError (`unauthorized`, `unreachable`). */
  static async connect(url: string, token: string, name = 'client'): Promise<BridgeClient> {
    const c = new BridgeClient();
    await c.open(url, token, name);
    return c;
  }

  private open(url: string, token: string, name: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { maxPayload: MAX_MESSAGE_BYTES });
      this.ws = ws;
      let done = false;
      ws.on('open', () =>
        ws.send(
          JSON.stringify({ type: 'hello', protocol: PROTOCOL_VERSION, token, client: { name } }),
        ),
      );
      ws.on('error', (e) => {
        if (!done) {
          done = true;
          reject(new BridgeError('unreachable', `Cannot reach the bridge at ${url}: ${e.message}`));
        }
      });
      ws.on('message', (raw) => {
        let m: BridgeToClient;
        try {
          m = JSON.parse(raw.toString()) as BridgeToClient;
        } catch {
          return;
        }
        if (m.type === 'welcome') {
          this.welcome = m;
          this.studioConnected = m.studio.connected;
          done = true;
          resolve();
        } else if (m.type === 'error' && !done) {
          done = true;
          reject(new BridgeError(m.error.code, m.error.message));
        } else if (m.type === 'result') {
          const w = this.waiting.get(m.id);
          if (!w) return;
          this.waiting.delete(m.id);
          if (m.ok) w.resolve(m.result);
          else w.reject(new BridgeError(m.error.code, m.error.message));
        } else if (m.type === 'event') for (const l of this.listeners) l(m.name, m.data);
        else if (m.type === 'studio') this.studioConnected = m.connected;
      });
      ws.on('close', (_code, reason) => {
        for (const w of this.waiting.values())
          w.reject(new BridgeError('closed', 'The bridge connection closed.'));
        this.waiting.clear();
        if (!done) {
          done = true;
          reject(
            new BridgeError(
              'closed',
              `The bridge closed the connection: ${reason.toString() || 'no reason given'}`,
            ),
          );
        }
        this.onclose?.(reason.toString());
      });
    });
  }

  /** Runs a command in Mochi Studio. Rejects with a BridgeError carrying the error code. */
  command(name: string, args: unknown = {}): Promise<unknown> {
    const id = String(++this.seq);
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ type: 'command', id, name, args }));
    });
  }

  subscribe(events: string[]): void {
    this.ws.send(JSON.stringify({ type: 'subscribe', events }));
  }

  onEvent(fn: (name: string, data: unknown) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  close(): void {
    this.ws.close();
  }
}

export type { ErrorInfo };
