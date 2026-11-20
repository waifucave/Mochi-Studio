/**
 * The plugin server: the WebSocket API of plugins made for VTube Studio
 * (written from a specification of that protocol), in the bridge process next to the agent
 * API, on its own port. Off until the person switches it on in Mochi Studio.
 *
 * The bridge answers the transport, authentication, custom parameters and
 * event subscriptions itself. Requests that need the app's state (model,
 * hotkeys, expressions, tracking, tints) go to the page, which answers them
 * (src/web/pluginHost.ts); events come from the page too.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import {
  API_NAME,
  API_VERSION,
  APP_NAME,
  APP_VERSION,
  BRIDGE_REQUESTS,
  BROADCAST_INTERVAL_MS,
  BROADCAST_PORT,
  BROADCAST_TYPE,
  DEFAULT_PLUGIN_PORT,
  E,
  EVENT_NAMES,
  FOLDER_NAMES,
  GRANTABLE_PERMISSIONS,
  HOTKEY_TYPES,
  PERMISSIONS,
  PER_SESSION_EVENTS,
  WAITING_REQUESTS,
  MAX_CUSTOM_PER_PLUGIN,
  MAX_CUSTOM_TOTAL,
  PAGE_REQUESTS,
  PLUGIN_PORT_TRIES,
  REQUEST_TYPES,
  UNAUTHENTICATED_REQUESTS,
  envelope,
  errorEnvelope,
  isDefaultParameterName,
  validCustomName,
  validParameterNumber,
  validRequestId,
  type BridgeToHostPlugin,
  type Envelope,
  type HostToBridgePlugin as HostToBridgeMessage,
} from '../../src/core/plugins/protocol.ts';
import { PluginStore } from './pluginStore.ts';
import { guardSocket, guardWebSocket } from './socketGuard.ts';

export interface PluginServerOptions {
  /** The bridge's folder (plugins.json goes there). */
  dir: string;
  /** First port to try (default 8001); the next ones follow when taken. */
  port?: number;
  /** Where the discovery broadcast goes (default 255.255.255.255:47779). */
  broadcastAddress?: string;
  broadcastPort?: number;
  log: (m: string) => void;
  /** Sends a message to the page, if one is connected; false when none is. */
  toHost: (m: BridgeToHostPlugin) => boolean;
  /** Seconds the page may take to answer (approval popups take longer). */
  answerTimeoutS?: number;
}

interface Session {
  id: string;
  ws: WebSocket;
  pluginId?: string;
  /** The plugin was revoked while connected: everything gets error 50. */
  revoked?: boolean;
  subscriptions: Map<string, Record<string, unknown>>;
  /** Events sent per subscription so far, for `eventCounter` (reset on each new subscription). */
  counters: Map<string, number>;
  /** A token request waiting for the person. */
  approval?: string;
}

interface PendingAnswer {
  session: Session;
  requestID: string;
  messageType: string;
  timer: ReturnType<typeof setTimeout>;
}

const APPROVAL_TIMEOUT_S = 300;

/** A 128 × 128 PNG or JPEG in base64. */
export function validIcon(icon: string): boolean {
  let b: Buffer;
  try {
    b = Buffer.from(icon, 'base64');
  } catch {
    return false;
  }
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47 && b.toString('ascii', 12, 16) === 'IHDR')
    return b.readUInt32BE(16) === 128 && b.readUInt32BE(20) === 128;
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return false;
      const marker = b[i + 1]!;
      const len = b.readUInt16BE(i + 2);
      const sof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
      if (sof) return b.readUInt16BE(i + 5) === 128 && b.readUInt16BE(i + 7) === 128;
      i += 2 + len;
    }
  }
  return false;
}

