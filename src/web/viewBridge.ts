/**
 * An output view's connection to the bridge (an OBS browser source has its
 * own browser profile, so it cannot hear the control window's
 * BroadcastChannel). It gets the same messages as a same-profile view, and
 * reads model files from the bridge's /files on demand.
 *
 * The view key in the address gives display access only: no commands,
 * nothing an agent token can get.
 */
import {
  PROTOCOL_VERSION,
  decodeSync,
  encodeSync,
  type BridgeToView,
} from '../core/bridgeProtocol';
import { RootedFileSet } from '../core/modelFiles';
import { isSyncMessage, type SyncMessage, type SyncTransport } from '../core/sync';

export interface ViewBridgeOptions {
  /** ws://127.0.0.1:<port> */
  bridge: string;
  key: string;
  viewId: string;
  onStatus?: (status: string) => void;
}

export function viewBridgeTransport(o: ViewBridgeOptions): SyncTransport & {
  fileUrl(scope: 'model' | 'item', owner: string, path: string): string;
} {
  const handlers = new Set<(m: SyncMessage) => void>();
  let ws: WebSocket | undefined;
  let closed = false;
  let retryMs = 1000;
  let hello: SyncMessage | undefined;
  const base = o.bridge.replace(/\/+$/, '');
  const httpBase = base.replace(/^ws/, 'http');

  const connect = (): void => {
    if (closed) return;
    const s = new WebSocket(`${base}/view`);
    ws = s;
    s.onopen = () => {
      retryMs = 1000;
      s.send(
        JSON.stringify({
          type: 'view_hello',
          protocol: PROTOCOL_VERSION,
          key: o.key,
          viewId: o.viewId,
        }),
      );
    };
    s.onmessage = (e) => {
      let m: BridgeToView;
      try {
        m = JSON.parse(String(e.data)) as BridgeToView;
      } catch {
        return;
      }
      if (m.type === 'view_welcome' || (m.type === 'studio' && m.connected)) {
        o.onStatus?.(
          m.type === 'view_welcome' && !m.studio.connected
            ? 'waiting for Mochi Studio'
            : 'connected',
        );
        // (Re)announce this view, so the control window sends the full state.
        if (hello && (m.type === 'studio' || m.studio.connected)) post(hello);
      } else if (m.type === 'studio') o.onStatus?.('waiting for Mochi Studio');
      else if (m.type === 'error') o.onStatus?.(m.error.message);
      else if (m.type === 'sync') {
        const msg = decodeSync(m.message);
        if (isSyncMessage(msg)) for (const h of handlers) h(msg);
      }
    };
    s.onclose = (e) => {
      if (closed) return;
      if (e.code === 4401) {
        o.onStatus?.('The view key is not valid. Copy the address again from Mochi Studio.');
        return;
      }
      o.onStatus?.('waiting for the bridge');
      setTimeout(connect, retryMs);
      retryMs = Math.min(10_000, retryMs * 2);
    };
  };

  const post = (m: SyncMessage): void => {
    if (m.type === 'hello') hello = m;
    if (ws?.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify({ type: 'sync', message: encodeSync(m) }));
  };

  connect();
  return {
    post,
    onMessage(fn) {
      handlers.add(fn);
      return () => handlers.delete(fn);
    },
    close() {
      closed = true;
      ws?.close();
    },
    fileUrl: (scope, owner, path) =>
      `${httpBase}/files/${scope}/${encodeURIComponent(owner)}/${path
        .split('/')
        .map(encodeURIComponent)
        .join('/')}?key=${encodeURIComponent(o.key)}`,
  };
}

/**
 * Files of a model or item from the bridge, all fetched at once (six at a
 * time) as soon as the list arrives, whatever order Mochi2D reads them in.
 * `onBytes` counts what arrived, for the progress shown in the control
 * window.
 */
export function prefetchedFiles(
  url: (path: string) => string,
  label: string,
  paths: readonly string[],
  onBytes: (n: number) => void,
  concurrency = 6,
): { files: RootedFileSet; done: Promise<void>; fetchMs: () => number } {
  const t0 = performance.now();
  let t1 = 0;
  const cache = new Map<string, Promise<Uint8Array>>();
  const queue = [...paths];
  const fetchOne = async (p: string): Promise<Uint8Array> => {
    const r = await fetch(url(p));
    if (!r.ok || !r.body)
      throw new Error(`Could not read ${p} from the bridge (HTTP ${r.status}).`);
    const size = Number(r.headers.get('content-length')) || 0;
    const reader = r.body.getReader();
    const chunks: Uint8Array[] = [];
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      n += value.length;
      onBytes(value.length);
    }
    if (chunks.length === 1 && (!size || size === n)) return chunks[0]!;
    const out = new Uint8Array(n);
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  };
  const resolvers = new Map<string, { resolve(v: Uint8Array): void; reject(e: unknown): void }>();
  for (const p of paths)
    cache.set(
      p,
      new Promise<Uint8Array>((resolve, reject) => resolvers.set(p, { resolve, reject })),
    );
  for (const promise of cache.values()) promise.catch(() => undefined);
  const worker = async (): Promise<void> => {
    for (let p = queue.shift(); p !== undefined; p = queue.shift()) {
      const r = resolvers.get(p)!;
      await fetchOne(p).then(r.resolve, r.reject);
    }
  };
  const done = Promise.all(
    Array.from({ length: Math.min(concurrency, paths.length) }, worker),
  ).then(() => {
    t1 = performance.now();
  });
  const files = new RootedFileSet(label, paths, (p) => cache.get(p) ?? fetchOne(p));
  return { files, done, fetchMs: () => (t1 || performance.now()) - t0 };
}
