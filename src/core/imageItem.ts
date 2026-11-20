/**
 * Image items: a PNG or JPEG dropped on the stage becomes an item. Mochi2D's
 * items are models, so the image becomes a model of one quad that shows it,
 * written with Mochi2D's `writeMoc` (its moc-data format, docs/moc-data.md).
 */
import { strToU8 } from 'fflate';
import { writeMoc, type MocData } from 'mochi2d/headless';

/** The marker file of an image item (and whether its picture is mirrored). */
export const IMAGE_ITEM_MARKER = 'mochi-image-item.json';
export const IMAGE_ITEM_TEXTURE = 'texture_00.png';
const MOC = 'image.moc3';
const SETTINGS = 'image.model3.json';

const i32 = (v: number[]): Int32Array => Int32Array.from(v);
const f32 = (v: number[]): Float32Array => Float32Array.from(v);

/** A model of one quad as large as the image (w × h pixels), centered. */
export function imageMocData(width: number, height: number): MocData {
  const ppu = Math.max(width, height);
  const hw = width / ppu / 2;
  const hh = height / ppu / 2;
  const empty = (): Int32Array => new Int32Array(0);
  const emptyF = (): Float32Array => new Float32Array(0);
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
      ids: ['PartImage'],
      band: i32([0]),
      firstKeyform: i32([0]),
      keyformCount: i32([1]),
      initiallyVisible: i32([1]),
      enabled: i32([1]),
      parent: i32([-1]),
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
      ids: ['ArtMeshImage'],
      band: i32([0]),
      firstKeyform: i32([0]),
      keyformCount: i32([1]),
      visible: i32([1]),
      enabled: i32([1]),
      part: i32([0]),
      deformer: i32([-1]),
      texture: i32([0]),
      flags: Uint8Array.from([0]),
      vertexCount: i32([4]),
      firstUv: i32([0]),
      firstTriangleIndex: i32([0]),
      triangleIndexCount: i32([6]),
      firstMask: i32([0]),
      maskCount: i32([0]),
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
    partKeyforms: { drawOrder: f32([500]) },
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
    artMeshKeyforms: { opacity: f32([1]), drawOrder: f32([500]), firstPosition: i32([0]) },
    // Stored y points down: the first two corners are the top ones.
    keyformPositions: f32([-hw, -hh, hw, -hh, hw, hh, -hw, hh]),
    bindingIndices: empty(),
    bands: { firstEntry: i32([0]), entryCount: i32([0]) },
    parameterBindings: { firstKey: empty(), keyCount: empty() },
    keys: emptyF(),
    uvs: f32([0, 0, 1, 0, 1, 1, 0, 1]),
    triangleIndices: Uint16Array.from([0, 1, 2, 0, 2, 3]),
    maskEntries: empty(),
    drawOrderGroups: {
      firstObject: i32([0]),
      objectCount: i32([1]),
      entryCount: i32([1]),
      maxDrawOrder: i32([1000]),
      minDrawOrder: i32([0]),
    },
    drawOrderGroupObjects: { kind: i32([0]), index: i32([0]), nestedGroup: i32([-1]) },
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

/**
 * The files of an image item: the quad model, its settings file, the PNG as
 * its texture, and the marker.
 */
export function imageItemFiles(
  png: Uint8Array,
  width: number,
  height: number,
  marker: { name: string; flipped: boolean },
): Array<[string, Uint8Array]> {
  return [
    [MOC, writeMoc(imageMocData(width, height), { version: 3 })],
    [IMAGE_ITEM_TEXTURE, png],
    [
      SETTINGS,
      strToU8(
        JSON.stringify({
          Version: 3,
          FileReferences: { Moc: MOC, Textures: [IMAGE_ITEM_TEXTURE] },
        }),
      ),
    ],
    [IMAGE_ITEM_MARKER, strToU8(JSON.stringify(marker))],
  ];
}
