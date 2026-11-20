/**
 * A self-signed TLS certificate for the phone tracker (bridge/src/phone.ts).
 *
 * Phones' browsers open the camera only on secure pages: https, or the
 * phone's own localhost. A page from the computer on the local network is
 * neither, so the phone tracker is served over https with a certificate
 * made on this computer. Nobody vouches for it, so the phone's browser
 * warns once and the person continues; nothing leaves the local network.
 *
 * The certificate is written here in DER with Node's own crypto: an ECDSA
 * P-256 key and SHA-256 signature; the computer's addresses as subject
 * alternative names (IP addresses, and `localhost`); server authentication
 * as its extended key usage; valid for a year (within what Apple's and
 * Chrome's rules for TLS server certificates allow).
 */
import {
  generateKeyPairSync,
  randomBytes,
  sign,
  X509Certificate,
  type KeyObject,
} from 'node:crypto';
import { isIP } from 'node:net';

// --- DER ----------------------------------------------------------------------

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag: number, ...parts: Buffer[]): Buffer => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
};
const seq = (...parts: Buffer[]): Buffer => tlv(0x30, ...parts);
const set = (...parts: Buffer[]): Buffer => tlv(0x31, ...parts);
/** An explicit context-specific tag ([n], constructed). */
const explicit = (n: number, ...parts: Buffer[]): Buffer => tlv(0xa0 + n, ...parts);

function oid(dotted: string): Buffer {
  const [a, b, ...rest] = dotted.split('.').map(Number) as [number, number, ...number[]];
  const out = [40 * a + b];
  for (const v of rest) {
    const bytes = [v & 0x7f];
    for (let x = Math.floor(v / 128); x > 0; x = Math.floor(x / 128))
      bytes.unshift((x & 0x7f) | 0x80);
    out.push(...bytes);
  }
  return tlv(0x06, Buffer.from(out));
}

/** A non-negative INTEGER from big-endian bytes. */
function integer(b: Buffer): Buffer {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  let v = b.subarray(i);
  if (v[0]! & 0x80) v = Buffer.concat([Buffer.from([0]), v]);
  return tlv(0x02, v);
}

/** UTCTime before 2050, GeneralizedTime from then on (RFC 5280, 4.1.2.5). */
function time(d: Date): Buffer {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  const rest = `${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  const y = d.getUTCFullYear();
  return y < 2050
    ? tlv(0x17, Buffer.from(p(y % 100) + rest, 'ascii'))
    : tlv(0x18, Buffer.from(String(y) + rest, 'ascii'));
}

function ipBytes(ip: string): Buffer {
  if (isIP(ip) === 4) return Buffer.from(ip.split('.').map(Number));
  // IPv6: expand "::" and write the eight groups.
  const [head, tail] = ip.split('::') as [string, string | undefined];
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const groups = [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  const out = Buffer.alloc(16);
  groups.forEach((g, i) => out.writeUInt16BE(parseInt(g || '0', 16), i * 2));
  return out;
}

const ECDSA_SHA256 = '1.2.840.10045.4.3.2';
const COMMON_NAME = '2.5.4.3';
const ORGANIZATION = '2.5.4.10';

// --- the certificate ------------------------------------------------------------

export interface TlsIdentity {
  /** PEM. */
  cert: string;
  /** PEM (PKCS #8). */
  key: string;
  /** The addresses it names (subject alternative names). */
  names: string[];
  /** Milliseconds since 1970: valid until. */
  notAfter: number;
}

/** A new self-signed certificate for these host names and IP addresses (and `localhost`). */
export function selfSignedCertificate(
  names: readonly string[],
  o: { days?: number; now?: Date; commonName?: string } = {},
): TlsIdentity {
  const all = [...new Set(['localhost', ...names])];
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const now = o.now ?? new Date();
  // A little earlier than now, for clocks a minute or two apart.
  const notBefore = new Date(now.getTime() - 10 * 60_000);
  const notAfter = new Date(now.getTime() + (o.days ?? 365) * 86_400_000);
  const serial = randomBytes(16);
  serial[0] = serial[0]! & 0x7f;
  const name = seq(
    set(seq(oid(ORGANIZATION), tlv(0x0c, Buffer.from('Mochi Studio', 'utf8')))),
    set(
      seq(oid(COMMON_NAME), tlv(0x0c, Buffer.from(o.commonName ?? 'Mochi Studio phone tracker'))),
    ),
  );
  const altNames = seq(
    ...all.map((n) => (isIP(n) ? tlv(0x87, ipBytes(n)) : tlv(0x82, Buffer.from(n, 'ascii')))),
  );
  const extensions = seq(
    // Subject alternative names.
    seq(oid('2.5.29.17'), tlv(0x04, altNames)),
    // Extended key usage: TLS server authentication.
    seq(oid('2.5.29.37'), tlv(0x04, seq(oid('1.3.6.1.5.5.7.3.1')))),
    // Basic constraints, critical: not a certificate authority.
    seq(oid('2.5.29.19'), tlv(0x01, Buffer.from([0xff])), tlv(0x04, seq())),
  );
  const tbs = seq(
    explicit(0, integer(Buffer.from([2]))),
    integer(serial),
    seq(oid(ECDSA_SHA256)),
    name,
    seq(time(notBefore), time(notAfter)),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    explicit(3, extensions),
  );
  const signature = sign('sha256', tbs, privateKey);
  const der = seq(
    tbs,
    seq(oid(ECDSA_SHA256)),
    tlv(0x03, Buffer.concat([Buffer.from([0]), signature])),
  );
  return {
    cert: pem('CERTIFICATE', der),
    key: (privateKey as KeyObject).export({ type: 'pkcs8', format: 'pem' }).toString(),
    names: all,
    notAfter: notAfter.getTime(),
  };
}

function pem(label: string, der: Buffer): string {
  const b64 = der.toString('base64').replace(/.{64}/g, '$&\n');
  return `-----BEGIN ${label}-----\n${b64}${b64.endsWith('\n') ? '' : '\n'}-----END ${label}-----\n`;
}

/** The certificate's SHA-256 fingerprint, as browsers show it (AB:CD:…). */
export function fingerprint(certPem: string): string {
  return new X509Certificate(certPem).fingerprint256;
}
