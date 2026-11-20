/**
 * `npm run collab:worker`: the signaling Worker on this computer, under
 * Miniflare, with no Cloudflare account. PORT (default 8791). With
 * TURN_KEY_ID and TURN_KEY_API_TOKEN set, it asks Cloudflare's TURN service
 * for relay credentials, as the deployed Worker does.
 */
import { startLocalWorker } from './local.ts';

const bindings: Record<string, string> = {};
for (const k of [
  'TURN_KEY_ID',
  'TURN_KEY_API_TOKEN',
  'TURN_TTL',
  'LIMIT_CONNECTIONS_PER_ADDRESS',
  'LIMIT_ROOMS_PER_ADDRESS',
  'LIMIT_NEW_CONNECTIONS_PER_MINUTE',
])
  if (process.env[k]) bindings[k] = process.env[k]!;
const w = await startLocalWorker({ port: Number(process.env.PORT ?? 8791), bindings });
console.log(`[mochi-collab] The Worker, locally, at ${w.url} (WebSocket ${w.wsUrl}).`);
