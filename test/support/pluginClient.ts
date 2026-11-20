/**
 * A scripted plugin for tests: a WebSocket client that speaks the plugin API
 * the way plugins made for VTube Studio do.
 */
import { WebSocket } from 'ws';

export interface Message {
  apiName: string;
  apiVersion: string;
  timestamp: number;
  requestID: string;
  messageType: string;
  data: Record<string, any>;
}

export class PluginClient {
  private queue: Message[] = [];
  /** Everyone waiting for a message: each message wakes them all, to look in the queue. */
  private waiters = new Set<() => void>();
  private n = 0;

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (raw, isBinary) => {
      if (isBinary) throw new Error('The server must answer in text frames.');
      this.queue.push(JSON.parse(String(raw)) as Message);
      for (const wake of [...this.waiters]) wake();
    });
  }

  static connect(url: string): Promise<PluginClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.once('open', () => resolve(new PluginClient(ws)));
      ws.once('error', reject);
    });
  }

  /** Sends any JSON (or raw text). */
  raw(m: unknown): void {
    this.ws.send(typeof m === 'string' ? m : JSON.stringify(m));
  }

  /** Sends a request with the right envelope; returns its requestID. */
  send(messageType: string, data?: Record<string, unknown>, requestID?: string): string {
    const id = requestID ?? `t-${++this.n}`;
    this.raw({
      apiName: 'VTubeStudioPublicAPI',
      apiVersion: '1.0',
      requestID: id,
      messageType,
      ...(data ? { data } : {}),
    });
    return id;
  }

  /** The next message that matches, waiting up to `ms`. */
  async next(match: (m: Message) => boolean = () => true, ms = 5000): Promise<Message> {
    const deadline = Date.now() + ms;
    for (;;) {
      const i = this.queue.findIndex(match);
      if (i >= 0) return this.queue.splice(i, 1)[0]!;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error('No matching message in time.');
      await new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(t);
          this.waiters.delete(wake);
          resolve();
        };
        const t = setTimeout(wake, left);
        this.waiters.add(wake);
      });
    }
  }

  /** Sends a request and waits for its answer (a response or an APIError). */
  async request(messageType: string, data?: Record<string, unknown>, ms = 5000): Promise<Message> {
    const id = this.send(messageType, data);
    return this.next((m) => m.requestID === id, ms);
  }

  /** Requests a token and authenticates with it (someone must allow it). */
  async authenticate(name = 'Test Plugin', developer = 'Test Dev'): Promise<string> {
    const t = await this.request(
      'AuthenticationTokenRequest',
      { pluginName: name, pluginDeveloper: developer },
      10_000,
    );
    if (t.messageType !== 'AuthenticationTokenResponse') throw new Error(JSON.stringify(t));
    const token = t.data.authenticationToken as string;
    const a = await this.request('AuthenticationRequest', {
      pluginName: name,
      pluginDeveloper: developer,
      authenticationToken: token,
    });
    if (!a.data.authenticated) throw new Error(JSON.stringify(a));
    return token;
  }

  close(): void {
    this.ws.close();
  }
}

/** The envelope every message must have. */
export function expectEnvelope(m: Message, messageType: string): void {
  if (m.apiName !== 'VTubeStudioPublicAPI' || m.apiVersion !== '1.0')
    throw new Error(`Bad envelope: ${JSON.stringify(m)}`);
  if (typeof m.timestamp !== 'number' || typeof m.requestID !== 'string')
    throw new Error(`Bad envelope: ${JSON.stringify(m)}`);
  if (m.messageType !== messageType)
    throw new Error(`Expected ${messageType}, got ${JSON.stringify(m)}`);
  if (!m.data || typeof m.data !== 'object') throw new Error(`No data: ${JSON.stringify(m)}`);
}
