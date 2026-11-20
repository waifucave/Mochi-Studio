/**
 * `npm run collab:server`: the collaboration signaling server under Node.
 *
 * Environment:
 * - PORT (default 8790) and HOST (default 127.0.0.1; 0.0.0.0 behind a
 *   reverse proxy that adds TLS, such as Caddy);
 * - STUN_URLS: comma-separated stun: URLs, given to the apps as they are;
 * - TURN_URLS and TURN_SECRET: a TURN server with REST credentials (coturn's
 *   `use-auth-secret`), handed out for an hour at a time;
 * - TRUST_PROXY=1 behind a reverse proxy: the limits per address read its
 *   X-Forwarded-For;
 * - LIMIT_CONNECTIONS_PER_ADDRESS, LIMIT_ROOMS_PER_ADDRESS and
 *   LIMIT_NEW_CONNECTIONS_PER_MINUTE: the limits per address, if not the
 *   defaults (src/core/collab/limits.ts).
 */
import { addressLimitSettings } from '../src/core/collab/limits.ts';
import { startSignalingServer } from './server.ts';

const list = (v: string | undefined) =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
const turnUrls = list(process.env.TURN_URLS);
const s = await startSignalingServer({
  port: Number(process.env.PORT ?? 8790),
  host: process.env.HOST ?? '127.0.0.1',
  stun: list(process.env.STUN_URLS),
  trustProxy: process.env.TRUST_PROXY === '1',
  limits: addressLimitSettings({
    connectionsPerAddress: process.env.LIMIT_CONNECTIONS_PER_ADDRESS,
    roomsPerAddress: process.env.LIMIT_ROOMS_PER_ADDRESS,
    newConnectionsPerMinute: process.env.LIMIT_NEW_CONNECTIONS_PER_MINUTE,
  }),
  ...(turnUrls.length && process.env.TURN_SECRET
    ? { turn: { urls: turnUrls, secret: process.env.TURN_SECRET } }
    : {}),
});
console.log(`[mochi-collab] Listening at ${s.url} (WebSocket ${s.wsUrl}).`);
if (!turnUrls.length) console.log('[mochi-collab] No relay configured: apps connect directly.');
