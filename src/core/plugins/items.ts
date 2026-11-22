/**
 * The plugin API's item requests:
 * the checks and conversions that need no app state, so they can be tested
 * on their own. The page applies them (src/web/pluginHost.ts).
 */
import { readTextureHeader, TextureFormatError } from 'mochi2d/headless';
import { E } from './protocol';

/** Order slots: −30 to 30; 0 is the main model's, so items never take it (not documented). */
export const ORDER_MIN = -30;
export const ORDER_MAX = 30;
/** Items a model can hold (Mochi Studio's own limit, as in src/core/items.ts). */
export const MAX_ITEMS = 32;
/** `size` of an item at scale 1, the size of an item added by hand (documented as "about 0.32"). */
export const SIZE_AT_SCALE_1 = 0.32;

export const sizeToScale = (size: number): number => Math.max(0.001, size / SIZE_AT_SCALE_1);
export const scaleToSize = (scale: number): number => scale * SIZE_AT_SCALE_1;

type Fail = { errorID: number; message: string };
const fail = (errorID: number, message: string): Fail => ({ errorID, message });
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

// --- ItemLoadRequest ------------------------------------------------------------------

export interface CustomImageRequest {
  base64: string;
  askFirst: boolean;
  skipIfWhitelisted: boolean;
  /** Seconds; 0 or less waits forever. */
  askTimer: number;
}

export interface ItemLoad {
  fileName: string;
  positionX: number;
  positionY: number;
  size: number;
  rotation: number;
  fadeTime: number;
  /** Undefined: the first free slot in front of the model. */
  order: number | undefined;
  failIfOrderTaken: boolean;
  smoothing: number;
  censored: boolean;
  flipped: boolean;
  locked: boolean;
  unloadWhenPluginDisconnects: boolean;
  custom: CustomImageRequest | undefined;
}

/** An ItemLoadRequest's fields, or the error to send (750, 755, 757). */
export function parseItemLoad(d: Record<string, unknown>): ItemLoad | Fail {
  const fileName = d.fileName;
  if (typeof fileName !== 'string' || !fileName)
    return fail(E.itemFileMissing, 'fileName is missing.');
  const get = (k: string, def: number, lo: number, hi: number): number | undefined => {
    const v = d[k];
    if (v === undefined || v === null) return def;
    return num(v) && v >= lo && v <= hi ? v : undefined;
  };
  const positionX = get('positionX', 0, -1000, 1000);
  const positionY = get('positionY', 0, -1000, 1000);
  const size = get('size', SIZE_AT_SCALE_1, 0, 1);
  const rotation = get('rotation', 0, -1e6, 1e6);
  const fadeTime = get('fadeTime', 0, 0, 2);
  const smoothing = get('smoothing', 0, 0, 1);
  if (
    positionX === undefined ||
    positionY === undefined ||
    size === undefined ||
    rotation === undefined ||
    fadeTime === undefined ||
    smoothing === undefined
  )
    return fail(
      E.itemInvalidValues,
      'Values out of range: positionX and positionY −1000 to 1000, size 0 to 1, fadeTime 0 to 2, smoothing 0 to 1.',
    );
  let order: number | undefined;
  if (d.order !== undefined && d.order !== null) {
    if (
      !Number.isInteger(d.order) ||
      (d.order as number) < ORDER_MIN ||
      (d.order as number) > ORDER_MAX ||
      d.order === 0
    )
      return fail(
        E.itemInvalidOrder,
        `order must be a whole number from ${ORDER_MIN} to ${ORDER_MAX}, not 0 (the model's).`,
      );
    order = d.order as number;
  }
  const b64 = d.customDataBase64;
  const custom =
    typeof b64 === 'string' && b64
      ? {
          base64: b64,
          askFirst: d.customDataAskUserFirst !== false,
          skipIfWhitelisted: d.customDataSkipAskingUserIfWhitelisted !== false,
          askTimer: num(d.customDataAskTimer) ? d.customDataAskTimer : -1,
        }
      : undefined;
  return {
    fileName,
    positionX,
    positionY,
    size,
    rotation,
    fadeTime,
    order,
    failIfOrderTaken: d.failIfOrderTaken === true,
    smoothing,
    censored: d.censored === true,
    flipped: d.flipped === true,
    locked: d.locked === true,
    unloadWhenPluginDisconnects: d.unloadWhenPluginDisconnects === true,
    custom,
  };
}

/** The free order slots (`availableSpots`), lowest first. */
export function availableSpots(taken: Iterable<number>): number[] {
  const t = new Set(taken);
  const out: number[] = [];
  for (let o = ORDER_MIN; o <= ORDER_MAX; o++) if (o !== 0 && !t.has(o)) out.push(o);
  return out;
}

