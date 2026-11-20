/**
 * A synthetic model of a real streaming model's size, for the frame budget
 * and soak tests. It is not real model data: it is written with
 * Mochi2D's `writeMoc` (docs/moc-data.md), and only its sizes follow
 * DeepSeek-chan's, as measured on that model: 509
 * parameters, 715 art meshes, 5 textures of 4096², physics, 23 expressions.
 *
 * - 40 warp deformers (5 × 5 cells), each bound to ParamAngleY (3 keyforms);
 * - 715 art meshes of 8 × 8 vertices (98 triangles), each bound to
 *   ParamAngleX and one of 500 extra parameters (6 keyforms); 600 of them
 *   sit in the warp deformers, the rest at the root;
 * - every 25th mesh is masked by the one before it;
 * - the meshes use the five textures in turn.
 */
import { validateMoc, writeMoc, type MocData } from 'mochi2d/headless';
import { SYNTHETIC_MOC_VERSION, SYNTHETIC_PARAMETERS, syntheticModelFiles } from './syntheticModel';

export interface HeavyModelOptions {
  meshes?: number;
  /** Vertices per side of each mesh's grid. */
  grid?: number;
  warps?: number;
  extraParameters?: number;
  /** Texture size; 4096 like DeepSeek-chan (smaller loads faster in quick tests). */
  textureSize?: number;
  textures?: number;
}

export const HEAVY_DEFAULTS: Required<HeavyModelOptions> = {
  meshes: 715,
  grid: 8,
  warps: 40,
  extraParameters: 500,
  textureSize: 4096,
  textures: 5,
};

const i32 = (v: ArrayLike<number>): Int32Array => Int32Array.from(v);
const f32 = (v: ArrayLike<number>): Float32Array => Float32Array.from(v);

export function heavyParameters(n = HEAVY_DEFAULTS.extraParameters) {
  return Array.from({ length: n }, (_, j) => ({
    id: `ParamX${String(j).padStart(3, '0')}`,
    min: 0,
    max: 1,
    default: 0,
  }));
}

