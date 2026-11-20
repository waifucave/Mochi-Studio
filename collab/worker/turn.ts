/**
 * Relay servers from Cloudflare's TURN service, for the Worker: short-lived
 * credentials made with the TURN key, which stays a Worker secret. Only
 * room members ask (src/core/collab/rooms.ts hands them out to members
 * only), and the key itself never leaves the Worker.
 */
import type { IceServer } from '../../src/core/collab/protocol.ts';

export interface CloudflareTurnOptions {
  /** The TURN key's id (TURN_KEY_ID). */
  keyId: string;
  /** The TURN key's API token (TURN_KEY_API_TOKEN, a Worker secret). */
  apiToken: string;
  /** How long the credentials last. A room lasts 12 hours, and apps don't renew them. */
  ttlSeconds?: number;
  /** The service's address (tests point it at a stand-in). */
  api?: string;
  fetch?: typeof fetch;
}

export const TURN_API = 'https://rtc.live.cloudflare.com';
/** Thirteen hours: past a room's twelve. */
export const DEFAULT_TURN_TTL = 13 * 60 * 60;

/** The ICE servers for one member, with when they expire; STUN only if the service fails. */
export async function cloudflareIceServers(
  o: CloudflareTurnOptions,
  now: number,
): Promise<{ iceServers: IceServer[]; expires: number }> {
  const ttl = o.ttlSeconds ?? DEFAULT_TURN_TTL;
  const expires = now + ttl * 1000;
  const fallback = { iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }], expires };
  try {
    const res = await (o.fetch ?? fetch)(
      `${o.api ?? TURN_API}/v1/turn/keys/${encodeURIComponent(o.keyId)}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${o.apiToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ttl }),
      },
    );
    if (!res.ok) return fallback;
    const body = (await res.json()) as { iceServers?: unknown };
    const list = Array.isArray(body.iceServers) ? body.iceServers : [body.iceServers];
    const iceServers: IceServer[] = [];
    for (const s of list) {
      if (typeof s !== 'object' || s === null) continue;
      const x = s as { urls?: unknown; username?: unknown; credential?: unknown };
      const urls = (Array.isArray(x.urls) ? x.urls : [x.urls]).filter(
        // Port 53 often times out in browsers; the service's own advice is to leave it out.
        (u): u is string =>
          typeof u === 'string' && /^(stun|turns?):/.test(u) && !/:53(\?|$)/.test(u),
      );
      if (!urls.length) continue;
      iceServers.push({
        urls,
        ...(typeof x.username === 'string' ? { username: x.username } : {}),
        ...(typeof x.credential === 'string' ? { credential: x.credential } : {}),
      });
    }
    return iceServers.length ? { iceServers, expires } : fallback;
  } catch {
    return fallback;
  }
}
