/**
 * Animated items: an animated GIF or a folder of PNG frames
 * becomes an item model with one quad per frame, each in its own part, and
 * the frames packed into texture atlases. Showing a frame sets its part's
 * opacity to 1 and the others' to 0 (Mochi2D's `setPartOpacity`), so frames
 * change without swapping textures, and hit tests and pins see only the
 * frame shown.
 *
 * Written with Mochi2D's `writeMoc` (its moc-data format, docs/moc-data.md),
 * as still image items are (src/core/imageItem.ts).
 */
import { strToU8 } from 'fflate';
import { writeMoc, type MocData } from 'mochi2d/headless';
import { IMAGE_ITEM_MARKER } from './imageItem';

/** At most this many frames. */
export const MAX_FRAMES = 1024;
/** Atlas textures: at most this many, of at most this size. */
export const ATLAS_SIDE = 2048;
export const MAX_ATLASES = 4;
/** Transparent pixels between frames in an atlas, so filtering never mixes neighbours. */
export const GUTTER = 4;
/** Frames decoded in all, at most (a GIF of 1024 frames of 500 × 500, or 64 of 2048 × 2048). */
export const MAX_DECODED_PIXELS = 256 * 1024 * 1024;
/** Frame rates an item can have; 0 holds the frame shown. */
export const MAX_FPS = 60;
/** A PNG folder's frame rate when nothing says otherwise. */
export const DEFAULT_FOLDER_FPS = 10;

const MOC = 'image.moc3';
const SETTINGS = 'image.model3.json';

export const framePartId = (i: number): string => `PartFrame${i}`;
export const textureName = (i: number): string => `texture_${String(i).padStart(2, '0')}.png`;

export interface AtlasLayout {
  /** Frames as drawn into the atlases (scaled down to fit when needed). */
  cellWidth: number;
  cellHeight: number;
  scale: number;
  atlases: Array<{ width: number; height: number }>;
  /** Where each frame is: its atlas, and its cell's top-left corner. */
  frames: Array<{ texture: number; x: number; y: number }>;
}

/**
 * Packs `count` frames of `width` × `height` into at most MAX_ATLASES atlases
 * of at most ATLAS_SIDE a side, scaling the frames down as little as needed.
 */
export function planAtlas(width: number, height: number, count: number): AtlasLayout {
  if (!(count >= 1) || !(width >= 1) || !(height >= 1)) throw new Error('No frames.');
  let scale = Math.min(1, (ATLAS_SIDE - 2 * GUTTER) / Math.max(width, height));
  for (;;) {
    const cw = Math.max(1, Math.floor(width * scale));
    const ch = Math.max(1, Math.floor(height * scale));
    const cols = Math.max(1, Math.floor((ATLAS_SIDE + GUTTER) / (cw + GUTTER)));
    const rows = Math.max(1, Math.floor((ATLAS_SIDE + GUTTER) / (ch + GUTTER)));
    const per = cols * rows;
    const need = Math.ceil(count / per);
    if (need <= MAX_ATLASES || (cw === 1 && ch === 1)) {
      const frames: AtlasLayout['frames'] = [];
      const atlases: AtlasLayout['atlases'] = [];
      for (let a = 0; a < need; a++) {
        const n = Math.min(per, count - a * per);
        atlases.push({
          width: Math.min(n, cols) * (cw + GUTTER) - GUTTER,
          height: Math.ceil(n / cols) * (ch + GUTTER) - GUTTER,
        });
        for (let k = 0; k < n; k++)
          frames.push({
            texture: a,
            x: (k % cols) * (cw + GUTTER),
            y: Math.floor(k / cols) * (ch + GUTTER),
          });
      }
      return { cellWidth: cw, cellHeight: ch, scale, atlases, frames };
    }
    // Shrink by about what is missing, a little more each round.
    scale *= Math.min(0.95, Math.sqrt(MAX_ATLASES / need));
  }
}

const i32 = (v: ArrayLike<number>): Int32Array => Int32Array.from(v);
const f32 = (v: ArrayLike<number>): Float32Array => Float32Array.from(v);
const seq = <T = number>(n: number, f: (i: number) => T): T[] =>
  Array.from({ length: n }, (_, i) => f(i));

