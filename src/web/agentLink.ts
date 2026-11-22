/**
 * The page's side of the bridge protocol (src/core/bridgeProtocol.ts): the
 * Mochi Studio page connects to the local bridge as its host, runs the
 * commands agents send through the command layer, and sends events. It is
 * off until the user turns agent access on.
 *
 * Privacy: only command results and the events below leave the page. None
 * of them carries camera or microphone data.
 */
import {
  API_EVENTS,
  DEFAULT_PORT,
  FILE_CHUNK_BYTES,
  PROTOCOL_VERSION,
  decodeSync,
  encodeFileChunk,
  encodeSync,
  type BridgeToHost,
  type ClientInfo,
  type HostToBridge,
  type ScopeName,
  type TokenInfo,
} from '../core/bridgeProtocol';
import { CommandError, type Scope } from '../core/commands/registry';
import { Emitter } from '../core/events';
import type { SyncMessage, SyncTransport } from '../core/sync';
import type { BridgeToHostPlugin, HostToBridgePlugin } from '../core/plugins/protocol';
import type { BridgeToHostPhone, HostToBridgePhone } from '../core/phoneProtocol';
import type { Studio } from './studio';

export type LinkState =
  | 'off'
  | 'connecting'
  | 'pairing'
  | 'connected'
  | 'unreachable'
  /** Another Mochi Studio window took over the bridge. */
  | 'replaced';

export type LinkEvents = {
  state: { state: LinkState; message?: string };
  clients: { clients: ClientInfo[] };
  uploads: { pending: number };
  /** A message of the plugin API (src/core/plugins/protocol.ts). */
  plugin: BridgeToHostPlugin;
  /** A message of the phone tracker (src/core/phoneProtocol.ts). */
  phone: BridgeToHostPhone;
};

const HOST_TOKEN_KEY = 'mochi-studio.bridge.hostToken';
const URL_KEY = 'mochi-studio.bridge.url';
const ENABLED_KEY = 'mochi-studio.bridge.enabled';
const VIEWS_KEY = 'mochi-studio.bridge.views';
const PLUGINS_KEY = 'mochi-studio.bridge.plugins';
const PHONE_KEY = 'mochi-studio.bridge.phone';
const VIEW_KEY_KEY = 'mochi-studio.bridge.viewKey';