/**
 * The slot an item gets: the wanted one if free; if taken, the next higher
 * free one, then lower ones (or 756 with `failIfTaken`). Without a wish, the
 * first free slot in front of the model (1, 2, …).
 */
export function allocateOrder(
  wanted: number | undefined,
  taken: Iterable<number>,
  failIfTaken: boolean,
): number | Fail {
  const t = new Set(taken);
  const free = (o: number): boolean => o !== 0 && !t.has(o);
  const start = wanted ?? 1;
  if (free(start)) return start;
  if (wanted !== undefined && failIfTaken)
    return fail(E.itemOrderTaken, `Order ${wanted} is taken.`);
  for (let o = start + 1; o <= ORDER_MAX; o++) if (free(o)) return o;
  for (let o = start - 1; o >= ORDER_MIN; o--) if (free(o)) return o;
  return fail(E.itemSceneFull, 'No order slot is free.');
}

// --- custom images --------------------------------------------------------------------

/** The plugin's `fileName` for custom data: 8 to 32 letters, digits and hyphens, then .png, .jpg or .gif. */
export function validCustomFileName(name: string): boolean {
  return /^[A-Za-z0-9-]{4,28}\.(png|jpg|gif)$/i.test(name) && name.length >= 8 && name.length <= 32;
}

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MIN_IMAGE_SIDE = 64;
export const MAX_IMAGE_SIDE = 2048;
export const MAX_GIF_FRAMES = 1024;

export interface SniffedImage {
  type: 'PNG' | 'JPG' | 'GIF';
  width: number;
  height: number;
  /** GIFs: their frames (all of the same size); 1 for PNG and JPEG. */
  frames: number;
}

/** Decodes base64 strictly; undefined for anything that is not base64. */
export function decodeBase64(b64: string): Uint8Array | undefined {
  const clean = b64.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 === 1) return undefined;
  try {
    const bin = atob(clean);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return undefined;
  }
}

/**
 * What an image file is, read from its headers only (nothing is decoded):
 * PNG, JPEG or GIF, its size, and a GIF's frame count. Anything else, or a
 * truncated or malformed file, is undefined.
 */
export function sniffImage(b: Uint8Array): SniffedImage | undefined {
  const u16be = (i: number): number => (b[i]! << 8) | b[i + 1]!;
  const u16le = (i: number): number => b[i]! | (b[i + 1]! << 8);
  const u32be = (i: number): number =>
    ((b[i]! << 24) >>> 0) + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]!;
  // PNG: signature, then IHDR.
  if (
    b.length > 33 &&
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47 &&
    b[12] === 0x49 &&
    b[13] === 0x48 &&
    b[14] === 0x44 &&
    b[15] === 0x52
  )
    return { type: 'PNG', width: u32be(16), height: u32be(20), frames: 1 };
  // JPEG: markers up to the first start-of-frame.
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return undefined;
      const marker = b[i + 1]!;
      if (marker === 0xff) {
        i++;
        continue;
      }
      const len = u16be(i + 2);
      if (len < 2) return undefined;
      const sof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
      if (sof) return { type: 'JPG', width: u16be(i + 7), height: u16be(i + 5), frames: 1 };
      i += 2 + len;
    }
    return undefined;
  }
  // GIF: the logical screen, then blocks; every image must fill the screen.
  if (b.length > 13 && String.fromCharCode(...b.subarray(0, 6)).match(/^GIF8[79]a$/)) {
    const width = u16le(6);
    const height = u16le(8);
    let i = 13;
    if (b[10]! & 0x80) i += 3 << ((b[10]! & 7) + 1);
    let frames = 0;
    const skipSubBlocks = (j: number): number => {
      while (j < b.length) {
        const n = b[j]!;
        j += 1 + n;
        if (n === 0) return j;
      }
      return -1;
    };
    while (i < b.length) {
      const block = b[i]!;
      if (block === 0x3b) return frames >= 1 ? { type: 'GIF', width, height, frames } : undefined;
      if (block === 0x21) {
        if (i + 2 > b.length) return undefined;
        i = skipSubBlocks(i + 2);
      } else if (block === 0x2c) {
        if (i + 10 > b.length) return undefined;
        const w = u16le(i + 5);
        const h = u16le(i + 7);
        const flags = b[i + 9]!;
        if (w !== width || h !== height) return undefined;
        frames++;
        if (frames > MAX_GIF_FRAMES) return { type: 'GIF', width, height, frames };
        i += 10;
        if (flags & 0x80) i += 3 << ((flags & 7) + 1);
        i = skipSubBlocks(i + 1); // after the LZW minimum code size
      } else return undefined;
      if (i < 0) return undefined;
    }
    return undefined;
  }
  return undefined;
}