export class PluginServer {
  readonly store: PluginStore;
  private opts: Required<Omit<PluginServerOptions, 'broadcastAddress'>> & {
    broadcastAddress: string;
  };
  private servers: Server[] = [];
  private wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  private sessions = new Map<string, Session>();
  private pending = new Map<string, PendingAnswer>();
  private approvals = new Map<
    string,
    {
      session: Session;
      requestID: string;
      name: string;
      developer: string;
      icon: string;
      /** A permission request of an allowed plugin, not a token request. */
      permission?: { name: string; pluginId: string };
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  /** The last ModelMovedEvent, sent to a session right after it subscribes. */
  private lastModelMoved: Record<string, unknown> | undefined;
  /** The loaded model's expressions, for ExpressionToggledEvent's snapshot on subscribing. */
  private expressions: Extract<HostToBridgeMessage, { type: 'plugin_expressions' }> | undefined;
  private udp: UdpSocket | undefined;
  private broadcastTimer: ReturnType<typeof setInterval> | undefined;
  private testTimer: ReturnType<typeof setInterval> | undefined;
  private readonly started = Date.now();
  private readonly instanceID = randomBytes(16).toString('hex');
  private on = false;
  private actualPort: number | null = null;
  private problem: string | undefined;
  private starting: Promise<void> | undefined;

  constructor(o: PluginServerOptions) {
    this.store = new PluginStore(o.dir);
    this.opts = {
      port: DEFAULT_PLUGIN_PORT,
      broadcastPort: BROADCAST_PORT,
      answerTimeoutS: 10,
      ...o,
      broadcastAddress: o.broadcastAddress ?? '255.255.255.255',
    };
  }

  get port(): number | null {
    return this.actualPort;
  }

  // --- switching on and off ------------------------------------------------------

  /** The page's switch. Starting tries the default port, then the next ones. */
  async setEnabled(on: boolean): Promise<void> {
    await this.starting;
    if (on === this.on) return this.sendState();
    this.on = on;
    if (on) {
      this.starting = this.start();
      await this.starting;
      this.starting = undefined;
    } else await this.stop();
    this.sendState();
  }

  private async start(): Promise<void> {
    this.problem = undefined;
    for (let i = 0; i < PLUGIN_PORT_TRIES; i++) {
      const port = this.opts.port + i;
      const v4 = this.httpServer();
      try {
        await listen(v4, port, '127.0.0.1');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') continue;
        this.problem = `The plugin server could not start: ${(e as Error).message}`;
        this.on = false;
        return;
      }
      this.servers = [v4];
      this.actualPort = (v4.address() as AddressInfo).port;
      // "localhost" may resolve to ::1: listen there too, where IPv6 exists.
      const v6 = this.httpServer();
      await listen(v6, this.actualPort, '::1').then(
        () => this.servers.push(v6),
        () => undefined,
      );
      this.opts.log(
        `Plugin server listening on ws://localhost:${this.actualPort} (localhost only).`,
      );
      this.startBroadcast();
      this.testTimer = setInterval(() => this.testEvents(), 1000);
      return;
    }
    this.problem = `Plugins cannot connect: ports ${this.opts.port}–${this.opts.port + PLUGIN_PORT_TRIES - 1} are all in use by other programs (another copy of Mochi Studio or of the other app, for example). Close one of them, then switch the plugin server off and on.`;
    this.on = false;
  }

  private httpServer(): Server {
    const s = createServer((_req, res) => {
      res.writeHead(426, { 'content-type': 'text/plain' }).end('WebSocket only.');
    });
    s.on('upgrade', (req, socket, head) => {
      guardSocket(socket);
      this.wss.handleUpgrade(req, socket, head, (ws) =>
        this.onSession(guardWebSocket(ws, this.opts.log, 'A plugin')),
      );
    });
    return s;
  }

  async stop(): Promise<void> {
    this.on = false;
    clearInterval(this.broadcastTimer);
    clearInterval(this.testTimer);
    this.broadcast(false);
    this.udp?.close();
    this.udp = undefined;
    for (const s of this.sessions.values()) s.ws.terminate();
    for (const a of this.approvals.values()) clearTimeout(a.timer);
    this.approvals.clear();
    await Promise.all(
      this.servers.map(
        (s) =>
          new Promise<void>((r) => {
            s.close(() => r());
            s.closeAllConnections();
          }),
      ),
    );
    this.servers = [];
    this.actualPort = null;
  }

  /** Tells the page the server's state, the allowed plugins and the custom parameters. */
  sendState(): void {
    this.opts.toHost({
      type: 'plugins',
      on: this.on,
      port: this.actualPort,
      ...(this.problem ? { problem: this.problem } : {}),
      plugins: this.store.list((id) => this.sessionsOf(id)),
      parameters: this.store.parameters(),
      subscribed: [
        ...new Set(
          [...this.sessions.values()].flatMap((s) =>
            s.pluginId && !s.revoked ? [...s.subscriptions.keys()] : [],
          ),
        ),
      ],
      drawOutline: [...this.sessions.values()].some(
        (s) => s.subscriptions.get('ModelOutlineEvent')?.draw === true,
      ),
      sessionEvents: [...this.sessions.values()].flatMap((s) =>
        s.pluginId && !s.revoked
          ? [...s.subscriptions]
              .filter(([name]) => PER_SESSION_EVENTS.has(name))
              .map(([name, config]) => ({ session: s.id, name, config }))
          : [],
      ),
    });
  }

  private sessionsOf(pluginId: string): number {
    let n = 0;
    for (const s of this.sessions.values()) if (s.pluginId === pluginId && !s.revoked) n++;
    return n;
  }

  /** Connected, authenticated sessions (for the page's statistics). */
  get connectedCount(): number {
    let n = 0;
    for (const s of this.sessions.values()) if (s.pluginId && !s.revoked) n++;
    return n;
  }

  // --- the discovery broadcast --------------------------------------

  private startBroadcast(): void {
    try {
      const udp = createSocket({ type: 'udp4', reuseAddr: true });
      udp.on('error', () => undefined);
      udp.bind(0, () => {
        try {
          udp.setBroadcast(true);
        } catch {
          /* no broadcast on this network */
        }
      });
      this.udp = udp;
    } catch {
      return;
    }
    this.broadcast(true);
    this.broadcastTimer = setInterval(() => this.broadcast(true), BROADCAST_INTERVAL_MS);
  }

  private broadcast(active: boolean): void {
    if (!this.udp || this.actualPort === null) return;
    const m = envelope(BROADCAST_TYPE, BROADCAST_TYPE, {
      active,
      port: this.actualPort,
      instanceID: this.instanceID,
      windowTitle: APP_NAME,
    });
    const buf = Buffer.from(JSON.stringify(m));
    try {
      this.udp.send(buf, this.opts.broadcastPort, this.opts.broadcastAddress, () => undefined);
    } catch {
      /* the socket is not ready yet, or the network refuses broadcasts */
    }
  }

  // --- sessions ------------------------------------------------------------------

  private onSession(ws: WebSocket): void {
    const session: Session = {
      id: randomUUID(),
      ws,
      subscriptions: new Map(),
      counters: new Map(),
    };
    this.sessions.set(session.id, session);
    ws.on('message', (raw, isBinary) => this.onMessage(session, raw, isBinary));
    ws.on('close', () => {
      this.sessions.delete(session.id);
      for (const [id, p] of this.pending)
        if (p.session === session) {
          clearTimeout(p.timer);
          this.pending.delete(id);
        }
      if (session.approval) {
        const a = this.approvals.get(session.approval);
        if (a) clearTimeout(a.timer);
        this.approvals.delete(session.approval);
        this.opts.toHost({ type: 'plugin_approval_cancel', requestId: session.approval });
      }
      if (session.pluginId) {
        this.opts.toHost({
          type: 'plugin_session_end',
          pluginId: session.pluginId,
          session: session.id,
        });
        this.sendState();
      }
    });
  }

  private send(s: Session, m: Envelope): void {
    // Always text frames.
    if (s.ws.readyState === WebSocket.OPEN) s.ws.send(JSON.stringify(m));
  }

  private fail(s: Session, requestID: string, errorID: number, message: string): void {
    this.send(s, errorEnvelope(requestID, errorID, message));
  }

  private onMessage(s: Session, raw: RawData, _isBinary: boolean): void {
    // Binary frames are accepted when they hold UTF-8 text.
    const text = Array.isArray(raw) ? Buffer.concat(raw).toString('utf8') : raw.toString('utf8');
    let m: Record<string, unknown>;
    try {
      const v: unknown = JSON.parse(text);
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
      m = v as Record<string, unknown>;
    } catch {
      return this.fail(s, randomUUID(), E.invalidJson, 'The message is not a JSON object.');
    }
    const given = m.requestID;
    const requestID = given === undefined || given === null ? randomUUID() : given;
    if (!validRequestId(requestID))
      return this.fail(
        s,
        randomUUID(),
        E.invalidRequestId,
        'requestID must be ASCII text of 1 to 64 characters.',
      );
    if (m.apiName !== API_NAME)
      return this.fail(s, requestID, E.wrongApiName, `apiName must be "${API_NAME}".`);
    if (m.apiVersion !== API_VERSION)
      return this.fail(s, requestID, E.wrongApiVersion, `apiVersion must be "${API_VERSION}".`);
    const type = m.messageType;
    if (typeof type !== 'string' || !type)
      return this.fail(s, requestID, E.noMessageType, 'messageType is missing.');
    if (!(REQUEST_TYPES as readonly string[]).includes(type))
      return this.fail(s, requestID, E.unknownMessageType, `Unknown messageType "${type}".`);
    const data =
      m.data && typeof m.data === 'object' && !Array.isArray(m.data)
        ? (m.data as Record<string, unknown>)
        : {};
    if (s.revoked && type !== 'AuthenticationTokenRequest' && type !== 'APIStateRequest')
      return this.fail(
        s,
        requestID,
        E.denied,
        'This plugin’s access was revoked in Mochi Studio. Ask for a new token.',
      );
    if (!s.pluginId && !UNAUTHENTICATED_REQUESTS.has(type))
      return this.fail(
        s,
        requestID,
        E.notAuthenticated,
        'Authenticate first (AuthenticationRequest).',
      );
    if (BRIDGE_REQUESTS.has(type)) return this.answerHere(s, requestID, type, data);
    if (PAGE_REQUESTS.has(type)) return this.askPage(s, requestID, type, data);
    return this.fail(
      s,
      requestID,
      E.unknownMessageType,
      `${type} is not supported by Mochi Studio yet.`,
    );
  }

  // --- requests the bridge answers ------------------------------------------------------

  private answerHere(
    s: Session,
    requestID: string,
    type: string,
    data: Record<string, unknown>,
  ): void {
    const ok = (d: Record<string, unknown>): void =>
      this.send(s, envelope(type.replace(/Request$/, 'Response'), requestID, d));
    switch (type) {
      case 'APIStateRequest':
        return ok({
          active: this.on,
          vTubeStudioVersion: APP_VERSION,
          currentSessionAuthenticated: !!s.pluginId && !s.revoked,
        });
      case 'AuthenticationTokenRequest':
        return this.tokenRequest(s, requestID, data);
      case 'AuthenticationRequest': {
        const token = data.authenticationToken;
        const name = data.pluginName;
        const developer = data.pluginDeveloper;
        if (typeof token !== 'string' || !token)
          return this.fail(s, requestID, E.authTokenMissing, 'authenticationToken is missing.');
        if (typeof name !== 'string' || !name)
          return this.fail(s, requestID, E.authNameMissing, 'pluginName is missing.');
        if (typeof developer !== 'string' || !developer)
          return this.fail(s, requestID, E.authDeveloperMissing, 'pluginDeveloper is missing.');
        const record = this.store.verify(name, developer, token);
        if (!record)
          return ok({
            authenticated: false,
            reason:
              'The token is not valid (it may have been revoked in Mochi Studio). Ask for a new one.',
          });
        s.pluginId = record.id;
        s.revoked = false;
        this.sendState();
        return ok({ authenticated: true, reason: 'Authenticated with Mochi Studio.' });
      }
      case 'PermissionRequest':
        return this.permissionRequest(s, requestID, data, ok);
      case 'VTSFolderInfoRequest':
        return ok({ ...FOLDER_NAMES });
      case 'ParameterCreationRequest':
        return this.createParameter(s, requestID, data, ok);
      case 'ParameterDeletionRequest':
        return this.deleteParameter(s, requestID, data, ok);
      case 'EventSubscriptionRequest':
        return this.subscribe(s, requestID, data, ok);
    }
  }

  private permissionList(pluginId: string): Array<{ name: string; granted: boolean }> {
    return PERMISSIONS.map((p) => ({ name: p, granted: this.store.hasPermission(pluginId, p) }));
  }

  /**
   * PermissionRequest: an empty name lists the permissions; a
   * granted one answers at once; otherwise the person is asked, the way
   * token requests are. Permissions for features Mochi Studio lacks (NDI)
   * are never granted, and nobody is asked about them.
   */
  private permissionRequest(
    s: Session,
    requestID: string,
    data: Record<string, unknown>,
    ok: (d: Record<string, unknown>) => void,
  ): void {
    const pluginId = s.pluginId!;
    const name = data.requestedPermission;
    const reply = (grantSuccess: boolean): void =>
      ok({
        grantSuccess,
        requestedPermission: typeof name === 'string' ? name : '',
        permissions: this.permissionList(pluginId),
      });
    if (name === undefined || name === null || name === '') return reply(false);
    if (typeof name !== 'string' || !(PERMISSIONS as readonly string[]).includes(name))
      return this.fail(s, requestID, E.permissionUnknown, `Unknown permission "${String(name)}".`);
    if (this.store.hasPermission(pluginId, name)) return reply(true);
    if (!GRANTABLE_PERMISSIONS.has(name)) return reply(false);
    if (this.approvals.size || s.approval)
      return this.fail(
        s,
        requestID,
        E.permissionCannotAsk,
        'Mochi Studio is already asking the person something. Try again in a moment.',
      );
    const record = this.store.get(pluginId)!;
    const requestId = randomBytes(8).toString('hex');
    const asked = this.opts.toHost({
      type: 'plugin_approval_request',
      requestId,
      name: record.name,
      developer: record.developer,
      icon: record.icon,
      permission: name,
    });
    if (!asked)
      return this.fail(
        s,
        requestID,
        E.permissionCannotAsk,
        'Mochi Studio is not open, so nobody can answer. Open it and try again.',
      );
    s.approval = requestId;
    this.approvals.set(requestId, {
      session: s,
      requestID,
      name: record.name,
      developer: record.developer,
      icon: record.icon,
      permission: { name, pluginId },
      timer: setTimeout(() => this.approve(requestId, false), APPROVAL_TIMEOUT_S * 1000),
    });
  }

  /** The person takes a permission back in Mochi Studio. */
  setPermission(pluginId: string, permission: string, granted: boolean): void {
    this.store.setPermission(pluginId, permission, granted);
    this.sendState();
  }

  private tokenRequest(s: Session, requestID: string, data: Record<string, unknown>): void {
    const name = data.pluginName;
    const developer = data.pluginDeveloper;
    const icon = data.pluginIcon;
    const len = (v: unknown): boolean => typeof v === 'string' && v.length >= 3 && v.length <= 32;
    if (!len(name))
      return this.fail(s, requestID, E.invalidPluginName, 'pluginName must be 3 to 32 characters.');
    if (!len(developer))
      return this.fail(
        s,
        requestID,
        E.invalidDeveloper,
        'pluginDeveloper must be 3 to 32 characters.',
      );
    if (
      icon !== undefined &&
      icon !== null &&
      icon !== '' &&
      (typeof icon !== 'string' || !validIcon(icon))
    )
      return this.fail(
        s,
        requestID,
        E.invalidIcon,
        'pluginIcon must be a base64 PNG or JPEG of 128 × 128 pixels.',
      );
    if (this.approvals.size)
      return this.fail(
        s,
        requestID,
        E.tokenRequestPending,
        'A token request is already waiting for the person.',
      );
    const requestId = randomBytes(8).toString('hex');
    const iconText = typeof icon === 'string' ? icon : '';
    const asked = this.opts.toHost({
      type: 'plugin_approval_request',
      requestId,
      name: name as string,
      developer: developer as string,
      icon: iconText,
    });
    if (!asked)
      return this.fail(
        s,
        requestID,
        E.internal,
        'Mochi Studio is not open, so nobody can allow the plugin. Open it and try again.',
      );
    s.approval = requestId;
    this.approvals.set(requestId, {
      session: s,
      requestID,
      name: name as string,
      developer: developer as string,
      icon: iconText,
      timer: setTimeout(() => this.approve(requestId, false), APPROVAL_TIMEOUT_S * 1000),
    });
  }

  /** The person's answer to a token request. */
  approve(requestId: string, allow: boolean): void {
    const a = this.approvals.get(requestId);
    if (!a) return;
    clearTimeout(a.timer);
    this.approvals.delete(requestId);
    a.session.approval = undefined;
    if (a.permission) {
      const { name, pluginId } = a.permission;
      if (allow && this.store.get(pluginId)) {
        this.store.setPermission(pluginId, name, true);
        this.opts.log(`Plugin "${a.name}" may now use ${name}.`);
      } else this.opts.toHost({ type: 'plugin_approval_cancel', requestId });
      this.send(
        a.session,
        envelope('PermissionResponse', a.requestID, {
          grantSuccess: allow,
          requestedPermission: name,
          permissions: this.permissionList(pluginId),
        }),
      );
      return this.sendState();
    }
    if (!allow) {
      this.opts.toHost({ type: 'plugin_approval_cancel', requestId });
      return this.fail(a.session, a.requestID, E.denied, 'The person did not allow this plugin.');
    }
    const { token, record } = this.store.allow(a.name, a.developer, a.icon);
    this.opts.log(`Plugin "${record.name}" by ${record.developer} allowed.`);
    this.send(
      a.session,
      envelope('AuthenticationTokenResponse', a.requestID, { authenticationToken: token }),
    );
    this.sendState();
  }

  /** Revoked by the person: the plugin's sessions get error 50 from now on. */
  revoke(pluginId: string): void {
    const r = this.store.get(pluginId);
    if (!this.store.revoke(pluginId)) return;
    for (const s of this.sessions.values())
      if (s.pluginId === pluginId) {
        s.revoked = true;
        s.subscriptions.clear();
        this.opts.toHost({ type: 'plugin_session_end', pluginId, session: s.id });
      }
    this.opts.log(`Plugin "${r?.name}" revoked.`);
    this.sendState();
  }

  setTrackingData(pluginId: string, on: boolean): void {
    this.store.setTrackingData(pluginId, on);
    this.sendState();
  }

  private createParameter(
    s: Session,
    requestID: string,
    data: Record<string, unknown>,
    ok: (d: Record<string, unknown>) => void,
  ): void {
    const name = data.parameterName;
    if (!validCustomName(name))
      return this.fail(
        s,
        requestID,
        E.paramInvalidName,
        'parameterName must be 4 to 32 letters and digits, without spaces.',
      );
    if (isDefaultParameterName(name))
      return this.fail(s, requestID, E.paramDefaultName, `"${name}" is a default parameter.`);
    const explanation = data.explanation ?? '';
    if (typeof explanation !== 'string' || explanation.length >= 256)
      return this.fail(
        s,
        requestID,
        E.paramExplanationTooLong,
        'explanation must be under 256 characters.',
      );
    const { min, max, defaultValue } = data;
    if (
      !validParameterNumber(min) ||
      !validParameterNumber(max) ||
      !validParameterNumber(defaultValue)
    )
      return this.fail(
        s,
        requestID,
        E.paramInvalidValues,
        'min, max and defaultValue must be numbers from -1000000 to 1000000.',
      );
    const all = this.store.parameters();
    const existing = all.find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (existing && existing.pluginId !== s.pluginId)
      return this.fail(
        s,
        requestID,
        E.paramOtherPlugin,
        `"${name}" belongs to the plugin ${existing.pluginName}.`,
      );
    if (!existing) {
      if (all.filter((p) => p.pluginId === s.pluginId).length >= MAX_CUSTOM_PER_PLUGIN)
        return this.fail(
          s,
          requestID,
          E.paramPluginLimit,
          `A plugin can create at most ${MAX_CUSTOM_PER_PLUGIN} parameters.`,
        );
      if (all.length >= MAX_CUSTOM_TOTAL)
        return this.fail(
          s,
          requestID,
          E.paramTotalLimit,
          `There can be at most ${MAX_CUSTOM_TOTAL} custom parameters.`,
        );
    }
    this.store.setParameter(s.pluginId!, {
      name: existing?.name ?? name,
      explanation,
      min,
      max,
      defaultValue,
    });
    // The page learns of it before any later request (one ordered connection).
    this.sendState();
    ok({ parameterName: existing?.name ?? name });
  }

  private deleteParameter(
    s: Session,
    requestID: string,
    data: Record<string, unknown>,
    ok: (d: Record<string, unknown>) => void,
  ): void {
    const name = data.parameterName;
    if (typeof name !== 'string' || !name)
      return this.fail(s, requestID, E.deleteInvalidName, 'parameterName is missing.');
    if (isDefaultParameterName(name))
      return this.fail(s, requestID, E.deleteDefault, 'Default parameters cannot be deleted.');
    const p = this.store.parameters().find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!p) return this.fail(s, requestID, E.deleteNotFound, `No custom parameter "${name}".`);
    if (p.pluginId !== s.pluginId)
      return this.fail(
        s,
        requestID,
        E.deleteOtherPlugin,
        `"${name}" belongs to the plugin ${p.pluginName}.`,
      );
    this.store.deleteParameter(s.pluginId!, p.name);
    this.sendState();
    ok({ parameterName: p.name });
  }

