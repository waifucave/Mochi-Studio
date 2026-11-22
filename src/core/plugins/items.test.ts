import { describe, expect, it } from 'vitest';
import { pngDeclaring } from '../../../test/support/craftedTexture';
import {
  allocateOrder,
  availableSpots,
  checkCustomImage,
  convexHull,
  decodeBase64,
  ease,
  FADE_MODES,
  findTriangle,
  pageToWindow,
  parseItemLoad,
  parseMoveEntry,
  parsePinRequest,
  sniffImage,
  validCustomFileName,
  windowToPage,
} from './items';

/** A minimal PNG header (signature and IHDR) of w × h. */
function png(w: number, h: number): Uint8Array {
  const b = new Uint8Array(40);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
}

/** A GIF of w × h with the given frame sizes (no color tables, empty image data). */
function gif(w: number, h: number, frames: Array<[number, number]>): Uint8Array {
  const out = [...'GIF89a'].map((c) => c.charCodeAt(0));
  out.push(w & 255, w >> 8, h & 255, h >> 8, 0, 0, 0);
  // A graphic control extension, as real GIFs have.
  out.push(0x21, 0xf9, 4, 0, 10, 0, 0, 0);
  for (const [fw, fh] of frames)
    out.push(0x2c, 0, 0, 0, 0, fw & 255, fw >> 8, fh & 255, fh >> 8, 0, 2, 1, 0, 0);
  out.push(0x3b);
  return Uint8Array.from(out);
}

describe('ItemLoadRequest', () => {
  it('fills defaults and checks the limits (750, 755, 757)', () => {
    const r = parseItemLoad({ fileName: 'hat' });
    expect(r).toMatchObject({ fileName: 'hat', size: 0.32, order: undefined, custom: undefined });
    expect(parseItemLoad({})).toMatchObject({ errorID: 750 });
    expect(parseItemLoad({ fileName: 'a', size: 2 })).toMatchObject({ errorID: 757 });
    expect(parseItemLoad({ fileName: 'a', fadeTime: 3 })).toMatchObject({ errorID: 757 });
    expect(parseItemLoad({ fileName: 'a', order: 0 })).toMatchObject({ errorID: 755 });
    expect(parseItemLoad({ fileName: 'a', order: 31 })).toMatchObject({ errorID: 755 });
    expect(parseItemLoad({ fileName: 'a', customDataBase64: 'AAAA' })).toMatchObject({
      custom: { askFirst: true, skipIfWhitelisted: true },
    });
  });

  it('takes the wanted slot, the next higher, then lower ones', () => {
    expect(allocateOrder(3, [1, 2], false)).toBe(3);
    expect(allocateOrder(2, [1, 2], false)).toBe(3);
    expect(allocateOrder(30, [30], false)).toBe(29);
    expect(allocateOrder(2, [2], true)).toMatchObject({ errorID: 756 });
    expect(allocateOrder(undefined, [1], false)).toBe(2);
    expect(availableSpots([1, -1])).not.toContain(0);
    expect(availableSpots([1, -1])).toHaveLength(58);
  });
});

describe('custom images', () => {
  it('checks the file name', () => {
    expect(validCustomFileName('my-image.png')).toBe(true);
    expect(validCustomFileName('abc.png')).toBe(false);
    expect(validCustomFileName('bad name.png')).toBe(false);
    expect(validCustomFileName('picture1.bmp')).toBe(false);
  });

  it('reads PNG, JPEG and GIF headers, and refuses anything else', () => {
    expect(sniffImage(png(100, 80))).toEqual({ type: 'PNG', width: 100, height: 80, frames: 1 });
    const jpeg = Uint8Array.from([
      0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 90, 0, 120, 3, 0, 0, 0, 0,
    ]);
    expect(sniffImage(jpeg)).toEqual({ type: 'JPG', width: 120, height: 90, frames: 1 });
    expect(
      sniffImage(
        gif(70, 70, [
          [70, 70],
          [70, 70],
        ]),
      ),
    ).toEqual({
      type: 'GIF',
      width: 70,
      height: 70,
      frames: 2,
    });
    expect(
      sniffImage(
        gif(70, 70, [
          [70, 70],
          [40, 40],
        ]),
      ),
    ).toBeUndefined();
    expect(sniffImage(new TextEncoder().encode('<svg></svg>'))).toBeUndefined();
    expect(sniffImage(png(100, 80).subarray(0, 20))).toBeUndefined();
  });

  it('applies the limits (758)', () => {
    expect(checkCustomImage(pngDeclaring(64, 2048))).toMatchObject({ type: 'PNG' });
    // A size its file can't hold: crafted, refused before anything decodes it.
    expect(checkCustomImage(png(64, 2048))).toEqual({
      errorID: 758,
      message: 'The image is damaged, or shorter than the size it declares.',
    });
    expect(checkCustomImage(png(63, 100))).toMatchObject({ errorID: 758 });
    expect(checkCustomImage(png(100, 2049))).toMatchObject({ errorID: 758 });
    expect(checkCustomImage(undefined)).toMatchObject({ errorID: 758 });
    expect(decodeBase64('not base64!')).toBeUndefined();
    expect(decodeBase64(btoa('hi'))).toEqual(new TextEncoder().encode('hi'));
  });
});

