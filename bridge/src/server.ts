/**
 * The bridge server: a WebSocket relay on 127.0.0.1 between the Mochi
 * Studio page (the host, which runs every command) and clients (programs and
 * agents). It holds no app state: it checks who is talking, enforces
 * scopes, and passes commands, results and events along.
 *
 * Protocol: src/core/bridgeProtocol.ts and docs/agent-api.md.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createReadStream, readFile, realpathSync, stat, writeFile } from 'node:fs';
import type { AddressInfo, Socket } from 'node:net';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import {
  API_EVENTS,
  DEFAULT_PORT,
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  matchesEvent,
  decodeFileChunk,
  type BridgeToView,
  type BridgeToClient,
  type BridgeToHost,
  type ClientInfo,
  type CommandInfoWire,
  type ErrorInfo,
  type ScopeName,
} from '../../src/core/bridgeProtocol.ts';
import { PhoneServer } from './phone.ts';
import { PluginServer } from './plugins.ts';
import { BridgeStore, parseScopes } from './store.ts';
import { guardSocket, guardWebSocket } from './socketGuard.ts';

export const BRIDGE_VERSION = '0.1.0';

export interface BridgeOptions {
  port?: number;
  /** Extra origins allowed for the host page (besides http(s)://localhost and 127.0.0.1 on any port). */
  allowOrigins?: string[];
  store?: BridgeStore;
  /** Fallback command catalog while no page is connected. */
  catalog?: CommandInfoWire[];
  log?: (msg: string) => void;
  /** Seconds a command may take before it fails with `timeout` (speak can take longer). */
  commandTimeoutS?: number;
  /**
   * A folder to serve at /app/ (the built Mochi Studio pages). The desktop
   * app uses it, so its window and OBS's output address load from here.
   */
  staticDir?: string;
  /** The plugin server's first port (default 8001) and broadcast target (tests change them). */
  plugins?: { port?: number; broadcastAddress?: string; broadcastPort?: number };
  /**
   * The phone tracker (bridge/src/phone.ts): its first port (default 27890),
   * where it listens and the addresses it names (tests change them).
   */
  phone?: { port?: number; host?: string; addresses?: () => string[]; staticDir?: string };
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

interface Client {
  id: string;
  ws: WebSocket;
  name: string;
  scopes: ScopeName[];
  tokenId: string;
  connectedAt: number;
  subscriptions: string[];
  /** Commands in the last second, for rate limiting. */
  recent: number[];
}

interface Pending {
  client: Client;
  clientCommandId: string;
  timer: ReturnType<typeof setTimeout>;
}

const COMMANDS_PER_SECOND = 30;
const HELLO_TIMEOUT_MS = 5000;

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** http(s)://localhost or 127.0.0.1 with any port. */
function isLocalOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    return (u.protocol === 'http:' || u.protocol === 'https:') && LOCAL_HOSTNAMES.has(u.hostname);
  } catch {
    return false;
  }
}

export class BridgeServer {
  readonly store: BridgeStore;
  private http: Server;
  private wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  private host: WebSocket | undefined;
  /** The host's app name, from its host_hello. */
  private hostApp = 'unknown';
  private catalog: CommandInfoWire[];
  private events: string[] = [...API_EVENTS];
  private clients = new Map<string, Client>();
  private pending = new Map<string, Pending>();
  private hostRequests = new Map<string, true>();
  private opts: Required<
    Omit<BridgeOptions, 'store' | 'catalog' | 'staticDir' | 'plugins' | 'phone'>
  >;
  /** Plugins made for VTube Studio (off until the page switches it on). */
  readonly plugins: PluginServer;
  /** The phone tracker on the local network (off by default). */
  readonly phone: PhoneServer;
  private staticDir: string | undefined;
  /** Whether the page lets agents in (its agent access switch). */
  private agentsAllowed = true;
  /** Output views and their view ids. */
  private views = new Map<WebSocket, { viewId?: string; loggedAt?: number }>();
  /**
   * Files the page uploaded for output views (`PUT /upload/…`), by
   * `<scope>/<owner>/<path>`. Views read them straight from here; only a
   * file that is not here is fetched from the page on request.
   */
  private cache = new Map<string, Buffer>();
  /** Uploads in progress: views asking for these files wait for them. */
  private incoming = new Map<string, Array<(buf: Buffer | undefined) => void>>();
  /** Requests waiting for an upload the page has not started yet. */
  private awaiting = new Map<string, Array<(buf: Buffer) => void>>();
  private cacheBytes = 0;
  /** Folders on disk the desktop app opened (id -> real path). */
  private folders = new Map<string, string>();
  /** Models served from such a folder: `<scope>/<owner, encoded>` -> folder id. */
  private diskSources = new Map<string, { folderId: string; prefix: string }>();
  /** The current host's token, which authorizes uploads. */
  private hostToken: string | undefined;
  /** File requests from views, waiting for the page's chunks. */
  private files = new Map<
    string,
    { res: ServerResponse; timer: ReturnType<typeof setTimeout>; started: boolean }
  >();