/**
 * The item model: one quad per frame, as large as the frame (width × height
 * pixels), centered; frame i in part i, which is visible only for frame 0
 * until the app shows another.
 */
export function animatedMocData(width: number, height: number, layout: AtlasLayout): MocData {
  const n = layout.frames.length;
  const ppu = Math.max(width, height);
  const hw = width / ppu / 2;
  const hh = height / ppu / 2;
  const empty = (): Int32Array => new Int32Array(0);
  const emptyF = (): Float32Array => new Float32Array(0);
  const uvs: number[] = [];
  for (const f of layout.frames) {
    const a = layout.atlases[f.texture]!;
    const u0 = f.x / a.width;
    const v0 = f.y / a.height;
    const u1 = (f.x + layout.cellWidth) / a.width;
    const v1 = (f.y + layout.cellHeight) / a.height;
    uvs.push(u0, v0, u1, v0, u1, v1, u0, v1);
  }
  return {
    canvas: {
      pixelsPerUnit: Math.fround(ppu),
      originX: Math.fround(width / 2),
      originY: Math.fround(height / 2),
      width: Math.fround(width),
      height: Math.fround(height),
      flags: 0,
    },
    parts: {
      ids: seq(n, framePartId),
      band: i32(seq(n, () => 0)),
      firstKeyform: i32(seq(n, (i) => i)),
      keyformCount: i32(seq(n, () => 1)),
      initiallyVisible: i32(seq(n, (i) => (i === 0 ? 1 : 0))),
      enabled: i32(seq(n, () => 1)),
      parent: i32(seq(n, () => -1)),
    },
    deformers: {
      ids: [],
      band: empty(),
      visible: empty(),
      enabled: empty(),
      part: empty(),
      parent: empty(),
      kind: empty(),
      kindIndex: empty(),
    },
    warpDeformers: {
      band: empty(),
      firstKeyform: empty(),
      keyformCount: empty(),
      pointCount: empty(),
      rows: empty(),
      columns: empty(),
      bilinear: empty(),
    },
    rotationDeformers: {
      band: empty(),
      firstKeyform: empty(),
      keyformCount: empty(),
      baseAngle: emptyF(),
    },
    artMeshes: {
      ids: seq(n, (i) => `ArtMeshFrame${i}`),
      band: i32(seq(n, () => 0)),
      firstKeyform: i32(seq(n, (i) => i)),
      keyformCount: i32(seq(n, () => 1)),
      visible: i32(seq(n, () => 1)),
      enabled: i32(seq(n, () => 1)),
      part: i32(seq(n, (i) => i)),
      deformer: i32(seq(n, () => -1)),
      texture: i32(layout.frames.map((f) => f.texture)),
      flags: Uint8Array.from(seq(n, () => 0)),
      vertexCount: i32(seq(n, () => 4)),
      firstUv: i32(seq(n, (i) => 8 * i)),
      firstTriangleIndex: i32(seq(n, (i) => 6 * i)),
      triangleIndexCount: i32(seq(n, () => 6)),
      firstMask: i32(seq(n, () => 0)),
      maskCount: i32(seq(n, () => 0)),
    },
    parameters: {
      ids: [],
      max: emptyF(),
      min: emptyF(),
      defaultValue: emptyF(),
      repeat: empty(),
      decimals: empty(),
      firstBinding: empty(),
      bindingCount: empty(),
    },
    partKeyforms: { drawOrder: f32(seq(n, () => 500)) },
    warpKeyforms: { opacity: emptyF(), firstPosition: empty() },
    rotationKeyforms: {
      opacity: emptyF(),
      angle: emptyF(),
      originX: emptyF(),
      originY: emptyF(),
      scale: emptyF(),
      mirrorX: empty(),
      mirrorY: empty(),
    },
    artMeshKeyforms: {
      opacity: f32(seq(n, () => 1)),
      drawOrder: f32(seq(n, () => 500)),
      firstPosition: i32(seq(n, (i) => 8 * i)),
    },
    // Stored y points down: the first two corners are the top ones.
    keyformPositions: f32(seq(n, () => 0).flatMap(() => [-hw, -hh, hw, -hh, hw, hh, -hw, hh])),
    bindingIndices: empty(),
    bands: { firstEntry: i32([0]), entryCount: i32([0]) },
    parameterBindings: { firstKey: empty(), keyCount: empty() },
    keys: emptyF(),
    uvs: f32(uvs),
    triangleIndices: Uint16Array.from(seq(n, () => 0).flatMap(() => [0, 1, 2, 0, 2, 3])),
    maskEntries: empty(),
    drawOrderGroups: {
      firstObject: i32([0]),
      objectCount: i32([n]),
      entryCount: i32([n]),
      maxDrawOrder: i32([1000]),
      minDrawOrder: i32([0]),
    },
    drawOrderGroupObjects: {
      kind: i32(seq(n, () => 0)),
      index: i32(seq(n, (i) => i)),
      nestedGroup: i32(seq(n, () => -1)),
    },
    glues: {
      ids: [],
      band: empty(),
      firstKeyform: empty(),
      keyformCount: empty(),
      artMeshA: empty(),
      artMeshB: empty(),
      firstInfo: empty(),
      infoCount: empty(),
    },
    glueInfo: { weight: emptyF(), vertex: new Uint16Array(0) },
    glueKeyforms: { intensity: emptyF() },
  } as MocData;
}