export function buildHeavyMocData(o: Required<HeavyModelOptions>): MocData {
  const canvasSize = 2048;
  const params = [...SYNTHETIC_PARAMETERS, ...heavyParameters(o.extraParameters)];
  const M = o.meshes;
  const W = o.warps;
  const G = o.grid;
  const V = G * G;

  // Bindings: 0 ParamAngleX (−30, 0, 30), 1 ParamAngleY (same), then one per extra (0, 1).
  const keys = [-30, 0, 30, -30, 0, 30];
  const firstKey = [0, 3];
  const keyCount = [3, 3];
  for (let j = 0; j < o.extraParameters; j++) {
    firstKey.push(keys.length);
    keyCount.push(2);
    keys.push(0, 1);
  }
  const firstBinding: number[] = [];
  const bindingCount: number[] = [];
  let next = 2;
  for (const p of params) {
    if (p.id === 'ParamAngleX') (firstBinding.push(0), bindingCount.push(1));
    else if (p.id === 'ParamAngleY') (firstBinding.push(1), bindingCount.push(1));
    else if (p.id.startsWith('ParamX')) (firstBinding.push(next++), bindingCount.push(1));
    else (firstBinding.push(next), bindingCount.push(0));
  }

  // Bands: 0 empty (the part), 1 [AngleY] (warps), 2 + i [AngleX, extra i % n] (mesh i).
  const bindingIndices: number[] = [1];
  const bandFirst = [0, 0];
  const bandCount = [0, 1];
  for (let i = 0; i < M; i++) {
    bandFirst.push(bindingIndices.length);
    bandCount.push(2);
    bindingIndices.push(0, 2 + (i % o.extraParameters));
  }

  const positions: number[] = [];
  // Warp deformers: a tile each, over the canvas (model units, −0.5 … 0.5).
  const cols = 8;
  const rowsOfTiles = Math.ceil(W / cols);
  const tileW = 0.9 / cols;
  const tileH = 0.9 / rowsOfTiles;
  const warpFirstKeyform: number[] = [];
  const warpKeyformFirstPosition: number[] = [];
  const cells = 5;
  for (let w = 0; w < W; w++) {
    warpFirstKeyform.push(w * 3);
    const x0 = -0.45 + (w % cols) * tileW;
    const y0 = -0.45 + Math.floor(w / cols) * tileH;
    for (let k = 0; k < 3; k++) {
      warpKeyformFirstPosition.push(positions.length);
      for (let r = 0; r <= cells; r++)
        for (let c = 0; c <= cells; c++)
          positions.push(
            x0 + (c / cells) * tileW + (k - 1) * 0.004 * (r / cells),
            y0 + (r / cells) * tileH,
          );
    }
  }

  // Art meshes: an 8 × 8 grid each, 6 keyforms (AngleX × the extra parameter).
  const meshKeyformFirstPosition: number[] = [];
  const meshDrawOrder: number[] = [];
  const uvs: number[] = [];
  const tris: number[] = [];
  const firstUv: number[] = [];
  const firstTri: number[] = [];
  const deformer: number[] = [];
  const maskEntries: number[] = [];
  const firstMask: number[] = [];
  const maskCount: number[] = [];
  const quad: number[] = [];
  for (let r = 0; r < G - 1; r++)
    for (let c = 0; c < G - 1; c++) {
      const a = r * G + c;
      quad.push(a, a + 1, a + G + 1, a, a + G + 1, a + G);
    }
  for (let i = 0; i < M; i++) {
    const inWarp = i < Math.min(M, W * 15);
    deformer.push(inWarp ? i % W : -1);
    // In a warp: its local square (0 … 1); at the root: a small square in model units.
    const local = inWarp;
    const cx = local ? 0.5 : -0.4 + ((i * 37) % 80) / 100;
    const cy = local ? 0.5 : -0.4 + ((i * 53) % 80) / 100;
    const half = local ? 0.3 + (i % 5) * 0.03 : 0.05;
    for (let k = 0; k < 6; k++) {
      meshKeyformFirstPosition.push(positions.length);
      meshDrawOrder.push(100 + ((i * 7) % 800));
      const dx = ((k % 3) - 1) * half * 0.05;
      const grow = 1 + Math.floor(k / 3) * 0.05;
      for (let r = 0; r < G; r++)
        for (let c = 0; c < G; c++)
          positions.push(
            cx + dx + (c / (G - 1) - 0.5) * 2 * half * grow,
            cy + (r / (G - 1) - 0.5) * 2 * half * grow,
          );
    }
    firstUv.push(uvs.length);
    const u0 = ((i % 16) / 16) * 0.9;
    const v0 = ((Math.floor(i / 16) % 16) / 16) * 0.9;
    for (let r = 0; r < G; r++)
      for (let c = 0; c < G; c++) uvs.push(u0 + (c / (G - 1)) * 0.05, v0 + (r / (G - 1)) * 0.05);
    firstTri.push(tris.length);
    tris.push(...quad);
    const masked = i > 0 && i % 25 === 0;
    firstMask.push(maskEntries.length);
    maskCount.push(masked ? 1 : 0);
    if (masked) maskEntries.push(i - 1);
  }

  const ones = (n: number) => i32(Array(n).fill(1));
  const zeros = (n: number) => i32(Array(n).fill(0));
  const emptyI = () => new Int32Array(0);
  const emptyF = () => new Float32Array(0);
  const meshIds = Array.from({ length: M }, (_, i) => `ArtMesh${i}`);

  return {
    canvas: {
      pixelsPerUnit: Math.fround(canvasSize),
      originX: Math.fround(canvasSize / 2),
      originY: Math.fround(canvasSize / 2),
      width: Math.fround(canvasSize),
      height: Math.fround(canvasSize),
      flags: 0,
    },
    parts: {
      ids: ['PartRoot'],
      band: i32([0]),
      firstKeyform: i32([0]),
      keyformCount: i32([1]),
      initiallyVisible: i32([1]),
      enabled: i32([1]),
      parent: i32([-1]),
    },
    deformers: {
      ids: Array.from({ length: W }, (_, w) => `Warp${w}`),
      band: i32(Array(W).fill(1)),
      visible: ones(W),
      enabled: ones(W),
      part: zeros(W),
      parent: i32(Array(W).fill(-1)),
      kind: zeros(W),
      kindIndex: i32(Array.from({ length: W }, (_, w) => w)),
    },
    warpDeformers: {
      band: i32(Array(W).fill(1)),
      firstKeyform: i32(warpFirstKeyform),
      keyformCount: i32(Array(W).fill(3)),
      pointCount: i32(Array(W).fill((cells + 1) * (cells + 1))),
      rows: i32(Array(W).fill(cells)),
      columns: i32(Array(W).fill(cells)),
      bilinear: zeros(W),
    },
    rotationDeformers: {
      band: emptyI(),
      firstKeyform: emptyI(),
      keyformCount: emptyI(),
      baseAngle: emptyF(),
    },
    artMeshes: {
      ids: meshIds,
      band: i32(Array.from({ length: M }, (_, i) => 2 + i)),
      firstKeyform: i32(Array.from({ length: M }, (_, i) => i * 6)),
      keyformCount: i32(Array(M).fill(6)),
      visible: ones(M),
      enabled: ones(M),
      part: zeros(M),
      deformer: i32(deformer),
      texture: i32(Array.from({ length: M }, (_, i) => i % o.textures)),
      flags: new Uint8Array(M),
      vertexCount: i32(Array(M).fill(V)),
      firstUv: i32(firstUv),
      firstTriangleIndex: i32(firstTri),
      triangleIndexCount: i32(Array(M).fill(quad.length)),
      firstMask: i32(firstMask),
      maskCount: i32(maskCount),
    },
    parameters: {
      ids: params.map((p) => p.id),
      max: f32(params.map((p) => p.max)),
      min: f32(params.map((p) => p.min)),
      defaultValue: f32(params.map((p) => p.default)),
      repeat: zeros(params.length),
      decimals: i32(Array(params.length).fill(3)),
      firstBinding: i32(firstBinding),
      bindingCount: i32(bindingCount),
    },
    partKeyforms: { drawOrder: f32([500]) },
    warpKeyforms: {
      opacity: f32(Array(W * 3).fill(1)),
      firstPosition: i32(warpKeyformFirstPosition),
    },
    rotationKeyforms: {
      opacity: emptyF(),
      angle: emptyF(),
      originX: emptyF(),
      originY: emptyF(),
      scale: emptyF(),
      mirrorX: emptyI(),
      mirrorY: emptyI(),
    },
    artMeshKeyforms: {
      opacity: f32(Array(M * 6).fill(1)),
      drawOrder: f32(meshDrawOrder),
      firstPosition: i32(meshKeyformFirstPosition),
    },
    keyformPositions: f32(positions),
    bindingIndices: i32(bindingIndices),
    bands: { firstEntry: i32(bandFirst), entryCount: i32(bandCount) },
    parameterBindings: { firstKey: i32(firstKey), keyCount: i32(keyCount) },
    keys: f32(keys),
    uvs: f32(uvs),
    triangleIndices: Uint16Array.from(tris),
    maskEntries: i32(maskEntries),
    drawOrderGroups: {
      firstObject: i32([0]),
      objectCount: i32([M]),
      entryCount: i32([M]),
      maxDrawOrder: i32([1000]),
      minDrawOrder: i32([0]),
    },
    drawOrderGroupObjects: {
      kind: zeros(M),
      index: i32(Array.from({ length: M }, (_, i) => i)),
      nestedGroup: i32(Array(M).fill(-1)),
    },
    glues: {
      ids: [],
      band: emptyI(),
      firstKeyform: emptyI(),
      keyformCount: emptyI(),
      artMeshA: emptyI(),
      artMeshB: emptyI(),
      firstInfo: emptyI(),
      infoCount: emptyI(),
    },
    glueInfo: { weight: emptyF(), vertex: new Uint16Array(0) },
    glueKeyforms: { intensity: emptyF() },
  };
}