  constructor(o: BridgeOptions = {}) {
    this.store = o.store ?? new BridgeStore();
    this.catalog = o.catalog ?? [];
    this.opts = {
      port: o.port ?? DEFAULT_PORT,
      allowOrigins: o.allowOrigins ?? [],
      log: o.log ?? ((m) => process.stderr.write(`[mochi-studio-bridge] ${m}\n`)),
      commandTimeoutS: o.commandTimeoutS ?? 30,
    };
    this.staticDir = o.staticDir;
    this.plugins = new PluginServer({
      dir: this.store.directory,
      ...o.plugins,
      log: (m) => this.opts.log(m),
      toHost: (m) => {
        if (this.host?.readyState !== WebSocket.OPEN) return false;
        this.host.send(JSON.stringify(m));
        return true;
      },
    });
    this.phone = new PhoneServer({
      dir: this.store.directory,
      ...(o.staticDir ? { staticDir: o.staticDir } : {}),
      // The phone page alone (the CLI bridge has no /app/ pages).
      ...o.phone,
      log: (m) => this.opts.log(m),
      toHost: (m) => {
        if (this.host?.readyState !== WebSocket.OPEN) return false;
        this.host.send(JSON.stringify(m));
        return true;
      },
    });
    this.http = createServer((req, res) => {
      if (!this.checkHost(req)) {
        res.writeHead(403).end();
        return;
      }
      if (this.staticDir && (req.url ?? '').startsWith('/app/')) return this.serveStatic(req, res);
      if ((req.url ?? '').startsWith('/disk/')) {
        if (!this.cors(req, res)) return;
        if (req.method === 'OPTIONS') return void res.writeHead(204).end();
        return this.serveDisk(req, res);
      }
      const path = (req.url ?? '').split('?')[0]!;
      if (path.startsWith('/files/') || path.startsWith('/upload/')) {
        if (!this.cors(req, res)) return;
        if (req.method === 'OPTIONS') return void res.writeHead(204).end();
        if (path.startsWith('/upload/')) return this.upload(req, res);
        return this.serveFile(req, res);
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          app: 'mochi-studio-bridge',
          version: BRIDGE_VERSION,
          protocol: PROTOCOL_VERSION,
          studio: { connected: !!this.host },
          host: this.hostInfo,
          endpoints: {
            host: '/host',
            api: '/api',
            view: '/view',
            files: '/files/',
            upload: '/upload/',
          },
        }),
      );
    });
    this.http.on('upgrade', (req, socket, head) => this.upgrade(req, socket as Socket, head));
  }

  /** Starts listening on 127.0.0.1. Resolves with the port. */
  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(this.opts.port, '127.0.0.1', () => {
        this.http.off('error', reject);
        const port = (this.http.address() as AddressInfo).port;
        this.opts.port = port;
        this.opts.log(`Listening on ws://127.0.0.1:${port} (localhost only).`);
        this.opts.log(
          `To connect Mochi Studio: open its Agents tab, turn on agent access, and enter the pairing code ${this.store.pairingCode()}.`,
        );
        resolve(port);
      });
    });
  }

  get port(): number {
    return this.opts.port;
  }
  get studioConnected(): boolean {
    return !!this.host;
  }

  async close(): Promise<void> {
    await this.plugins.stop();
    await this.phone.stop();
    for (const c of this.clients.values()) c.ws.terminate();
    this.host?.terminate();
    await new Promise<void>((r) => {
      this.http.close(() => r());
      this.http.closeAllConnections();
    });
  }

  // --- connection checks -------------------------------------------------------

  /** Rejects DNS-rebinding requests: the Host header must name this machine. */
  private checkHost(req: IncomingMessage): boolean {
    const host = req.headers.host ?? '';
    const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]!;
    const addr = req.socket.remoteAddress ?? '';
    const loopback = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
    return loopback && LOCAL_HOSTNAMES.has(name);
  }

  private originAllowed(origin: string): boolean {
    return isLocalOrigin(origin) || this.opts.allowOrigins.includes(origin);
  }

  private upgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    guardSocket(socket);
    const path = (req.url ?? '').split('?')[0];
    const origin = req.headers.origin;
    const refuse = (status: number, why: string): void => {
      this.opts.log(`Refused a connection to ${path}: ${why}.`);
      socket.end(`HTTP/1.1 ${status} ${status === 404 ? 'Not Found' : 'Forbidden'}\r\n\r\n`);
    };
    if (!this.checkHost(req)) return refuse(403, 'not from this machine');
    if (path === '/host') {
      // The page: a browser always sends its origin.
      if (!origin || !this.originAllowed(origin))
        return refuse(
          403,
          `origin ${origin ?? '(none)'} is not allowed (start the bridge with --allow-origin)`,
        );
      this.wss.handleUpgrade(req, socket, head, (ws) =>
        this.onHost(guardWebSocket(ws, this.opts.log, 'The page')),
      );
    } else if (path === '/view') {
      // An output view (an OBS browser source): a page from an allowed origin.
      if (!origin || !this.originAllowed(origin))
        return refuse(
          403,
          `origin ${origin ?? '(none)'} is not allowed (start the bridge with --allow-origin)`,
        );
      this.wss.handleUpgrade(req, socket, head, (ws) =>
        this.onView(guardWebSocket(ws, this.opts.log, 'An output view')),
      );
    } else if (path === '/api') {
      // Programs send no origin; a web page must be an allowed one.
      if (origin && !this.originAllowed(origin))
        return refuse(403, `origin ${origin} is not allowed`);
      this.wss.handleUpgrade(req, socket, head, (ws) =>
        this.onClient(guardWebSocket(ws, this.opts.log, 'An agent')),
      );
    } else refuse(404, 'unknown path');
  }

  // --- the host ----------------------------------------------------------------

  private onHost(ws: WebSocket): void {
    let authed = false;
    let hostApp = 'unknown';
    const send = (m: BridgeToHost): void => ws.send(JSON.stringify(m));
    ws.on('message', (raw, isBinary) => {
      if (isBinary) {
        if (authed && this.host === ws) this.onFileChunk(raw);
        return;
      }
      const m = parse(raw);
      if (!m)
        return send({
          type: 'error',
          error: { code: 'invalid_message', message: 'Messages must be JSON objects with a type.' },
        });
      if (!authed) {
        if (m.type === 'host_hello') {
          if (m.protocol !== PROTOCOL_VERSION)
            return send({
              type: 'error',
              error: {
                code: 'protocol',
                message: `This bridge speaks protocol ${PROTOCOL_VERSION}; update the older side.`,
              },
            });
          hostApp = typeof m.app === 'string' && m.app ? m.app.slice(0, 64) : 'unknown';
          if (this.store.verifyHostToken(m.hostToken)) return welcome(m.hostToken as string);
          return send({
            type: 'pair_required',
            message:
              'Enter the pairing code the bridge shows when it starts (or run "mochi-studio-bridge status").',
          });
        }
        if (m.type === 'pair') {
          const token = this.store.pair(m.code);
          if (!token) {
            this.store.pairingCode();
            return send({
              type: 'pair_failed',
              message: 'Wrong or expired pairing code. Check the code the bridge shows now.',
            });
          }
          send({ type: 'paired', hostToken: token });
          this.opts.log(`New pairing code (for the next page): ${this.store.pairingCode()}`);
          return welcome(token);
        }
        return send({
          type: 'error',
          error: { code: 'unauthorized', message: 'Send host_hello first.' },
        });
      }
      this.onHostMessage(m, send);
    });
    const welcome = (token: string): void => {
      authed = true;
      // The same page coming back (a reload) keeps what it uploaded.
      if (token !== this.hostToken) this.clearCache();
      this.hostToken = token;
      if (this.host && this.host !== ws) {
        this.opts.log('A newer Mochi Studio page took over the connection.');
        this.host.close(4000, 'replaced by a newer page');
      }
      this.host = ws;
      this.hostApp = hostApp;
      send({
        type: 'host_welcome',
        protocol: PROTOCOL_VERSION,
        bridge: { version: BRIDGE_VERSION, port: this.port },
      });
      this.sendClients();
      this.broadcastStudio(true);
      this.sendHost({ type: 'views', count: this.views.size });
      this.plugins.sendState();
      this.phone.sendState();
      this.opts.log('Mochi Studio connected.');
    };
    ws.on('close', () => {
      if (this.host !== ws) return;
      this.host = undefined;
      this.plugins.hostGone();
      this.broadcastStudio(false);
      for (const [id, f] of this.files) {
        clearTimeout(f.timer);
        if (!f.started) f.res.writeHead(503).end('Mochi Studio disconnected.');
        else f.res.destroy();
        this.files.delete(id);
      }
      // Commands in flight fail.
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        this.reply(p.client, p.clientCommandId, false, {
          code: 'studio_not_connected',
          message: 'Mochi Studio disconnected before the command finished.',
        });
        this.pending.delete(id);
      }
      this.opts.log('Mochi Studio disconnected.');
    });
  }

  private onHostMessage(m: Record<string, unknown>, send: (m: BridgeToHost) => void): void {
    switch (m.type) {
      case 'catalog':
        if (Array.isArray(m.commands)) this.catalog = m.commands as CommandInfoWire[];
        if (Array.isArray(m.events))
          this.events = (m.events as unknown[]).filter((e): e is string => typeof e === 'string');
        return;
      case 'result': {
        const p = this.pending.get(String(m.id));
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(String(m.id));
        if (m.ok === true) this.reply(p.client, p.clientCommandId, true, m.result);
        else this.reply(p.client, p.clientCommandId, false, toError(m.error));
        return;
      }
      case 'event': {
        const name = String(m.name);
        for (const c of this.clients.values())
          if (c.scopes.includes('read') && c.subscriptions.some((s) => matchesEvent(s, name)))
            this.sendClient(c, { type: 'event', name, data: m.data, time: Date.now() });
        return;
      }
      case 'token_create': {
        const scopes = parseScopes(m.scopes);
        const { token, info } = this.store.createToken(String(m.name ?? ''), scopes);
        this.opts.log(`Token "${info.name}" created (${info.scopes.join(', ') || 'no scopes'}).`);
        return send({ type: 'token_created', requestId: String(m.requestId), token, info });
      }
      case 'token_list':
        return send({
          type: 'tokens',
          requestId: String(m.requestId),
          tokens: this.store.listTokens(),
        });
      case 'host_options':
        this.agentsAllowed = m.agents !== false;
        if (!this.agentsAllowed)
          for (const c of this.clients.values()) c.ws.close(4403, 'agent access is off');
        return;
      case 'sync':
        this.evict(m.message);
        for (const v of this.views.keys()) this.sendView(v, { type: 'sync', message: m.message });
        return;
      case 'view_key': {
        const key = m.renew === true || !this.store.hasViewKey() ? this.store.newViewKey() : null;
        return send({ type: 'view_key', requestId: String(m.requestId), key });
      }
      case 'disk_source': {
        const folderId = String(m.folderId);
        if (!this.folders.has(folderId)) return;
        const scope = m.scope === 'item' ? 'item' : 'model';
        const prefix = typeof m.prefix === 'string' ? m.prefix.replace(/^\/+|\/+$/g, '') : '';
        this.diskSources.set(`${scope}/${encodeURIComponent(String(m.owner))}`, {
          folderId,
          prefix,
        });
        return;
      }
      case 'file_error': {
        const f = this.files.get(String(m.id));
        if (!f) return;
        clearTimeout(f.timer);
        this.files.delete(String(m.id));
        if (!f.started)
          f.res
            .writeHead(404, { 'content-type': 'text/plain' })
            .end(String(m.message ?? 'Not found.'));
        else f.res.destroy();
        return;
      }
      // The plugin API (bridge/src/plugins.ts).
      case 'plugins_options':
        void this.plugins.setEnabled(m.on === true);
        return;
      case 'plugin_approval':
        return this.plugins.approve(String(m.requestId), m.allow === true);
      case 'plugin_result':
        return this.plugins.answer(String(m.id), {
          ...(m.data && typeof m.data === 'object'
            ? { data: m.data as Record<string, unknown> }
            : {}),
          ...(typeof m.errorID === 'number' ? { errorID: m.errorID } : {}),
          ...(typeof m.message === 'string' ? { message: m.message } : {}),
        });
      case 'plugin_event':
        if (m.data && typeof m.data === 'object')
          this.plugins.event(
            String(m.name),
            m.data as Record<string, unknown>,
            typeof m.session === 'string' ? m.session : undefined,
          );
        return;
      case 'plugin_expressions':
        if (Array.isArray(m.expressions))
          this.plugins.setExpressions({
            type: 'plugin_expressions',
            modelID: String(m.modelID ?? ''),
            modelName: String(m.modelName ?? ''),
            expressions: (m.expressions as Array<Record<string, unknown>>).map((e) => ({
              expressionFile: String(e.expressionFile ?? ''),
              expressionName: String(e.expressionName ?? ''),
              active: e.active === true,
            })),
          });
        return;
      case 'plugin_revoke':
        return this.plugins.revoke(String(m.pluginId));
      case 'plugin_grant':
        return this.plugins.setTrackingData(String(m.pluginId), m.trackingData === true);
      case 'plugin_permission':
        return this.plugins.setPermission(String(m.pluginId), String(m.permission), false);
      // The phone tracker (bridge/src/phone.ts).
      case 'phone_options':
        void this.phone.setEnabled(m.on === true);
        return;
      case 'phone_revoke':
        return this.phone.revoke(String(m.phoneId));
      case 'token_revoke': {
        const id = String(m.id);
        this.store.revokeToken(id);
        for (const c of this.clients.values())
          if (c.tokenId === id) c.ws.close(4401, 'token revoked');
        return send({ type: 'token_revoked', requestId: String(m.requestId), id });
      }
      default:
        send({
          type: 'error',
          error: { code: 'invalid_message', message: `Unknown message type ${String(m.type)}.` },
        });
    }
  }

  private sendHost(m: BridgeToHost): void {
    if (this.host?.readyState === WebSocket.OPEN) this.host.send(JSON.stringify(m));
  }

  private sendClients(): void {
    const clients: ClientInfo[] = [...this.clients.values()].map((c) => ({
      id: c.id,
      name: c.name,
      scopes: c.scopes,
      connectedAt: c.connectedAt,
    }));
    this.sendHost({ type: 'clients', clients });
  }

  // --- clients -----------------------------------------------------------------

  private onClient(ws: WebSocket): void {
    let client: Client | undefined;
    const helloTimer = setTimeout(() => {
      if (!client) {
        ws.send(
          JSON.stringify({
            type: 'error',
            error: { code: 'unauthorized', message: 'Send hello with a token first.' },
          }),
        );
        ws.close(4401, 'no hello');
      }
    }, HELLO_TIMEOUT_MS);
    ws.on('message', (raw) => {
      const m = parse(raw);
      if (!m)
        return void ws.send(
          JSON.stringify(err('invalid_message', 'Messages must be JSON objects with a type.')),
        );
      if (!client) {
        if (m.type !== 'hello')
          return void ws.send(
            JSON.stringify(err('unauthorized', 'Send hello with a token first.')),
          );
        if (!this.agentsAllowed) {
          ws.send(
            JSON.stringify(
              err(
                'agents_off',
                'Agent access is off in Mochi Studio. Turn it on in its Agents tab.',
              ),
            ),
          );
          return void ws.close(4403, 'agent access is off');
        }
        const info = this.store.verifyToken(m.token);
        if (!info) {
          ws.send(
            JSON.stringify(
              err(
                'unauthorized',
                'Unknown token. Create one in Mochi Studio (Agents tab) or with "mochi-studio-bridge token create".',
              ),
            ),
          );
          return void ws.close(4401, 'unauthorized');
        }
        clearTimeout(helloTimer);
        client = {
          id: randomBytes(4).toString('hex'),
          ws,
          name: info.name,
          scopes: info.scopes,
          tokenId: info.id,
          connectedAt: Date.now(),
          subscriptions: [],
          recent: [],
        };
        this.clients.set(client.id, client);
        this.sendClient(client, {
          type: 'welcome',
          protocol: PROTOCOL_VERSION,
          name: client.name,
          scopes: client.scopes,
          studio: { connected: !!this.host },
          host: this.hostInfo,
          commands: this.catalog,
          events: this.events,
        });
        this.sendClients();
        this.hostEvent('agent_connected', { name: client.name, scopes: client.scopes });
        this.opts.log(`Agent "${client.name}" connected (${client.scopes.join(', ')}).`);
        return;
      }
      this.onClientMessage(client, m);
    });
    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (!client) return;
      this.clients.delete(client.id);
      for (const [id, p] of this.pending)
        if (p.client === client) {
          clearTimeout(p.timer);
          this.pending.delete(id);
        }
      this.sendClients();
      this.hostEvent('agent_disconnected', { name: client.name });
      this.opts.log(`Agent "${client.name}" disconnected.`);
    });
  }

  /** An event made by the bridge, sent to the page (which shows it) and to subscribed clients. */
  private hostEvent(name: string, data: unknown): void {
    for (const c of this.clients.values())
      if (c.scopes.includes('read') && c.subscriptions.some((s) => matchesEvent(s, name)))
        this.sendClient(c, { type: 'event', name, data, time: Date.now() });
  }

  private onClientMessage(c: Client, m: Record<string, unknown>): void {
    switch (m.type) {
      case 'subscribe':
      case 'unsubscribe': {
        const list = Array.isArray(m.events)
          ? m.events.filter((e): e is string => typeof e === 'string')
          : [];
        if (!c.scopes.includes('read'))
          return this.sendClient(c, err('forbidden', 'Events need the "read" scope.'));
        c.subscriptions =
          m.type === 'subscribe'
            ? [...new Set([...c.subscriptions, ...list])].slice(0, 100)
            : c.subscriptions.filter((s) => !list.includes(s));
        return this.sendClient(c, { type: 'subscribed', events: c.subscriptions });
      }
      case 'command': {
        const id = typeof m.id === 'string' || typeof m.id === 'number' ? String(m.id) : '';
        const name = typeof m.name === 'string' ? m.name : '';
        if (!id || !name)
          return this.sendClient(c, err('invalid_message', 'A command needs an id and a name.'));
        const now = Date.now();
        c.recent = c.recent.filter((t) => now - t < 1000);
        if (c.recent.length >= COMMANDS_PER_SECOND)
          return this.reply(c, id, false, {
            code: 'rate_limited',
            message: `At most ${COMMANDS_PER_SECOND} commands per second.`,
          });
        c.recent.push(now);
        const def = this.catalog.find((x) => x.name === name);
        if (def && !c.scopes.includes(def.scope))
          return this.reply(c, id, false, {
            code: 'forbidden',
            message: `${name} needs the "${def.scope}" scope, which this token does not have.`,
          });
        if (!this.host)
          return this.reply(c, id, false, {
            code: 'studio_not_connected',
            message:
              'Mochi Studio is not connected to the bridge. Open Mochi Studio and turn on agent access in its Agents tab.',
          });
        const bridgeId = randomBytes(8).toString('hex');
        const timeout =
          (name === 'speak' || name === 'replay_log' ? 600 : this.opts.commandTimeoutS) * 1000;
        this.pending.set(bridgeId, {
          client: c,
          clientCommandId: id,
          timer: setTimeout(() => {
            this.pending.delete(bridgeId);
            this.reply(c, id, false, {
              code: 'timeout',
              message: `${name} did not finish in ${timeout / 1000} s.`,
            });
          }, timeout),
        });
        // The page checks the scopes again before it runs anything.
        this.sendHost({
          type: 'command',
          id: bridgeId,
          client: { id: c.id, name: c.name, scopes: c.scopes },
          name,
          args: m.args ?? {},
        });
        return;
      }
      default:
        this.sendClient(c, err('invalid_message', `Unknown message type ${String(m.type)}.`));
    }
  }

  private reply(c: Client, id: string, ok: boolean, payload: unknown): void {
    this.sendClient(
      c,
      ok
        ? { type: 'result', id, ok: true, result: payload }
        : { type: 'result', id, ok: false, error: payload as ErrorInfo },
    );
  }

  private sendClient(c: Client, m: BridgeToClient): void {
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(m));
  }

  /** The app connected as host, for `host` in GET / and in messages (neutral for other hosts). */
  private get hostInfo(): { connected: boolean; app: string | null } {
    return { connected: !!this.host, app: this.host ? this.hostApp : null };
  }

  private broadcastStudio(connected: boolean): void {
    const host = this.hostInfo;
    for (const c of this.clients.values()) {
      this.sendClient(c, { type: 'studio', connected });
      this.sendClient(c, { type: 'host', ...host });
    }
    for (const v of this.views.keys()) {
      this.sendView(v, { type: 'studio', connected });
      this.sendView(v, { type: 'host', ...host });
    }
  }

  // --- output views --------------------------------------------------------------

  private sendView(ws: WebSocket, m: BridgeToView): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
  }

  /**
   * An output view. It receives the same messages a view in the control
   * window's browser profile gets over BroadcastChannel (encoded with
   * encodeSync), and reads the model's files from /files. A view key gives
   * nothing else: no commands, no events, no tokens.
   */
  private onView(ws: WebSocket): void {
    let authed = false;
    const helloTimer = setTimeout(() => {
      if (!authed) ws.close(4401, 'no view_hello');
    }, HELLO_TIMEOUT_MS);
    ws.on('message', (raw) => {
      const m = parse(raw);
      if (!m) return;
      if (!authed) {
        if (m.type !== 'view_hello' || !this.store.verifyViewKey(m.key)) {
          this.sendView(ws, {
            type: 'error',
            error: {
              code: 'unauthorized',
              message:
                'Unknown view key. Copy the output view address again from Mochi Studio’s Output tab.',
            },
          });
          return void ws.close(4401, 'unauthorized');
        }
        authed = true;
        clearTimeout(helloTimer);
        this.views.set(ws, {});
        this.sendView(ws, {
          type: 'view_welcome',
          protocol: PROTOCOL_VERSION,
          studio: { connected: !!this.host },
          host: this.hostInfo,
        });
        this.sendHost({ type: 'views', count: this.views.size });
        return;
      }
      if (m.type !== 'sync') return;
      const msg = m.message as { type?: unknown; viewId?: unknown } | undefined;
      // Views only say hello and bye, how loading goes, and their errors.
      if (!msg || typeof msg.viewId !== 'string') return;
      if (msg.type === 'viewStatus') {
        const st = m.message as Record<string, unknown>;
        const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
        return this.sendHost({
          type: 'sync',
          message: {
            type: 'viewStatus',
            viewId: msg.viewId,
            state: st.state === 'ready' || st.state === 'failed' ? st.state : 'loading',
            loaded: num(st.loaded),
            total: num(st.total),
            ms: num(st.ms),
            ...(typeof st.message === 'string' ? { message: st.message.slice(0, 300) } : {}),
          },
        });
      }
      // A view's errors, for the window's log: short, and at most one a second.
      if (msg.type === 'viewLog') {
        const v = this.views.get(ws)!;
        const now = Date.now();
        const text = (m.message as Record<string, unknown>).text;
        if (typeof text !== 'string' || now - (v.loggedAt ?? 0) < 1000) return;
        v.loggedAt = now;
        return this.sendHost({
          type: 'sync',
          message: { type: 'viewLog', viewId: msg.viewId, text: text.slice(0, 300) },
        });
      }
      if (msg.type !== 'hello' && msg.type !== 'bye') return;
      this.views.get(ws)!.viewId = msg.viewId;
      this.sendHost({ type: 'sync', message: { type: msg.type, viewId: msg.viewId } });
    });
    ws.on('close', () => {
      clearTimeout(helloTimer);
      const v = this.views.get(ws);
      if (!v) return;
      this.views.delete(ws);
      if (v.viewId) this.sendHost({ type: 'sync', message: { type: 'bye', viewId: v.viewId } });
      this.sendHost({ type: 'views', count: this.views.size });
    });
  }

  // --- folders on disk (the desktop app) ------------------------------------------

  /**
   * Registers a folder the person opened in the desktop app's folder dialog.
   * Only the app's main process can call this; pages cannot name paths.
   */
  registerFolder(dir: string): string {
    const id = randomBytes(8).toString('hex');
    this.folders.set(id, realpathSync(dir));
    return id;
  }

  /** A file inside a registered folder, or undefined when the path leaves it. */
  private diskPath(folderId: string, encodedPath: string): string | undefined {
    const root = this.folders.get(folderId);
    if (!root) return undefined;
    let rel: string;
    try {
      rel = encodedPath.split('/').map(decodeURIComponent).join('/');
    } catch {
      return undefined;
    }
    const file = resolve(root, rel);
    if (!file.startsWith(root + sep)) return undefined;
    try {
      // No symbolic link may lead out of the folder.
      const real = realpathSync(file);
      return real.startsWith(root + sep) ? real : undefined;
    } catch {
      return undefined;
    }
  }

  private sendFromDisk(folderId: string, encodedPath: string, res: ServerResponse): void {
    const file = this.diskPath(folderId, encodedPath);
    if (!file) return void res.writeHead(404).end();
    stat(file, (err, st) => {
      if (err || !st.isFile()) return void res.writeHead(404).end();
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(st.size),
        'cache-control': 'no-store',
      });
      createReadStream(file).pipe(res);
    });
  }

  /**
   * GET /disk/<folder id>/<path>, for the page (its host token): files of an
   * opened folder. PUT writes an expression file there (the expression
   * editor): only `.exp3.json` files of at most 256 KB that hold
   * a JSON object, inside the folder.
   */
  private serveDisk(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'GET' && req.method !== 'PUT') return void res.writeHead(405).end();
    if (!this.host || !this.hostToken || req.headers.authorization !== `Bearer ${this.hostToken}`)
      return void res.writeHead(401).end();
    const m = /^\/disk\/([0-9a-f]+)\/(.+)$/.exec((req.url ?? '').split('?')[0]!);
    if (!m) return void res.writeHead(404).end();
    if (req.method === 'PUT') return this.writeToDisk(m[1]!, m[2]!, req, res);
    this.sendFromDisk(m[1]!, m[2]!, res);
  }

  /** Where an expression file may be written in a registered folder (it need not exist yet). */
  private diskWritePath(folderId: string, encodedPath: string): string | undefined {
    const root = this.folders.get(folderId);
    if (!root) return undefined;
    let rel: string;
    try {
      rel = encodedPath.split('/').map(decodeURIComponent).join('/');
    } catch {
      return undefined;
    }
    if (!/\.exp3\.json$/i.test(rel)) return undefined;
    const file = resolve(root, rel);
    if (!file.startsWith(root + sep)) return undefined;
    try {
      // The folder it goes into must exist inside the opened folder, links resolved.
      const dir = realpathSync(dirname(file));
      if (dir !== root && !dir.startsWith(root + sep)) return undefined;
      const target = join(dir, basename(file));
      try {
        const real = realpathSync(target);
        return real.startsWith(root + sep) ? real : undefined;
      } catch {
        return target;
      }
    } catch {
      return undefined;
    }
  }

  private writeToDisk(
    folderId: string,
    encodedPath: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): void {
    const file = this.diskWritePath(folderId, encodedPath);
    if (!file) return void res.writeHead(403).end();
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 256 * 1024 && !failed) {
        failed = true;
        res.writeHead(413).end();
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (failed) return;
      const body = Buffer.concat(chunks);
      try {
        const v: unknown = JSON.parse(body.toString('utf8'));
        if (typeof v !== 'object' || v === null || Array.isArray(v))
          throw new Error('not an object');
      } catch {
        return void res.writeHead(400).end();
      }
      stat(file, (err, st) => {
        if (!err && !st.isFile()) return void res.writeHead(409).end();
        writeFile(file, body, (e) => {
          if (e) return void res.writeHead(500).end();
          this.opts.log(`Saved ${basename(file)} into a model folder`);
          res.writeHead(204).end();
        });
      });
    });
  }

  /** GET /app/<file>: the built pages, for the desktop app. */
  private serveStatic(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'GET' && req.method !== 'HEAD') return void res.writeHead(405).end();
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    let rel: string;
    try {
      rel = decodeURIComponent(url.pathname.slice('/app/'.length)) || 'index.html';
    } catch {
      return void res.writeHead(400).end();
    }
    const root = resolve(this.staticDir!);
    const file = resolve(root, rel);
    // Nothing outside the folder.
    if (file !== root && !file.startsWith(root + sep)) return void res.writeHead(403).end();
    readFile(file, (err, data) => {
      if (err) return void res.writeHead(404).end();
      res.writeHead(200, {
        'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'content-length': String(data.length),
        'cache-control': 'no-cache',
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  }

  /** CORS for /files and /upload: allowed origins only. False when refused. */
  private cors(req: IncomingMessage, res: ServerResponse): boolean {
    const origin = req.headers.origin;
    if (!origin) return true;
    if (!this.originAllowed(origin)) {
      res.writeHead(403).end();
      return false;
    }
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'origin');
    res.setHeader('access-control-allow-methods', 'GET, HEAD, PUT, OPTIONS');
    res.setHeader('access-control-expose-headers', 'content-length');
    res.setHeader('access-control-allow-headers', 'authorization, content-type');
    res.setHeader('access-control-max-age', '600');
    return true;
  }

  private clearCache(): void {
    this.cache.clear();
    this.cacheBytes = 0;
  }

  /** Drops uploaded files of models and items the page no longer shows. */
  private evict(message: unknown): void {
    const m = message as { type?: string; key?: string; items?: Array<{ id?: string }> };
    const drop = (keep: (scope: string, owner: string) => boolean): void => {
      for (const [k, buf] of this.cache) {
        const [scope, owner] = k.split('/', 2) as [string, string];
        if (!keep(scope, decodeURIComponent(owner))) {
          this.cache.delete(k);
          this.cacheBytes -= buf.length;
        }
      }
    };
    if (m?.type === 'modelRemote') {
      drop((scope, owner) => scope !== 'model' || owner === m.key);
      for (const k of this.diskSources.keys())
        if (k.startsWith('model/') && k !== `model/${encodeURIComponent(m.key ?? '')}`)
          this.diskSources.delete(k);
    } else if (m?.type === 'itemsRemote') {
      const ids = new Set((m.items ?? []).map((i) => i.id));
      drop((scope, owner) => scope !== 'item' || ids.has(owner));
    } else if (m?.type === 'unload') drop((scope) => scope !== 'model');
  }

  /**
   * PUT /upload/(model|item)/<owner>/<path>, from the page (its host token
   * as a bearer token): a file for output views, kept in memory while the
   * page shows it (at most 2 GiB in all).
   */
  private upload(req: IncomingMessage, res: ServerResponse): void {
    const auth = req.headers.authorization ?? '';
    if (req.method !== 'PUT' && req.method !== 'HEAD') return void res.writeHead(405).end();
    if (!this.host || !this.hostToken || auth !== `Bearer ${this.hostToken}`)
      return void res.writeHead(401).end();
    const m = /^\/upload\/(model|item)\/([^/]+)\/(.+)$/.exec((req.url ?? '').split('?')[0]!);
    if (!m) return void res.writeHead(404).end();
    const key = `${m[1]}/${m[2]}/${m[3]}`;
    // HEAD: does the bridge have it already (after a reload of the page)?
    if (req.method === 'HEAD') {
      const have = this.cache.get(key);
      return void res
        .writeHead(have ? 200 : 404, have ? { 'content-length': String(have.length) } : {})
        .end();
    }
    if (!this.incoming.has(key)) this.incoming.set(key, []);
    const settle = (buf: Buffer | undefined): void => {
      const waiting = this.incoming.get(key) ?? [];
      this.incoming.delete(key);
      for (const w of waiting) w(buf);
      if (buf) {
        const early = this.awaiting.get(key) ?? [];
        this.awaiting.delete(key);
        for (const w of early) w(buf);
      }
    };
    req.on('close', () => {
      if (this.incoming.has(key)) settle(undefined);
    });
    const parts: Buffer[] = [];
    let n = 0;
    req.on('data', (d: Buffer) => {
      n += d.length;
      if (this.cacheBytes + n > 2 * 1024 ** 3) {
        res.writeHead(507).end('Too much uploaded.');
        req.destroy();
        return;
      }
      parts.push(d);
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      const buf = Buffer.concat(parts, n);
      const old = this.cache.get(key);
      if (old) this.cacheBytes -= old.length;
      this.cache.set(key, buf);
      this.cacheBytes += buf.length;
      res.writeHead(204).end();
      settle(buf);
    });
  }

  /**
   * GET /files/(model|item)/<owner>/<path>?key=<view key>: a file, from
   * what the page uploaded, or else from the page itself, streamed.
   */
  private serveFile(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method !== 'GET') return void res.writeHead(405).end();
    if (!this.store.verifyViewKey(url.searchParams.get('key')))
      return void res.writeHead(401, { 'content-type': 'text/plain' }).end('Unknown view key.');
    const m = /^\/files\/(model|item)\/([^/]+)\/(.+)$/.exec(url.pathname);
    if (!m) return void res.writeHead(404).end();
    const key = `${m[1]}/${m[2]}/${m[3]}`;
    const send = (buf: Buffer): void => {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(buf.length),
        'cache-control': 'no-store',
      });
      res.end(buf);
    };
    const cached = this.cache.get(key);
    if (cached) return send(cached);
    const disk = this.diskSources.get(`${m[1]}/${m[2]}`);
    if (disk)
      return this.sendFromDisk(
        disk.folderId,
        disk.prefix ? `${disk.prefix.split('/').map(encodeURIComponent).join('/')}/${m[3]}` : m[3]!,
        res,
      );
    const waiting = this.incoming.get(key);
    if (waiting) {
      // Being uploaded: wait for it rather than asking the page a second time.
      waiting.push((buf) => (buf ? send(buf) : this.fromHost(m, res)));
      return;
    }
    this.fromHost(m, res, key);
  }

  /**
   * Asks the page for a file that is not here. The page uploads it next if
   * it can (the answer then comes from the upload), or streams it in chunks
   * over the WebSocket.
   */
  private fromHost(m: RegExpExecArray, res: ServerResponse, key?: string): void {
    if (!this.host)
      return void res
        .writeHead(503, { 'content-type': 'text/plain' })
        .end('Mochi Studio is not connected.');
    const id = randomBytes(8).toString('hex');
    const arm = (): ReturnType<typeof setTimeout> =>
      setTimeout(() => {
        const f = this.files.get(id);
        this.files.delete(id);
        if (f && !f.started) f.res.writeHead(504).end('Timed out.');
        else f?.res.destroy();
      }, 60_000);
    this.files.set(id, { res, timer: arm(), started: false });
    const fromUpload = (buf: Buffer): void => {
      const f = this.files.get(id);
      if (!f || f.started) return;
      clearTimeout(f.timer);
      this.files.delete(id);
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(buf.length),
        'cache-control': 'no-store',
      });
      res.end(buf);
    };
    if (key) {
      const list = this.awaiting.get(key) ?? [];
      list.push(fromUpload);
      this.awaiting.set(key, list);
    }
    res.on('close', () => {
      const f = this.files.get(id);
      if (f) clearTimeout(f.timer);
      this.files.delete(id);
      if (key) {
        const list = (this.awaiting.get(key) ?? []).filter((w) => w !== fromUpload);
        if (list.length) this.awaiting.set(key, list);
        else this.awaiting.delete(key);
      }
    });
    this.sendHost({
      type: 'file_request',
      id,
      scope: m[1] as 'model' | 'item',
      owner: decodeURIComponent(m[2]!),
      path: m[3]!.split('/').map(decodeURIComponent).join('/'),
    });
  }

  private onFileChunk(raw: RawData): void {
    const buf = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as ArrayBuffer);
    const chunk = decodeFileChunk(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
    if (!chunk) return;
    const f = this.files.get(chunk.header.id);
    if (!f) return;
    clearTimeout(f.timer);
    if (!f.started) {
      f.started = true;
      f.res.writeHead(200, {
        'content-type': 'application/octet-stream',
        ...(chunk.header.size !== undefined ? { 'content-length': String(chunk.header.size) } : {}),
        'cache-control': 'no-store',
      });
    }
    if (chunk.bytes.length) f.res.write(chunk.bytes);
    if (chunk.header.done) {
      this.files.delete(chunk.header.id);
      f.res.end();
    } else
      f.timer = setTimeout(() => {
        this.files.delete(chunk.header.id);
        f.res.destroy();
      }, 60_000);
  }
}

function parse(raw: RawData): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(raw.toString());
    return v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      typeof (v as { type?: unknown }).type === 'string'
      ? (v as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function err(code: string, message: string): { type: 'error'; error: ErrorInfo } {
  return { type: 'error', error: { code, message } };
}

function toError(v: unknown): ErrorInfo {
  const e = (v ?? {}) as Partial<ErrorInfo>;
  return {
    code: typeof e.code === 'string' ? e.code : 'failed',
    message: typeof e.message === 'string' ? e.message : 'The command failed.',
  };
}