  // --- events -------------------------------------------------------------

  private subscribe(
    s: Session,
    requestID: string,
    data: Record<string, unknown>,
    ok: (d: Record<string, unknown>) => void,
  ): void {
    const name = data.eventName;
    const on = data.subscribe === true;
    const reply = (): void =>
      ok({
        subscribedEventCount: s.subscriptions.size,
        subscribedEvents: [...s.subscriptions.keys()],
      });
    if (!on && (name === undefined || name === null || name === '')) {
      s.subscriptions.clear();
      reply();
      return this.sendState();
    }
    if (typeof name !== 'string' || !(EVENT_NAMES as readonly string[]).includes(name))
      return this.fail(s, requestID, E.unknownEvent, `Unknown event "${String(name)}".`);
    if (!on) {
      s.subscriptions.delete(name);
      reply();
      return this.sendState();
    }
    const config =
      data.config && typeof data.config === 'object' && !Array.isArray(data.config)
        ? (data.config as Record<string, unknown>)
        : {};
    if (name === 'TestEvent') {
      const t = config.testMessageForEvent;
      if (t !== undefined && (typeof t !== 'string' || t.length > 32))
        return this.fail(
          s,
          requestID,
          E.eventTestMessageTooLong,
          'testMessageForEvent must be at most 32 characters.',
        );
    }
    if (name === 'ModelLoadedEvent' && config.modelID !== undefined) {
      const ids = config.modelID;
      if (
        !Array.isArray(ids) ||
        ids.some((x) => typeof x !== 'string' || !/^[0-9a-fA-F]{32}$/.test(x))
      )
        return this.fail(
          s,
          requestID,
          E.eventInvalidModelId,
          'modelID must be a list of model IDs (32 hexadecimal characters).',
        );
    }
    if (
      name === 'HotkeyTriggeredEvent' &&
      config.onlyForAction !== undefined &&
      config.onlyForAction !== ''
    ) {
      if (!(HOTKEY_TYPES as readonly string[]).includes(String(config.onlyForAction)))
        return this.fail(
          s,
          requestID,
          E.eventInvalidHotkeyAction,
          `Unknown hotkey type "${String(config.onlyForAction)}".`,
        );
    }
    const configError = betaConfigError(name, config);
    if (configError) return this.fail(s, requestID, configError.errorID, configError.message);
    s.subscriptions.set(name, config);
    s.counters.set(name, 0);
    reply();
    // Mochi Studio has no editor connection: one event, never connected.
    if (name === 'Live2DCubismEditorConnectedEvent')
      this.send(
        s,
        envelope(name, randomUUID(), {
          tryingToConnect: false,
          connected: false,
          shouldSendParameters: false,
        }),
      );
    // ExpressionToggledEvent: the full state at once, when asked (off ones included).
    // Only the snapshot sent because a model loaded says `justLoaded: true`.
    if (
      name === 'ExpressionToggledEvent' &&
      config.sendAllActiveStatesOnSubscription === true &&
      this.expressions
    )
      for (const e of this.expressions.expressions)
        this.send(
          s,
          envelope(name, randomUUID(), {
            modelID: this.expressions.modelID,
            modelName: this.expressions.modelName,
            isLive2DItem: false,
            itemInstanceID: '',
            justLoaded: false,
            ...e,
          }),
        );
    // ModelMovedEvent: once right after subscribing, while a model is loaded.
    if (name === 'ModelMovedEvent' && this.lastModelMoved)
      this.send(s, envelope(name, randomUUID(), this.lastModelMoved));
    this.sendState();
  }

