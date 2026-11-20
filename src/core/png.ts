/**
 * A PNG encoder for the pictures the app makes (image items, animated
 * items' atlases, placeholder textures).
 *
 * Not the canvas's own: Chrome encodes `convertToBlob`/`toBlob` PNGs in idle
 * time, and a page that draws every frame has none, so each encode waits
 * about a second for its fallback deadline, however small the picture.
 */
import { zlibSync } from 'fflate';

/** Encodes 8-bit RGBA pixels (not premultiplied) as a PNG: signature, IHDR, one IDAT, IEND. */
export function encodePng(
  width: number,
  height: number,
  rgba: Uint8Array | Uint8ClampedArray,
  level: 0 | 1 | 6 = 6,
): Uint8Array {
  // Each scanline is prefixed with filter type 0 (none).
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++)
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  // compression (deflate), filter method and interlace (none) are 0.

  const parts = [
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlibSync(raw, { level })),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** A PNG chunk: length, type, data, CRC-32 of type + data. */
function chunk(type: string, data: Uint8Array): Uint8Array {
  const c = new Uint8Array(12 + data.length);
  const view = new DataView(c.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) c[4 + i] = type.charCodeAt(i);
  c.set(data, 8);
  view.setUint32(8 + data.length, crc32(c.subarray(4, 8 + data.length)));
  return c;
}

let crcTable: Uint32Array | undefined;

/** CRC-32 (polynomial 0xEDB88320), as PNG chunks use. */
function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const b of bytes) crc = crcTable[(crc ^ b) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
