/**
 * Texture files that declare a size in their headers, for the caps' tests.
 * Their pixels never come: the caps refuse them from the header alone.
 *
 * - **An honest PNG** carries an IDAT chunk long enough for the size it
 *   declares (zlib packs at most about 1,032:1), so only the size caps can
 *   refuse it.
 * - **A lying PNG** is a few dozen bytes declaring a huge size: damaged or
 *   crafted.
 */
const enc = new TextEncoder();

export function pngDeclaring(width: number, height: number, lying = false): Uint8Array {
  const idat = lying ? 2 : Math.ceil((height * (1 + 4 * width)) / 1000);
  const b = new Uint8Array(33 + 12 + idat + 12);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13], 0);
  b.set(enc.encode('IHDR'), 12);
  const v = new DataView(b.buffer);
  v.setUint32(16, width);
  v.setUint32(20, height);
  b[24] = 8; // bit depth
  b[25] = 6; // RGBA
  v.setUint32(33, idat);
  b.set(enc.encode('IDAT'), 37);
  b.set(enc.encode('IEND'), 33 + 12 + idat + 4);
  return b;
}

/** The start of an AVIF file (its `ftyp` box), which Mochi2D doesn't read a size from. */
export function avifStart(): Uint8Array {
  const b = new Uint8Array(32);
  new DataView(b.buffer).setUint32(0, 28);
  b.set(enc.encode('ftypavif'), 4);
  b.set(enc.encode('avifmif1miaf'), 16);
  return b;
}

/** The start of a TIFF file (little-endian). */
export function tiffStart(): Uint8Array {
  return new Uint8Array([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 0, 0, 0, 0]);
}
