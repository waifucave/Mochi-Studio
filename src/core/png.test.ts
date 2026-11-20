import { unzlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { encodePng } from './png';

/** The chunks of a PNG: type, data, and whether the CRC matches. */
function chunks(png: Uint8Array): Array<{ type: string; data: Uint8Array; crcOk: boolean }> {
  const v = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const out = [];
  for (let o = 8; o < png.length;) {
    const n = v.getUint32(o);
    const type = String.fromCharCode(...png.subarray(o + 4, o + 8));
    const data = png.subarray(o + 8, o + 8 + n);
    let crc = 0xffffffff;
    for (const b of png.subarray(o + 4, o + 8 + n)) {
      crc ^= b;
      for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    out.push({ type, data, crcOk: (crc ^ 0xffffffff) >>> 0 === v.getUint32(o + 8 + n) });
    o += 12 + n;
  }
  return out;
}

describe('the PNG encoder', () => {
  it('writes RGBA pixels that decode back unchanged', () => {
    const w = 3;
    const h = 2;
    const px = Uint8Array.from({ length: w * h * 4 }, (_, i) => (i * 37) % 256);
    const png = encodePng(w, h, px);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const c = chunks(png);
    expect(c.map((x) => x.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
    expect(c.every((x) => x.crcOk)).toBe(true);
    const ihdr = new DataView(c[0]!.data.buffer, c[0]!.data.byteOffset);
    expect([ihdr.getUint32(0), ihdr.getUint32(4), c[0]!.data[8], c[0]!.data[9]]).toEqual([
      w,
      h,
      8,
      6,
    ]);
    const raw = unzlibSync(c[1]!.data);
    expect(raw.length).toBe((w * 4 + 1) * h);
    for (let y = 0; y < h; y++) {
      expect(raw[y * (w * 4 + 1)]).toBe(0);
      expect([...raw.subarray(y * (w * 4 + 1) + 1, (y + 1) * (w * 4 + 1))]).toEqual([
        ...px.subarray(y * w * 4, (y + 1) * w * 4),
      ]);
    }
  });
});