  private testEvents(): void {
    const counter = Math.floor((Date.now() - this.started) / 1000);
    for (const s of this.sessions.values()) {
      const c = s.subscriptions.get('TestEvent');
      if (!c) continue;
      this.send(
        s,
        envelope('TestEvent', randomUUID(), {
          yourTestMessage: typeof c.testMessageForEvent === 'string' ? c.testMessageForEvent : '',
          counter,
        }),
      );
    }
  }

  /** An event from the page, for each subscribed session whose config lets it through. */
  event(name: string, data: Record<string, unknown>, session?: string): void {
    if (name === 'ModelMovedEvent') this.lastModelMoved = data;
    if (name === 'ModelLoadedEvent' && data.modelLoaded === false) this.lastModelMoved = undefined;
    for (const s of this.sessions.values()) {
      if (session !== undefined && s.id !== session) continue;
      const c = s.subscriptions.get(name);
      if (!c || !s.pluginId || s.revoked || !passes(name, c, data)) continue;
      if (PER_SESSION_EVENTS.has(name)) {
        const n = s.counters.get(name) ?? 0;
        s.counters.set(name, n + 1);
        this.send(s, envelope(name, randomUUID(), { ...data, eventCounter: n }));
      } else this.send(s, envelope(name, randomUUID(), data));
    }
  }