describe('ItemMoveRequest', () => {
  it('keeps fields at −1000 or less, clamps the rest, and checks the fade mode', () => {
    const e = parseMoveEntry({
      itemInstanceID: 'a',
      timeInSeconds: 40,
      fadeMode: 'easeBoth',
      positionX: -1000,
      positionY: 0.5,
      size: 3,
      order: -1000,
    });
    expect(e).toMatchObject({
      id: 'a',
      seconds: 30,
      positionX: undefined,
      positionY: 0.5,
      size: 1,
      order: undefined,
    });
    expect(parseMoveEntry({ itemInstanceID: 'a', timeInSeconds: 1, fadeMode: 'wobble' })).toEqual({
      id: 'a',
      errorID: 901,
    });
  });

  it('eases from 0 to 1 in every mode', () => {
    for (const m of FADE_MODES) {
      expect(ease(m, 0)).toBeCloseTo(0, 6);
      expect(ease(m, 1)).toBeCloseTo(1, 6);
    }
    expect(
      Math.max(...Array.from({ length: 50 }, (_, i) => ease('overshoot', i / 49))),
    ).toBeGreaterThan(1);
  });
});

describe('ItemPinRequest', () => {
  it('checks the modes and the weights', () => {
    const ok = parsePinRequest({
      itemInstanceID: 'a',
      pin: true,
      pinInfo: {
        artMeshID: 'Face',
        vertexID1: 0,
        vertexID2: 1,
        vertexID3: 2,
        vertexWeight1: 0.2,
        vertexWeight2: 0.3,
        vertexWeight3: 0.5,
      },
    });
    expect(ok).toMatchObject({ vertexType: 'Provided', artMeshID: 'Face', vertices: [0, 1, 2] });
    expect(parsePinRequest({ pin: true, angleRelativeTo: 'Sideways' })).toMatchObject({
      errorID: 1051,
    });
    expect(
      parsePinRequest({
        pin: true,
        pinInfo: { vertexWeight1: 0.5, vertexWeight2: 0.5, vertexWeight3: 0.5 },
      }),
    ).toMatchObject({ errorID: 1054 });
    expect(parsePinRequest({ pin: false, itemInstanceID: 'a' })).toMatchObject({ pin: false });
  });

  it('finds a triangle by its vertices in any order', () => {
    expect(findTriangle([0, 1, 2, 2, 3, 0], [0, 3, 2])).toBe(1);
    expect(findTriangle([0, 1, 2], [0, 1, 5])).toBe(-1);
  });
});

describe('geometry', () => {
  it('builds a convex hull', () => {
    const hull = convexHull([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
      { x: 0.5, y: 0.5 },
      { x: 0.5, y: 0 },
    ]);
    expect(hull).toHaveLength(4);
    expect(hull).not.toContainEqual({ x: 0.5, y: 0.5 });
  });

  it('converts window coordinates both ways', () => {
    const r = { left: 0, top: 0, width: 200, height: 100 };
    expect(windowToPage(-1, 1, r)).toEqual({ x: 0, y: 0 });
    expect(windowToPage(0, 0, r)).toEqual({ x: 100, y: 50 });
    expect(pageToWindow(200, 100, r)).toEqual({ x: 1, y: -1 });
  });
});