export function buildHeavyMoc(opts: HeavyModelOptions = {}): Uint8Array {
  const o = { ...HEAVY_DEFAULTS, ...opts };
  const data = buildHeavyMocData(o);
  const check = validateMoc(data, { version: SYNTHETIC_MOC_VERSION, level: 'strict' });
  const errors = check.diagnostics.filter((d) => d.severity === 'error');
  if (errors.length)
    throw new Error(
      'heavy moc is invalid:\n' +
        errors
          .slice(0, 10)
          .map((d) => `${d.code} ${d.kind}[${d.index ?? ''}].${d.field ?? ''}: ${d.message}`)
          .join('\n'),
    );
  return writeMoc(data, { version: SYNTHETIC_MOC_VERSION });
}

/** The model folder's files (paths relative to the folder). */
export function heavyModelFiles(opts: HeavyModelOptions = {}): Record<string, Uint8Array> {
  const o = { ...HEAVY_DEFAULTS, ...opts };
  const files = syntheticModelFiles({
    name: 'heavy',
    textureSize: o.textureSize,
    compressTextures: true,
    textures: o.textures,
    withPhysics: true,
    extraParameters: heavyParameters(o.extraParameters),
    // 23 expressions, as DeepSeek-chan has.
    extraFiles: 22,
  });
  files['heavy.moc3'] = buildHeavyMoc(o);
  return files;
}