  /** The page's list of the model's expressions (for the snapshot on subscribing). */
  setExpressions(m: Extract<HostToBridgeMessage, { type: 'plugin_expressions' }>): void {
    this.expressions = m;
  }

  // --- requests the page answers ----------------------------------------------------------

  private askPage(
    s: Session,
    requestID: string,
    type: string,
    data: Record<string, unknown>,
  ): void {
    const record = this.store.get(s.pluginId!);
    if (!record) return this.fail(s, requestID, E.denied, 'This plugin is no longer allowed.');
    const id = randomBytes(8).toString('hex');
    const sent = this.opts.toHost({
      type: 'plugin_request',
      id,
      plugin: {
        id: record.id,
        name: record.name,
        trackingData: record.trackingData,
        permissions: record.permissions ?? [],
        session: s.id,
      },
      messageType: type,
      data,
    });
    if (!sent)
      return this.fail(
        s,
        requestID,
        E.internal,
        'Mochi Studio is not connected to its bridge. Open Mochi Studio.',
      );
    this.pending.set(id, {
      session: s,
      requestID,
      messageType: type,
      timer: setTimeout(
        () => {
          this.pending.delete(id);
          this.fail(s, requestID, E.internal, `Mochi Studio did not answer ${type} in time.`);
        },
        (WAITING_REQUESTS.has(type) ? APPROVAL_TIMEOUT_S : this.opts.answerTimeoutS) * 1000,
      ),
    });
  }