/** A plugin's custom image, checked against the documented limits, or error 758. */
export function checkCustomImage(bytes: Uint8Array | undefined): SniffedImage | Fail {
  if (!bytes) return fail(E.itemInvalidImage, 'customDataBase64 is not valid base64.');
  if (bytes.length >= MAX_IMAGE_BYTES)
    return fail(E.itemInvalidImage, 'The image must be smaller than 5 MB.');
  const img = sniffImage(bytes);
  if (!img) return fail(E.itemInvalidImage, 'The data is not a PNG, JPEG or GIF file.');
  if (
    img.width < MIN_IMAGE_SIDE ||
    img.height < MIN_IMAGE_SIDE ||
    img.width > MAX_IMAGE_SIDE ||
    img.height > MAX_IMAGE_SIDE
  )
    return fail(E.itemInvalidImage, 'Each side of the image must be 64 to 2048 pixels.');
  if (img.frames > MAX_GIF_FRAMES)
    return fail(E.itemInvalidImage, 'A GIF may have at most 1024 frames.');
  // The size it declares must fit the file (Mochi2D's header reader), or it is crafted.
  try {
    readTextureHeader('image', bytes);
  } catch (e) {
    if (e instanceof TextureFormatError)
      return fail(
        E.itemInvalidImage,
        'The image is damaged, or shorter than the size it declares.',
      );
    throw e;
  }
  return img;
}

// --- ItemMoveRequest ------------------------------------------------------------------

export const FADE_MODES = ['linear', 'easeIn', 'easeOut', 'easeBoth', 'overshoot', 'zip'] as const;
export type FadeMode = (typeof FADE_MODES)[number];

/** Progress 0–1 along a move, for each fade mode (Mochi Studio's own curves). */
export function ease(mode: FadeMode, t: number): number {
  const x = Math.max(0, Math.min(1, t));
  switch (mode) {
    case 'linear':
      return x;
    case 'easeIn':
      return x * x * x;
    case 'easeOut':
      return 1 - (1 - x) ** 3;
    case 'easeBoth':
      return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
    case 'overshoot': {
      // Past the target and back.
      const c = 1.70158;
      return 1 + (c + 1) * (x - 1) ** 3 + c * (x - 1) ** 2;
    }
    case 'zip':
      // Most of the way at once, then settling.
      return x === 1 ? 1 : 1 - 2 ** (-10 * x);
  }
}

export interface ItemMoveEntry {
  id: string;
  seconds: number;
  fadeMode: FadeMode;
  positionX: number | undefined;
  positionY: number | undefined;
  size: number | undefined;
  rotation: number | undefined;
  order: number | undefined;
  flip: boolean | undefined;
  userCanStop: boolean;
}

/** One entry of `itemsToMove`; a value of −1000 or less leaves that field unchanged. Out-of-range values are clamped. */
export function parseMoveEntry(e: unknown): ItemMoveEntry | { id: string; errorID: number } {
  const o = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>;
  const id = typeof o.itemInstanceID === 'string' ? o.itemInstanceID : '';
  const keep = (v: unknown): number | undefined => (num(v) && v > -1000 ? v : undefined);
  const seconds = num(o.timeInSeconds) ? Math.max(0, Math.min(30, o.timeInSeconds)) : 0;
  let fadeMode: FadeMode = 'linear';
  if (seconds > 0 && o.fadeMode !== undefined) {
    if (!(FADE_MODES as readonly unknown[]).includes(o.fadeMode))
      return { id, errorID: E.itemMoveFadeMode };
    fadeMode = o.fadeMode as FadeMode;
  }
  const order = keep(o.order);
  return {
    id,
    seconds,
    fadeMode,
    positionX: keep(o.positionX),
    positionY: keep(o.positionY),
    size: (() => {
      const v = keep(o.size);
      return v === undefined ? undefined : Math.max(0, Math.min(1, v));
    })(),
    rotation: keep(o.rotation),
    order: order === undefined ? undefined : Math.round(order),
    flip: o.setFlip === true ? o.flip === true : undefined,
    userCanStop: o.userCanStop !== false,
  };
}

// --- ItemPinRequest -------------------------------------------------------------------

export const ANGLE_MODES = [
  'RelativeToWorld',
  'RelativeToCurrentItemRotation',
  'RelativeToModel',
  'RelativeToPinPosition',
] as const;
export const SIZE_MODES = ['RelativeToWorld', 'RelativeToCurrentItemSize'] as const;
export const VERTEX_PIN_TYPES = ['Provided', 'Center', 'Random'] as const;

