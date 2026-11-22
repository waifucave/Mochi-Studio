import { deflateSync } from 'fflate';

/**
 * Zip archives built byte by byte, so that their records can lie: an entry
 * that declares less than it inflates to, a wrong CRC-32, a zip bomb (a
 * little data that inflates to a lot), more entries than allowed.
 */
const enc = new TextEncoder();

export function crc32(d: Uint8Array): number {
  let c = ~0;
  for (let i = 0; i < d.length; i++) {
    c ^= d[i]!;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

export interface CraftedEntry {
  name: string;
  /** The entry's data before compression. */
  data?: Uint8Array;
  /** Already deflated data, with the size it inflates to (for large entries). */
  deflated?: { bytes: Uint8Array; size: number; crc: number };
  /** Records that lie: these replace the true values. */
  declaredSize?: number;
  crc?: number;
}

export function craftZip(entries: CraftedEntry[]): Uint8Array {
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const comp = e.deflated?.bytes ?? deflateSync(e.data!);
    const size = e.declaredSize ?? e.deflated?.size ?? e.data!.length;
    const crc = e.crc ?? e.deflated?.crc ?? crc32(e.data!);
    const lh = new Uint8Array(30 + name.length);
    const l = new DataView(lh.buffer);
    l.setUint32(0, 0x04034b50, true);
    l.setUint16(4, 20, true);
    l.setUint16(8, 8, true); // deflate
    l.setUint32(14, crc, true);
    l.setUint32(18, comp.length, true);
    l.setUint32(22, size, true);
    l.setUint16(26, name.length, true);
    lh.set(name, 30);
    const ch = new Uint8Array(46 + name.length);
    const c = new DataView(ch.buffer);
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(10, 8, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, comp.length, true);
    c.setUint32(24, size, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    ch.set(name, 46);
    local.push(lh, comp);
    central.push(ch);
    offset += lh.length + comp.length;
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const end = new Uint8Array(22);
  const v = new DataView(end.buffer);
  v.setUint32(0, 0x06054b50, true);
  v.setUint16(8, entries.length, true);
  v.setUint16(10, entries.length, true);
  v.setUint32(12, cdSize, true);
  v.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cdSize + 22);
  let at = 0;
  for (const part of [...local, ...central, end]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Zeros, deflated once: a few hundred KB that inflate to `size`. */
const bombs = new Map<number, { bytes: Uint8Array; size: number; crc: number }>();
export function zeros(size: number) {
  let b = bombs.get(size);
  if (!b) {
    const data = new Uint8Array(size);
    b = { bytes: deflateSync(data, { level: 1 }), size, crc: crc32(data) };
    bombs.set(size, b);
  }
  return b;
}