  /** The page's answer to a forwarded request. */
  answer(
    id: string,
    a: { data?: Record<string, unknown>; errorID?: number; message?: string },
  ): void {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    if (typeof a.errorID === 'number')
      return this.fail(p.session, p.requestID, a.errorID, a.message ?? 'The request failed.');
    this.send(
      p.session,
      envelope(p.messageType.replace(/Request$/, 'Response'), p.requestID, a.data ?? {}),
    );
  }

  /** The page went away: forwarded requests fail now rather than at their timeout. */
  hostGone(): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      this.fail(p.session, p.requestID, E.internal, 'Mochi Studio disconnected.');
      this.pending.delete(id);
    }
    for (const [id, a] of this.approvals) {
      clearTimeout(a.timer);
      a.session.approval = undefined;
      this.fail(
        a.session,
        a.requestID,
        E.denied,
        'Mochi Studio closed before the plugin was allowed.',
      );
      this.approvals.delete(id);
    }
  }
}

/** Whether an event passes a subscription's config. */
export function passes(
  name: string,
  c: Record<string, unknown>,
  d: Record<string, unknown>,
): boolean {
  switch (name) {
    case 'ModelLoadedEvent': {
      const ids = Array.isArray(c.modelID) ? (c.modelID as string[]) : [];
      return !ids.length || ids.some((x) => x.toLowerCase() === String(d.modelID).toLowerCase());
    }
    case 'HotkeyTriggeredEvent':
      if (
        typeof c.onlyForAction === 'string' &&
        c.onlyForAction &&
        c.onlyForAction !== d.hotkeyAction
      )
        return false;
      return !(c.ignoreHotkeysTriggeredByAPI === true && d.hotkeyTriggeredByAPI === true);
    case 'ModelAnimationEvent':
      if (c.ignoreLive2DItems === true && d.isLive2DItem === true) return false;
      return !(c.ignoreIdleAnimations === true && d.isIdleAnimation === true);
    case 'ModelClickedEvent':
      return !(c.onlyClicksOnModel === true && d.modelWasClicked !== true);
    case 'ExpressionToggledEvent':
      return !(c.ignoreLive2DItems === true && d.isLive2DItem === true);
    case 'ItemEvent': {
      const ids = Array.isArray(c.itemInstanceIDs) ? (c.itemInstanceIDs as string[]) : [];
      const files = Array.isArray(c.itemFileNames) ? (c.itemFileNames as string[]) : [];
      if (!ids.length && !files.length) return true;
      return (
        ids.includes(String(d.itemInstanceID)) ||
        files.some((f) => String(d.itemFileName).includes(f))
      );
    }
    default:
      return true;
  }
}

