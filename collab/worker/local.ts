/**
 * The signaling Worker on this computer, with no Cloudflare account: bundled
 * with esbuild and run by Miniflare, Cloudflare's local runtime for Workers
 * (Durable Objects, WebSocket hibernation and alarms included). Tests use it
 * to run the same protocol tests as against the Node server; `npm run
 * collab:worker` runs it by hand.
 */
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { fileURLToPath } from 'node:url';

export interface LocalWorkerOptions {
  port?: number;
  /** Bindings as wrangler.toml and `wrangler secret` would give them. */
  bindings?: Record<string, string>;
}

export interface LocalWorker {
  /** http://127.0.0.1:port */
  url: string;
  /** ws://127.0.0.1:port/ws */
  wsUrl: string;
  /** What `/health` says. */
  stats(): Promise<{ rooms: number; members: number; knocking: number }>;
  close(): Promise<void>;
}

/** The Worker as one ES module, as wrangler would bundle it. */
export async function bundleWorker(): Promise<string> {
  const r = await build({
    entryPoints: [fileURLToPath(new URL('./index.ts', import.meta.url))],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    logLevel: 'silent',
  });
  return r.outputFiles[0]!.text;
}

export async function startLocalWorker(o: LocalWorkerOptions = {}): Promise<LocalWorker> {
  const mf = new Miniflare({
    modules: true,
    script: await bundleWorker(),
    compatibilityDate: '2026-07-01',
    durableObjects: {
      ROOMS: { className: 'RoomObject', useSQLite: true },
      ADDRESSES: { className: 'AddressObject', useSQLite: true },
      COUNTS: { className: 'CountsObject', useSQLite: true },
    },
    bindings: o.bindings ?? {},
    host: '127.0.0.1',
    port: o.port ?? 0,
  });
  const url = (await mf.ready).href.replace(/\/$/, '');
  return {
    url,
    wsUrl: `${url.replace(/^http/, 'ws')}/ws`,
    stats: async () => (await (await fetch(`${url}/health`)).json()) as never,
    close: () => mf.dispose(),
  };
}
