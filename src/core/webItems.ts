/**
 * Web items: an
 * item backed by a web page. The desktop app renders the page off screen
 * into the item's texture (Mochi2D 0.14.0's `updateTexture`), at the frame
 * rate the person chooses, and sends the frames to output views. A browser
 * cannot draw another site's page into a texture, so there web items need
 * the desktop app.
 *
 * The page's rules (desktop/main.ts):
 * - only an `http:` or `https:` address the person types;
 * - its own session, sharing nothing with Mochi Studio's pages;
 * - sandboxed, with no Node and no preload;
 * - no permissions (camera, microphone, notifications…), no new windows, no
 *   downloads, and no navigation to another site;
 * - no requests to Mochi Studio's own addresses (its bridge and phone
 *   page);
 * - muted, and shown only: Mochi Studio sends it no input.
 */

/** A web item's page and how it is drawn. */
export interface WebItemSource {
  url: string;
  /** The page's size in CSS pixels, and the texture's. */
  width: number;
  height: number;
  /** Frames a second, 1 to 30. */
  fps: number;
}

export const WEB_ITEM_DEFAULTS = { width: 640, height: 360, fps: 10 } as const;
export const WEB_ITEM_MAX_SIZE = 1920;
export const WEB_ITEM_MIN_SIZE = 16;
export const WEB_ITEM_MAX_FPS = 30;

/** An address a web item may show: http or https only, with a host. */
export function webItemUrl(v: unknown): string | undefined {
  if (typeof v !== 'string' || v.length > 2000) return undefined;
  let u: URL;
  try {
    u = new URL(v.trim());
  } catch {
    return undefined;
  }
  return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname ? u.href : undefined;
}

const clampInt = (v: unknown, d: number, lo: number, hi: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.min(hi, Math.max(lo, v))) : d;

/** A stored web item source, read safely; undefined when its address is not allowed. */
export function parseWebItem(v: unknown): WebItemSource | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const o = v as Record<string, unknown>;
  const url = webItemUrl(o.url);
  if (!url) return undefined;
  return {
    url,
    width: clampInt(o.width, WEB_ITEM_DEFAULTS.width, WEB_ITEM_MIN_SIZE, WEB_ITEM_MAX_SIZE),
    height: clampInt(o.height, WEB_ITEM_DEFAULTS.height, WEB_ITEM_MIN_SIZE, WEB_ITEM_MAX_SIZE),
    fps: clampInt(o.fps, WEB_ITEM_DEFAULTS.fps, 1, WEB_ITEM_MAX_FPS),
  };
}

/**
 * Whether a host name is this computer: `localhost` (and `*.localhost`),
 * 127.0.0.0/8, `0.0.0.0`, `::`, `::1` (also IPv4-mapped), or one of
 * `localHosts` (the computer's own network addresses).
 */
export function isThisComputer(hostname: string, localHosts: readonly string[] = []): boolean {
  const h = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  const v4 = h.replace(/^::ffff:/, '');
  if (/^127\.\d+\.\d+\.\d+$/.test(v4) || v4 === '0.0.0.0') return true;
  // IPv4-mapped loopback in hex form (the URL parser writes ::ffff:7f00:1).
  if (/^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(h)) return true;
  if (h === '::' || h === '::1') return true;
  return localHosts.some((l) => l.toLowerCase().replace(/^\[|\]$/g, '') === h);
}

/**
 * Whether an address is one of Mochi Studio's own (its bridge, phone page…):
 * never for a web item. Every name of this computer counts as the same host.
 */
export function isOwnAddress(
  url: string,
  ownOrigins: readonly string[],
  localHosts: readonly string[] = [],
): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const portOf = (x: URL) =>
    x.port || (x.protocol === 'https:' || x.protocol === 'wss:' ? '443' : '80');
  const here = isThisComputer(u.hostname, localHosts);
  return ownOrigins.some((o) => {
    try {
      const x = new URL(o);
      return (
        portOf(x) === portOf(u) &&
        (x.hostname === u.hostname || (here && isThisComputer(x.hostname, localHosts)))
      );
    } catch {
      return false;
    }
  });
}

/** Pixels in Electron's bitmap order (BGRA) as RGBA, in place. */
export function bgraToRgba(px: Uint8Array): Uint8Array {
  for (let i = 0; i + 3 < px.length; i += 4) {
    const b = px[i]!;
    px[i] = px[i + 2]!;
    px[i + 2] = b;
  }
  return px;
}