/** The beta events' configs: their documented errors, or undefined. */
export function betaConfigError(
  name: string,
  c: Record<string, unknown>,
): { errorID: number; message: string } | undefined {
  const freq = (lo: number, hi: number): boolean =>
    typeof c.frequency === 'number' && c.frequency >= lo && c.frequency <= hi;
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  if (name === 'ArtMeshTrackingEvent') {
    if (c.frequency !== undefined && !freq(1, 60))
      return {
        errorID: E.eventInvalidTrackingFrequency,
        message: 'frequency must be 1 to 60 events per second.',
      };
    const pts = c.trackingPoints;
    const bad = { errorID: E.eventInvalidTrackingPoints, message: '' };
    if (!Array.isArray(pts) || pts.length < 1 || pts.length > 500)
      return { ...bad, message: 'trackingPoints must list 1 to 500 points.' };
    const ids = new Set<string>();
    for (const p of pts as Array<Record<string, unknown>>) {
      const id = p?.trackingPointID;
      const a = (p?.artMeshCoords ?? {}) as Record<string, unknown>;
      const v = [a.vertexID1, a.vertexID2, a.vertexID3];
      const w = [a.vertexWeight1, a.vertexWeight2, a.vertexWeight3];
      if (typeof id !== 'string' || !id || id.length > 128 || ids.has(id))
        return { ...bad, message: 'Each trackingPointID must be unique, 1 to 128 characters.' };
      ids.add(id);
      if (typeof a.artMeshID !== 'string' || !a.artMeshID)
        return { ...bad, message: `Point "${id}" names no art mesh.` };
      if (v.some((x) => !Number.isInteger(x) || (x as number) < 0))
        return { ...bad, message: `Point "${id}": vertex IDs must be whole numbers from 0.` };
      if (w.some((x) => !num(x)) || Math.abs((w as number[]).reduce((s, x) => s + x, 0) - 1) > 0.01)
        return { ...bad, message: `Point "${id}": the weights must add up to 1.` };
      if (a.size !== undefined && !(num(a.size) && a.size > 0 && a.size <= 10000))
        return { ...bad, message: `Point "${id}": size must be above 0, at most 10000.` };
    }
  }
  if (name === 'ArtMeshOutlineEvent') {
    if (c.frequency !== undefined && !freq(1, 30))
      return {
        errorID: E.eventInvalidOutlineFrequency,
        message: 'frequency must be 1 to 30 events per second.',
      };
    const list = c.artMeshes;
    const bad = { errorID: E.eventInvalidOutlineMeshes, message: '' };
    if (!Array.isArray(list) || list.length < 1 || list.length > 100)
      return { ...bad, message: 'artMeshes must list 1 to 100 art meshes.' };
    const seen = new Set<string>();
    for (const m of list as Array<Record<string, unknown>>) {
      if (typeof m?.artMeshID !== 'string' || !m.artMeshID)
        return { ...bad, message: 'Each entry needs an artMeshID.' };
      const key = `${String(m.modelID ?? '')}/${m.artMeshID}`;
      if (seen.has(key)) return { ...bad, message: `${m.artMeshID} is listed twice.` };
      seen.add(key);
    }
  }
  return undefined;
}

function listen(s: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (e: Error): void => reject(e);
    s.once('error', onError);
    s.listen(port, host, () => {
      s.off('error', onError);
      resolve();
    });
  });
}