/** What an animated item's marker says (beside a still image item's name and flip). */
export interface AnimatedMarker {
  name: string;
  flipped: false;
  /** Where the frames came from: an animated GIF, or a folder of PNG frames. */
  source: 'gif' | 'folder';
  frames: number;
  /** The frame rate it came with (a GIF's own timing, or the folder default). */
  fps: number;
  /**
   * Each frame's delay (ms), for a GIF whose frames do not all have the same
   * delay. `fps` is then their average rate, and a rate set by
   * the person or a plugin is a speed factor against it.
   */
  delays?: number[];
}

/**
 * The files of an animated item: the model, its settings file, the atlases
 * as its textures, and the marker (`mochi-image-item.json`, as for still
 * image items, with the frame count).
 */
export function animatedItemFiles(
  atlases: readonly Uint8Array[],
  width: number,
  height: number,
  layout: AtlasLayout,
  marker: AnimatedMarker,
): Array<[string, Uint8Array]> {
  const textures = atlases.map((_, i) => textureName(i));
  return [
    [MOC, writeMoc(animatedMocData(width, height, layout), { version: 3 })],
    ...atlases.map((png, i): [string, Uint8Array] => [textures[i]!, png]),
    [
      SETTINGS,
      strToU8(JSON.stringify({ Version: 3, FileReferences: { Moc: MOC, Textures: textures } })),
    ],
    [IMAGE_ITEM_MARKER, strToU8(JSON.stringify(marker))],
  ];
}

/** The marker of an item's files, if it is an animated item. */
export function animatedMarkerOf(
  files: ReadonlyArray<readonly [string, Uint8Array]>,
): AnimatedMarker | undefined {
  const m = files.find(([p]) => p === IMAGE_ITEM_MARKER)?.[1];
  if (!m) return undefined;
  try {
    const v = JSON.parse(new TextDecoder().decode(m)) as Partial<AnimatedMarker>;
    return typeof v.frames === 'number' &&
      v.frames > 1 &&
      (v.source === 'gif' || v.source === 'folder')
      ? (v as AnimatedMarker)
      : undefined;
  } catch {
    return undefined;
  }
}

/** A GIF's delays (ms) when they differ from frame to frame; undefined when they are all the same. */
export function varyingDelays(delays: readonly number[]): number[] | undefined {
  return delays.length > 1 && delays.some((d) => d !== delays[0]) ? [...delays] : undefined;
}

/** A GIF's frame rate from its frame delays (ms), within 1–60; the folder default without delays. */
export function fpsFromDelays(delays: readonly number[]): number {
  const total = delays.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return DEFAULT_FOLDER_FPS;
  return Math.max(1, Math.min(MAX_FPS, Math.round((1000 * delays.length) / total)));
}

/** Natural order for frame file names: frame2.png before frame10.png. */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}