export interface PinRequest {
  id: string;
  pin: boolean;
  angleMode: (typeof ANGLE_MODES)[number];
  sizeMode: (typeof SIZE_MODES)[number];
  vertexType: (typeof VERTEX_PIN_TYPES)[number];
  modelID: string;
  artMeshID: string;
  angle: number;
  size: number;
  vertices: [number, number, number];
  weights: [number, number, number];
}

/** An ItemPinRequest's fields, or 1051 (modes) / 1054 (weights that are not a point of the triangle). */
export function parsePinRequest(d: Record<string, unknown>): PinRequest | Fail {
  const id = typeof d.itemInstanceID === 'string' ? d.itemInstanceID : '';
  const pin = d.pin === true;
  const info = (d.pinInfo && typeof d.pinInfo === 'object' ? d.pinInfo : {}) as Record<
    string,
    unknown
  >;
  const pick = <T extends string>(v: unknown, all: readonly T[], def: T): T | undefined =>
    v === undefined || v === null || v === ''
      ? def
      : (all as readonly unknown[]).includes(v)
        ? (v as T)
        : undefined;
  const angleMode = pick(d.angleRelativeTo, ANGLE_MODES, 'RelativeToWorld');
  const sizeMode = pick(d.sizeRelativeTo, SIZE_MODES, 'RelativeToWorld');
  const vertexType = pick(d.vertexPinType, VERTEX_PIN_TYPES, 'Provided');
  if (pin && (!angleMode || !sizeMode || !vertexType))
    return fail(E.pinInvalidMode, 'Invalid angleRelativeTo, sizeRelativeTo or vertexPinType.');
  const n = (v: unknown): number => (num(v) ? v : 0);
  const weights: [number, number, number] = [
    n(info.vertexWeight1),
    n(info.vertexWeight2),
    n(info.vertexWeight3),
  ];
  const vertices: [number, number, number] = [
    Math.round(n(info.vertexID1)),
    Math.round(n(info.vertexID2)),
    Math.round(n(info.vertexID3)),
  ];
  if (
    pin &&
    vertexType === 'Provided' &&
    (weights.some((w) => w < -1e-4 || w > 1 + 1e-4) ||
      Math.abs(weights[0] + weights[1] + weights[2] - 1) > 1e-3)
  )
    return fail(E.pinInvalidPosition, 'The vertex weights must be 0 to 1 and add up to 1.');
  return {
    id,
    pin,
    angleMode: angleMode ?? 'RelativeToWorld',
    sizeMode: sizeMode ?? 'RelativeToWorld',
    vertexType: vertexType ?? 'Provided',
    modelID: typeof info.modelID === 'string' ? info.modelID : '',
    artMeshID: typeof info.artMeshID === 'string' ? info.artMeshID : '',
    angle: n(info.angle),
    size: n(info.size),
    vertices,
    weights,
  };
}

/** The index of the triangle with these three vertices (any order) in a triangle list, or −1. */
export function findTriangle(triangles: ArrayLike<number>, v: readonly number[]): number {
  const want = [...v].sort((a, b) => a - b).join(',');
  for (let t = 0; t + 2 < triangles.length; t += 3) {
    const got = [triangles[t]!, triangles[t + 1]!, triangles[t + 2]!]
      .sort((a, b) => a - b)
      .join(',');
    if (got === want) return t / 3;
  }
  return -1;
}

// --- ModelOutlineEvent ---------------------------------------------------------------

/** The convex hull of points, counterclockwise, without collinear points (Andrew's monotone chain). */
export function convexHull(
  points: ReadonlyArray<{ x: number; y: number }>,
): Array<{ x: number; y: number }> {
  const p = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cross = (
    o: { x: number; y: number },
    a: { x: number; y: number },
    b: { x: number; y: number },
  ): number => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Array<{ x: number; y: number }> = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower.at(-2)!, lower.at(-1)!, q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Array<{ x: number; y: number }> = [];
  for (const q of p.reverse()) {
    while (upper.length >= 2 && cross(upper.at(-2)!, upper.at(-1)!, q) <= 0) upper.pop();
    upper.push(q);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

// --- window coordinates ---------------------------------------------------------------

/** Page pixels for the protocol's window coordinates (±1 the window's edges, y up). */
export function windowToPage(
  x: number,
  y: number,
  r: { left: number; top: number; width: number; height: number },
): { x: number; y: number } {
  return { x: r.left + ((x + 1) / 2) * r.width, y: r.top + ((1 - y) / 2) * r.height };
}

export function pageToWindow(
  x: number,
  y: number,
  r: { left: number; top: number; width: number; height: number },
): { x: number; y: number } {
  return { x: ((x - r.left) / r.width) * 2 - 1, y: 1 - ((y - r.top) / r.height) * 2 };
}
