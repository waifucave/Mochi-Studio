/**
 * The session's secret and keys (docs/collaboration.md, sections 1 and 3).
 *
 * The invitation link carries a 128-bit secret after `#`, which browsers
 * never send to a server. From it and the room id, HKDF gives two AES-GCM
 * keys: one for nicknames (the signaling server passes them on without
 * being able to read them) and one for shared model files (encrypted again
 * inside WebRTC's own encryption, so a relay never holds usable bytes).
 *
 * WebCrypto: the same code runs in the app's pages and in Node.
 */

const subtle = () => globalThis.crypto.subtle;

export function toBase64Url(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

/** A new session secret: 128 random bits, base64url. */
export function newSecret(): string {
  return toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(16)));
}

/** A random key for knocking on one room (the server refuses a kicked one). */
export function newKnockKey(): string {
  return toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(16)));
}

export interface SessionKeys {
  names: CryptoKey;
  files: CryptoKey;
}

export async function sessionKeys(secret: string, room: string): Promise<SessionKeys> {
  const raw = fromBase64Url(secret);
  if (raw.length !== 16) throw new Error('The invitation’s secret is not valid.');
  const base = await subtle().importKey('raw', raw as BufferSource, 'HKDF', false, ['deriveKey']);
  const derive = (info: string) =>
    subtle().deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new TextEncoder().encode(`mochi-collab room ${room}`),
        info: new TextEncoder().encode(info),
      },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  return {
    names: await derive('mochi-collab names v1'),
    files: await derive('mochi-collab files v1'),
  };
}

/** AES-GCM with a random 96-bit IV, given first: iv ‖ ciphertext ‖ tag. */
export async function encryptBytes(
  key: CryptoKey,
  data: Uint8Array,
  aad?: Uint8Array,
): Promise<Uint8Array> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await subtle().encrypt(
      { name: 'AES-GCM', iv, ...(aad ? { additionalData: aad as BufferSource } : {}) },
      key,
      data as BufferSource,
    ),
  );
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return out;
}

/** The plaintext, or undefined when the key is wrong or the bytes were changed. */
export async function decryptBytes(
  key: CryptoKey,
  data: Uint8Array,
  aad?: Uint8Array,
): Promise<Uint8Array | undefined> {
  if (data.length < 12 + 16) return undefined;
  try {
    return new Uint8Array(
      await subtle().decrypt(
        {
          name: 'AES-GCM',
          iv: data.subarray(0, 12) as BufferSource,
          ...(aad ? { additionalData: aad as BufferSource } : {}),
        },
        key,
        data.subarray(12) as BufferSource,
      ),
    );
  } catch {
    return undefined;
  }
}

export async function encryptText(key: CryptoKey, text: string): Promise<string> {
  return toBase64Url(await encryptBytes(key, new TextEncoder().encode(text)));
}

export async function decryptText(key: CryptoKey, s: string): Promise<string | undefined> {
  let data: Uint8Array;
  try {
    data = fromBase64Url(s);
  } catch {
    return undefined;
  }
  const b = await decryptBytes(key, data);
  return b && new TextDecoder().decode(b);
}

export interface Invitation {
  /** The signaling server's WebSocket address (a short code doesn't carry it). */
  server?: string;
  room: string;
  secret: string;
  /** The invitation's door token: a new link has another, and the old one is refused. */
  door: string;
}

/** A new door token: 48 random bits, base64url. */
export function newDoor(): string {
  return toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(6)));
}

/** The link to share: the server's join page, with the secret and the door after `#`. */
export function invitationLink(server: string, room: string, secret: string, door: string): string {
  const u = new URL(server);
  u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
  u.pathname = `${u.pathname.replace(/\/ws$/, '')}/join/${room}`.replace(/\/{2,}/g, '/');
  u.search = '';
  u.hash = `${secret}.${door}`;
  return u.href;
}

/** Reads a pasted invitation link, or a short code; undefined when it is neither. */
export function parseInvitation(text: string): Invitation | undefined {
  const code = parseCode(text);
  if (code) return code;
  let u: URL;
  try {
    u = new URL(text.trim());
  } catch {
    return undefined;
  }
  const m = /^(.*)\/join\/([0-9a-f]{1,64})$/.exec(u.pathname);
  const h = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{8})$/.exec(u.hash.slice(1));
  if (!m || !h || !/^https?:$/.test(u.protocol)) return undefined;
  return {
    server: `${u.protocol === 'https:' ? 'wss:' : 'ws:'}//${u.host}${m[1]}/ws`,
    room: m[2]!,
    secret: h[1]!,
    door: h[2]!,
  };
}

/** Crockford's base32: no I, L, O or U, so a code survives being read aloud and typed. */
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * The invitation as a code to read aloud or type: the room (9 bytes), the
 * secret (16) and the door (6), in Crockford's base32, in groups of five
 * after "MOCHI". It is the whole invitation, not a weaker one: its 50
 * characters are what 128 bits of secret take. The server isn't in it; the
 * person joining uses their own Signaling server setting.
 */
export function invitationCode(room: string, secret: string, door: string): string | undefined {
  if (!/^[0-9a-f]{18}$/.test(room)) return undefined;
  const bytes = new Uint8Array(31);
  for (let i = 0; i < 9; i++) bytes[i] = parseInt(room.slice(i * 2, i * 2 + 2), 16);
  bytes.set(fromBase64Url(secret), 9);
  bytes.set(fromBase64Url(door), 25);
  let bits = 0;
  let acc = 0;
  let out = '';
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(acc >> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  if (bits) out += B32[(acc << (5 - bits)) & 31];
  return `MOCHI-${out.match(/.{1,5}/g)!.join('-')}`;
}

function parseCode(text: string): Invitation | undefined {
  const t = text
    .trim()
    .toUpperCase()
    .replace(/^MOCHI/, '')
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (t.length !== 50 || /[^0-9A-HJKMNP-TV-Z]/.test(t)) return undefined;
  const bytes = new Uint8Array(31);
  let bits = 0;
  let acc = 0;
  let n = 0;
  for (const c of t) {
    acc = (acc << 5) | B32.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      if (n < 31) bytes[n++] = (acc >> (bits - 8)) & 255;
      bits -= 8;
      acc &= (1 << bits) - 1;
    }
  }
  const room = [...bytes.subarray(0, 9)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return {
    room,
    secret: toBase64Url(bytes.subarray(9, 25)),
    door: toBase64Url(bytes.subarray(25, 31)),
  };
}

/** The proof of a room's password: never the password itself, and only readable with the secret. */
export async function passwordProof(password: string, room: string): Promise<string> {
  const subtleKey = await subtle().importKey(
    'raw',
    new TextEncoder().encode(password) as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await subtle().sign(
    'HMAC',
    subtleKey,
    new TextEncoder().encode(`mochi-collab password ${room}`),
  );
  return toBase64Url(new Uint8Array(mac));
}