const storage = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string | null): void {
    try {
      if (v === null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch {
      /* storage unavailable */
    }
  },
};

export const DEFAULT_BRIDGE_URL = `ws://127.0.0.1:${DEFAULT_PORT}`;

/**
 * In the desktop app, the bridge runs in the app and serves this page: the
 * page is paired by the app (`#host=<token>`), the bridge is at the page's
 * own address, and output views through the bridge are on.
 */
export function desktopMode(): { bridgeUrl: string } | undefined {
  if (typeof location === 'undefined') return undefined;
  if (!new URLSearchParams(location.search).has('desktop')) return undefined;
  const token = new URLSearchParams(location.hash.slice(1)).get('host');
  if (token) {
    storage.set(HOST_TOKEN_KEY, token);
    history.replaceState(null, '', location.pathname + location.search);
  }
  return { bridgeUrl: `ws://${location.host}` };
}

/**
 * The output views' side of Studio's sync transport, carried by the bridge.
 * `AgentLink` connects it while output views through the bridge are on.
 */
export class BridgeViewTransport implements SyncTransport {
  private handlers = new Set<(m: SyncMessage) => void>();
  /** Set by AgentLink. */
  sender: ((m: SyncMessage) => void) | undefined;
  post(m: SyncMessage): void {
    this.sender?.(m);
  }
  onMessage(fn: (m: SyncMessage) => void): () => void {
    this.handlers.add(fn);
    return () => this.handlers.delete(fn);
  }
  /** Views that reached this window through the bridge (OBS, the desktop app's address). */
  readonly viewIds = new Set<string>();
  deliver(m: SyncMessage): void {
    if (m.type === 'hello' || m.type === 'viewStatus') this.viewIds.add(m.viewId);
    else if (m.type === 'bye') this.viewIds.delete(m.viewId);
    for (const h of this.handlers) h(m);
  }
  close(): void {
    this.handlers.clear();
  }
}

/** Over the bridge, file contents are served on request instead of sent. */
function toRemote(m: SyncMessage): SyncMessage {
  if (m.type === 'model')
    return {
      type: 'modelRemote',
      key: m.key,
      label: m.label,
      paths: m.files.map(([p]) => p),
      sizes: m.files.map(([, d]) => d.length),
    };
  if (m.type === 'items')
    return {
      type: 'itemsRemote',
      items: m.items.map((i) => ({
        id: i.id,
        label: i.label,
        visible: i.visible,
        paths: i.files.map(([p]) => p),
        sizes: i.files.map(([, d]) => d.length),
      })),
    };
  return m;
}

export class AgentLink {
  readonly events = new Emitter<LinkEvents>();
  state: LinkState = 'off';
  message = '';
  clients: ClientInfo[] = [];
  url = storage.get(URL_KEY) ?? DEFAULT_BRIDGE_URL;
  private ws: WebSocket | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private retryMs = 1000;
  private requests = new Map<string, (m: BridgeToHost) => void>();
  private seq = 0;
  private unsubscribe: Array<() => void> = [];
  /** Agent access: agents may connect and run commands. */
  agentsOn = false;
  /** Output views through the bridge (for OBS). */
  viewsOn = false;
  /** The plugin server for plugins made for VTube Studio (off by default). */
  pluginsOn = false;
  /** The phone tracker on the local network (off by default). */
  phoneOn = false;
  /** View ids of the output views on the bridge. */
  private bridgeViews = new Set<string>();

  constructor(
    private studio: Studio,
    private views: BridgeViewTransport = new BridgeViewTransport(),
  ) {
    // Upload as soon as files are opened, before the model is loaded and drawn.
    studio.events.on('modelFiles', ({ key, files, disk }) => {
      if (this.state !== 'connected') return;
      if (disk) {
        // Opened from disk in the desktop app: the bridge reads it there.
        this.send({ type: 'disk_source', scope: 'model', owner: key, ...disk });
        for (const [path] of files) this.uploaded.add(this.relOf('model', key, path));
        return;
      }
      this.upload('model', key, files);
    });
    views.sender = (m) => {
      if (this.state !== 'connected' || !this.viewsOn) return;
      this.send({ type: 'sync', message: encodeSync(toRemote(m)) });
      // Upload the files once, so views read them from the bridge's memory.
      if (m.type === 'model') this.upload('model', m.key, m.files);
      else if (m.type === 'items') for (const i of m.items) this.upload('item', i.id, i.files);
    };
  }

  /** Agent access was on when the page was last closed. */
  get rememberedOn(): boolean {
    return storage.get(ENABLED_KEY) === '1';
  }
  /** Output views through the bridge were on when the page was last closed. */
  get rememberedViewsOn(): boolean {
    return storage.get(VIEWS_KEY) === '1';
  }
  /** The plugin server was on when the page was last closed. */
  get rememberedPluginsOn(): boolean {
    return storage.get(PLUGINS_KEY) === '1';
  }

  /** The phone tracker was on when the page was last closed. */
  get rememberedPhoneOn(): boolean {
    return storage.get(PHONE_KEY) === '1';
  }

  /** Switches the bridge's phone tracker on (connects to the bridge if needed). */
  enablePhone(url = this.url): void {
    this.phoneOn = true;
    storage.set(PHONE_KEY, '1');
    this.setUrl(url);
    if (this.state === 'connected') this.sendPhone({ type: 'phone_options', on: true });
    else if (!this.ws || this.state === 'replaced') this.connect();
  }

  disablePhone(): void {
    this.phoneOn = false;
    storage.set(PHONE_KEY, null);
    this.sendPhone({ type: 'phone_options', on: false });
    this.stopIfUnused();
  }

  /** Sends a phone tracker message to the bridge. */
  sendPhone(m: HostToBridgePhone): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  /** Switches the bridge's plugin server on (connects to the bridge if needed). */
  enablePlugins(url = this.url): void {
    this.pluginsOn = true;
    storage.set(PLUGINS_KEY, '1');
    this.setUrl(url);
    if (this.state === 'connected') this.sendPlugin({ type: 'plugins_options', on: true });
    else if (!this.ws || this.state === 'replaced') this.connect();
  }

  disablePlugins(): void {
    this.pluginsOn = false;
    storage.set(PLUGINS_KEY, null);
    this.sendPlugin({ type: 'plugins_options', on: false });
    this.stopIfUnused();
  }

  /** Sends a plugin API message to the bridge. */
  sendPlugin(m: HostToBridgePlugin): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  private setUrl(url: string): void {
    const u = url.replace(/\/+$/, '');
    if (u !== this.url && this.ws) {
      this.url = u;
      this.connect();
    }
    this.url = u;
    storage.set(URL_KEY, this.url);
  }

  /** Turns agent access on (connects to the bridge if needed). */
  enable(url = this.url): void {
    this.agentsOn = true;
    storage.set(ENABLED_KEY, '1');
    this.setUrl(url);
    if (this.ws && this.state === 'connected') this.send({ type: 'host_options', agents: true });
    else if (!this.ws || this.state === 'replaced') this.connect();
  }

  /** Turns agent access off. Stays connected while output views use the bridge. */
  disable(): void {
    this.agentsOn = false;
    storage.set(ENABLED_KEY, null);
    this.send({ type: 'host_options', agents: false });
    this.setClients([]);
    this.stopIfUnused();
  }

  /** Output views through the bridge on (for OBS). */
  enableViews(url = this.url): void {
    this.viewsOn = true;
    storage.set(VIEWS_KEY, '1');
    this.setUrl(url);
    if (!this.ws || this.state === 'replaced') this.connect();
    else if (this.state === 'connected') {
      this.studio.resendToViews();
      this.events.emit('state', { state: this.state, message: this.message });
    }
  }

  disableViews(): void {
    this.viewsOn = false;
    storage.set(VIEWS_KEY, null);
    this.dropBridgeViews();
    this.stopIfUnused();
    this.events.emit('state', { state: this.state, message: this.message });
  }

  private stopIfUnused(): void {
    if (this.agentsOn || this.viewsOn || this.pluginsOn || this.phoneOn) return;
    if (this.retry) clearTimeout(this.retry);
    this.retry = undefined;
    const ws = this.ws;
    this.ws = undefined;
    ws?.close();
    this.detachEvents();
    this.setClients([]);
    this.setState('off');
  }

  /** Files the bridge has (it forgets them when the connection ends). */
  private uploaded = new Set<string>();
  private uploads: Array<{ rel: string; run: () => Promise<void> }> = [];
  /** Uploads under way, by path. */
  private inFlight = new Set<string>();
  /** Files of the current model and items, by upload path (to upload one on request). */
  private uploadable = new Map<string, () => Promise<void>>();
  private uploading = 0;
  /** Upload progress for output views (shown in the Output tab). */
  readonly uploadStats = { queuedBytes: 0, sentBytes: 0, skippedBytes: 0, ms: 0, requests: 0 };
  private uploadStart = 0;

  /**
   * Uploads files for output views to the bridge, one at a time (measured:
   * parallel uploads from a page are slower), each once. The bridge then
   * serves views from memory, which is fast. A file the bridge kept from
   * before a reload is skipped (HEAD). A view that asks before a file is
   * uploaded waits for it; one that asks for a file not being uploaded gets
   * it from the page over the WebSocket.
   */
  upload(scope: 'model' | 'item', owner: string, files: Array<[string, Uint8Array]>): void {
    const token = storage.get(HOST_TOKEN_KEY);
    if (!token || !this.viewsOn) return;
    const base = this.url.replace(/^ws/, 'http');
    const worker = this.uploadWorker(base, token);
    if (worker) {
      const jobs: Array<{ rel: string; blob: Blob }> = [];
      for (const [path, bytes] of files) {
        const rel = this.relOf(scope, owner, path);
        if (this.uploaded.has(rel)) continue;
        this.uploaded.add(rel);
        this.uploadStats.queuedBytes += bytes.length;
        const blob = new Blob([bytes as Uint8Array<ArrayBuffer>]);
        this.workerFiles.set(rel, blob);
        this.workerPending.add(rel);
        jobs.push({ rel, blob });
      }
      if (jobs.length) {
        if (!this.uploadStart) this.uploadStart = performance.now();
        worker.postMessage({ type: 'add', jobs });
        this.events.emit('uploads', { pending: this.pendingUploads });
      }
      return;
    }
    for (const [path, bytes] of files) {
      const rel = `${scope}/${encodeURIComponent(owner)}/${path.split('/').map(encodeURIComponent).join('/')}`;
      if (this.uploaded.has(rel)) continue;
      this.uploaded.add(rel);
      const url = `${base}/upload/${rel}`;
      this.uploadStats.queuedBytes += bytes.length;
      const headers = { authorization: `Bearer ${token}` };
      const run = async (): Promise<void> => {
        try {
          const have = await fetch(url, { method: 'HEAD', headers });
          if (have.ok && Number(have.headers.get('content-length')) === bytes.length) {
            this.uploadStats.skippedBytes += bytes.length;
            return;
          }
          const r = await fetch(url, {
            method: 'PUT',
            headers,
            body: new Blob([bytes as Uint8Array<ArrayBuffer>]),
          });
          if (!r.ok) this.uploaded.delete(rel);
          else this.uploadStats.sentBytes += bytes.length;
        } catch {
          this.uploaded.delete(rel);
        }
      };
      this.uploadable.set(rel, run);
      this.uploads.push({ rel, run });
    }
    this.pump();
  }

  /** Files still to upload for output views. */
  get pendingUploads(): number {
    return this.uploads.length + this.uploading + this.workerPending.size;
  }

  private relOf(scope: 'model' | 'item', owner: string, path: string): string {
    return `${scope}/${encodeURIComponent(owner)}/${path.split('/').map(encodeURIComponent).join('/')}`;
  }

  // Uploads run in a worker, so a busy main thread (loading and drawing a
  // large model) does not hold them up. `?uploadInPage` keeps them on the
  // page, to compare.
  private worker: Worker | undefined | null;
  private workerConfig = '';
  private workerFiles = new Map<string, Blob>();
  private workerPending = new Set<string>();

  private uploadWorker(base: string, token: string): Worker | undefined {
    if (this.worker === null) return undefined;
    if (!this.worker) {
      if (
        typeof Worker === 'undefined' ||
        new URLSearchParams(location.search).has('uploadInPage')
      ) {
        this.worker = null;
        return undefined;
      }
      try {
        this.worker = new Worker(new URL('./uploadWorker.ts', import.meta.url), { type: 'module' });
      } catch {
        this.worker = null;
        return undefined;
      }
      this.worker.onmessage = (
        e: MessageEvent<{ rel: string; ok: boolean; sent: number; skipped: number }>,
      ) => {
        const m = e.data;
        this.workerPending.delete(m.rel);
        if (!m.ok) this.uploaded.delete(m.rel);
        // The bridge has it: its copy of the bytes goes (a view's request makes another).
        else this.workerFiles.delete(m.rel);
        this.uploadStats.sentBytes += m.sent;
        this.uploadStats.skippedBytes += m.skipped;
        this.uploadStats.ms = Math.round(performance.now() - this.uploadStart);
        if (!this.workerPending.size) this.uploadStart = 0;
        this.events.emit('uploads', { pending: this.pendingUploads });
      };
    }
    const config = `${base} ${token}`;
    if (config !== this.workerConfig) {
      this.workerConfig = config;
      this.worker.postMessage({ type: 'config', base, token });
    }
    return this.worker;
  }

  private pump(): void {
    if (!this.uploading && this.uploads.length && !this.uploadStart)
      this.uploadStart = performance.now();
    while (this.uploading < 1 && this.uploads.length) {
      const job = this.uploads.shift()!;
      this.uploading++;
      this.inFlight.add(job.rel);
      void job.run().finally(() => {
        this.uploading--;
        this.inFlight.delete(job.rel);
        this.uploadStats.ms = Math.round(performance.now() - this.uploadStart);
        if (!this.uploads.length && !this.uploading) this.uploadStart = 0;
        this.pump();
        this.events.emit('uploads', { pending: this.uploads.length + this.uploading });
      });
    }
  }

  /** Output views on the bridge are gone: tell Studio. */
  private dropBridgeViews(): void {
    for (const viewId of this.bridgeViews) this.views.deliver({ type: 'bye', viewId });
    this.bridgeViews.clear();
  }

  /** The bridge's HTTP address and this page's host token, for reading folders on disk (desktop). */
  get diskAccess(): { http: string; token: string } | undefined {
    const token = storage.get(HOST_TOKEN_KEY);
    return this.state === 'connected' && token
      ? { http: this.url.replace(/^ws/, 'http'), token }
      : undefined;
  }

  /**
   * The address of an output view through the bridge (an OBS browser
   * source): output.html with the bridge's address and the view key.
   */
  async viewUrl(base: string, renew = false): Promise<string> {
    let key = renew ? null : storage.get(VIEW_KEY_KEY);
    if (!key) {
      const m = await this.request({ type: 'view_key', requestId: '', renew: true });
      if (m.type !== 'view_key' || !m.key) throw new Error('The bridge did not give a view key.');
      key = m.key;
      storage.set(VIEW_KEY_KEY, key);
    }
    const u = new URL('output.html', base);
    u.searchParams.set('bridge', this.url);
    u.searchParams.set('view', key);
    return u.href;
  }

  /** Sends the pairing code the bridge shows. */
  pair(code: string): void {
    this.send({ type: 'pair', code: code.trim() });
  }

  /** Forgets this page's pairing (the bridge then asks for a code again). */
  forgetPairing(): void {
    storage.set(HOST_TOKEN_KEY, null);
  }

  createToken(name: string, scopes: ScopeName[]): Promise<{ token: string; info: TokenInfo }> {
    return this.request({ type: 'token_create', requestId: '', name, scopes }).then((m) => {
      if (m.type !== 'token_created') throw new Error('The bridge did not create the token.');
      return { token: m.token, info: m.info };
    });
  }
  listTokens(): Promise<TokenInfo[]> {
    return this.request({ type: 'token_list', requestId: '' }).then((m) =>
      m.type === 'tokens' ? m.tokens : [],
    );
  }
  revokeToken(id: string): Promise<void> {
    return this.request({ type: 'token_revoke', requestId: '', id }).then(() => undefined);
  }

  // --- the connection ------------------------------------------------------------

  private setState(state: LinkState, message = ''): void {
    this.state = state;
    this.message = message;
    this.events.emit('state', { state, message });
  }

  private setClients(clients: ClientInfo[]): void {
    this.clients = clients;
    this.studio.agents = clients.map((c) => ({ name: c.name, scopes: c.scopes }));
    this.events.emit('clients', { clients });
  }

  private connect(): void {
    if (this.retry) clearTimeout(this.retry);
    this.ws?.close();
    this.setState('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${this.url}/host`);
    } catch (e) {
      this.setState('unreachable', (e as Error).message);
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.retryMs = 1000;
      this.send({
        type: 'host_hello',
        protocol: PROTOCOL_VERSION,
        app: 'mochi-studio',
        version: '0.1.0',
        ...(storage.get(HOST_TOKEN_KEY) ? { hostToken: storage.get(HOST_TOKEN_KEY)! } : {}),
      });
    };
    ws.onmessage = (e) => {
      let m: BridgeToHost;
      try {
        m = JSON.parse(String(e.data)) as BridgeToHost;
      } catch {
        return;
      }
      void this.onMessage(m);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      this.detachEvents();
      this.setClients([]);
      this.dropBridgeViews();
      this.uploaded.clear();
      this.uploads = [];
      this.uploadable.clear();
      this.workerFiles.clear();
      this.workerPending.clear();
      this.worker?.postMessage({ type: 'clear' });
      if (ev.code === 4000)
        return this.setState(
          'replaced',
          'Another Mochi Studio window took over the bridge: agents and output views now follow that window. Turn agent access or bridge views on here again to take it back.',
        );
      if (!this.agentsOn && !this.viewsOn && !this.pluginsOn) return this.setState('off');
      this.setState(
        'unreachable',
        `No bridge at ${this.url}. Start it in a terminal with "npm run bridge" (or mochi-studio-bridge) and leave it running; if it runs, check that this address matches the one it printed. Retrying…`,
      );
      this.retry = setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(15_000, this.retryMs * 2);
    };
  }

  private send(m: HostToBridge): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  private request(m: HostToBridge & { requestId: string }): Promise<BridgeToHost> {
    if (this.state !== 'connected')
      return Promise.reject(new Error('Not connected to the bridge.'));
    const requestId = `r${++this.seq}`;
    return new Promise((resolve) => {
      this.requests.set(requestId, resolve);
      this.send({ ...m, requestId } as HostToBridge);
    });
  }

  private async onMessage(m: BridgeToHost): Promise<void> {
    const t = (m as { type: string }).type;
    if (t === 'plugins' || t.startsWith('plugin_'))
      return void this.events.emit('plugin', m as unknown as BridgeToHostPlugin);
    if (t.startsWith('phone_'))
      return void this.events.emit('phone', m as unknown as BridgeToHostPhone);
    switch (m.type) {
      case 'pair_required':
        storage.set(HOST_TOKEN_KEY, null);
        return this.setState('pairing', m.message);
      case 'pair_failed':
        return this.setState('pairing', m.message);
      case 'paired':
        storage.set(HOST_TOKEN_KEY, m.hostToken);
        return;
      case 'host_welcome':
        this.send({ type: 'host_options', agents: this.agentsOn });
        this.sendPlugin({ type: 'plugins_options', on: this.pluginsOn });
        this.sendPhone({ type: 'phone_options', on: this.phoneOn });
        this.setState('connected', `Connected to the bridge on port ${m.bridge.port}.`);
        // Upload the model for views now, before any view asks for it.
        if (this.viewsOn) this.studio.resendToViews();
        this.send({
          type: 'catalog',
          commands: this.studio.commands.catalog(),
          events: [...API_EVENTS],
        });
        this.attachEvents();
        return;
      case 'clients':
        return this.setClients(this.agentsOn ? m.clients : []);
      case 'sync': {
        const msg = decodeSync(m.message) as SyncMessage;
        if (msg.type === 'hello') this.bridgeViews.add(msg.viewId);
        else if (msg.type === 'bye') this.bridgeViews.delete(msg.viewId);
        // Views say how loading goes, and report their errors for the log.
        else if (msg.type !== 'viewStatus' && msg.type !== 'viewLog') return;
        if (this.viewsOn) this.views.deliver(msg);
        return;
      }
      case 'views':
        return;
      case 'file_request':
        return this.serveFile(m);
      case 'command':
        return this.runCommand(m);
      case 'view_key':
      case 'token_created':
      case 'tokens':
      case 'token_revoked': {
        const r = this.requests.get(m.requestId);
        this.requests.delete(m.requestId);
        r?.(m);
        return;
      }
      case 'error':
        if (m.requestId) {
          const r = this.requests.get(m.requestId);
          this.requests.delete(m.requestId);
          r?.(m);
        }
        console.warn('Bridge:', m.error.message);
    }
  }

  /** Sends a file a view asked for, in binary chunks. */
  private serveFile(m: Extract<BridgeToHost, { type: 'file_request' }>): void {
    this.uploadStats.requests++;
    const bytes = this.viewsOn ? this.studio.syncFile(m.scope, m.owner, m.path) : undefined;
    if (!bytes)
      return this.send({ type: 'file_error', id: m.id, message: `No such file: ${m.path}` });
    // A view is waiting for it: upload it next (the bridge answers from the upload).
    const rel = this.relOf(m.scope, m.owner, m.path);
    if (this.worker) {
      if (this.workerPending.has(rel)) {
        this.worker.postMessage({ type: 'first', rel });
        return;
      }
      const blob = this.workerFiles.get(rel) ?? new Blob([bytes as Uint8Array<ArrayBuffer>]);
      this.workerPending.add(rel);
      this.uploaded.add(rel);
      this.worker.postMessage({ type: 'add', jobs: [{ rel, blob }] });
      this.worker.postMessage({ type: 'first', rel });
      return;
    }
    if (this.inFlight.has(rel)) return;
    const queued = this.uploads.findIndex((u) => u.rel === rel);
    if (queued >= 0) {
      this.uploads.unshift(...this.uploads.splice(queued, 1));
      return;
    }
    const run = this.uploadable.get(rel);
    if (run && storage.get(HOST_TOKEN_KEY)) {
      this.uploads.unshift({ rel, run });
      this.pump();
      return;
    }
    // No upload possible: send it over the WebSocket, in chunks.
    const ws = this.ws;
    if (!ws) return;
    let offset = 0;
    do {
      const end = Math.min(bytes.length, offset + FILE_CHUNK_BYTES);
      ws.send(
        encodeFileChunk(
          { id: m.id, ...(offset === 0 ? { size: bytes.length } : {}), done: end >= bytes.length },
          bytes.subarray(offset, end),
        ) as Uint8Array<ArrayBuffer>,
      );
      offset = end;
    } while (offset < bytes.length);
  }

  private async runCommand(m: Extract<BridgeToHost, { type: 'command' }>): Promise<void> {
    if (!this.agentsOn)
      return this.send({
        type: 'result',
        id: m.id,
        ok: false,
        error: { code: 'agents_off', message: 'Agent access is off in Mochi Studio.' },
      });
    // The page checks scopes itself too: the bridge is trusted only as far as it must be.
    const scopes = m.client.scopes.filter((s): s is Scope =>
      ['read', 'control', 'screenshot'].includes(s),
    );
    try {
      const result = await this.studio.commands.dispatch(m.name, m.args, {
        kind: 'agent',
        name: m.client.name,
        scopes,
      });
      this.send({ type: 'result', id: m.id, ok: true, result: result ?? null });
    } catch (e) {
      const err =
        e instanceof CommandError
          ? e
          : new CommandError('failed', String((e as Error)?.message ?? e));
      this.send({
        type: 'result',
        id: m.id,
        ok: false,
        error: { code: err.code, message: err.message },
      });
    }
  }

  // --- events ----------------------------------------------------------------------

  private detachEvents(): void {
    for (const u of this.unsubscribe) u();
    this.unsubscribe = [];
  }

  private attachEvents(): void {
    this.detachEvents();
    const ev = this.studio.events;
    const out = (name: string, data: unknown = {}): void =>
      this.send({ type: 'event', name, data });
    let settingsTimer: ReturnType<typeof setTimeout> | undefined;
    this.unsubscribe.push(
      ev.on('modelLoaded', ({ key }) =>
        out('model_loaded', { name: this.studio.model?.manifest.file, key }),
      ),
      ev.on('modelUnloaded', () => out('model_unloaded')),
      ev.on('settingsChanged', () => {
        // Bursts (dragging) become one event.
        if (settingsTimer) return;
        settingsTimer = setTimeout(() => {
          settingsTimer = undefined;
          out('settings_changed');
        }, 250);
      }),
      ev.on('expressionsChanged', ({ expressions }) => out('expression_changed', { expressions })),
      ev.on('motionFinished', ({ motion }) => out('motion_finished', motion)),
      ev.on('hotkeyFired', ({ hotkey }) =>
        out('hotkey_fired', { id: hotkey.id, label: hotkey.label }),
      ),
      ev.on('hotkeyReleased', ({ hotkey }) => out('hotkey_released', { id: hotkey.id })),
      ev.on('itemsChanged', ({ items }) =>
        out('item_changed', {
          items: items.map((i) => ({
            id: i.id,
            name: i.label,
            visible: this.studio.isItemVisible(i.id),
          })),
        }),
      ),
      ev.on('cameraChanged', ({ on }) => out(on ? 'tracking_started' : 'tracking_stopped')),
      ev.on('trackingFound', () => out('tracking_found')),
      ev.on('trackingLost', () => out('tracking_lost')),
      ev.on('microphoneChanged', ({ on }) => out('microphone_changed', { on })),
      this.studio.commands.events.on('executed', ({ entry }) => out('command_executed', entry)),
      this.studio.commands.events.on('history', (h) => out('history_changed', h)),
    );
  }
}
