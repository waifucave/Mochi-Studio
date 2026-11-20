// Builds a tiny, made-up model folder entirely from code, for unit tests and
// browser-test setup. Nothing here comes from a real model: the `.moc3` is
// assembled as Mochi2D `MocData` and written with Mochi2D's documented
// `writeMoc` (node_modules/mochi2d/docs/moc-data.md), and the JSON files follow
// the shapes Mochi2D's parsers describe in their type declarations
// (model-settings.d.ts, motion.d.ts, expression.d.ts, model-data.d.ts,
// item-settings.d.ts).

import { strToU8 } from 'fflate';
import { encodePng } from '../../src/core/png';
import {
  MOTION_SYNC_ANALYSIS_TYPE,
  MOTION_SYNC_ELEMENTS,
  validateMoc,
  writeMoc,
  writeMotionSync,
  writePhysics,
  type MocData,
  type MocVersion,
} from 'mochi2d/headless';

export interface SyntheticModelOptions {
  /** Base name of the files (`<name>.model3.json`, `<name>.moc3`, ...). Default "test". */
  name?: string;
  /** Body color as 0–255 RGB. The mouth is drawn in a darker shade of it. */
  color?: [number, number, number];
  /**
   * Build an item model instead of a main model: a smaller canvas, no
   * expressions, motions or display info, and a `<name>.vtube.json` holding an
   * `ItemSettings` object (the item settings Mochi2D reads, docs/api.md "Items").
   */
  withItemExtras?: boolean;
  /**
   * For load-time benchmarks: the texture's width and height (default 64),
   * filled with noise so it does not compress (4096 gives about 64 MB).
   */
  textureSize?: number;
  /**
   * Deflate the noise textures (PNG level 6), so a 4096² texture is about as
   * large as a real model's (about 12 MB) instead of 64 MB. Default false.
   */
  compressTextures?: boolean;
  /**
   * For benchmarks: more files, like a real model's folder: this many
   * textures (the extra ones unused by the meshes) and this many extra
   * expression and motion files. Default 1 and 0.
   */
  textures?: number;
  extraFiles?: number;
  /** Parameters besides the usual ones (no mesh uses them), e.g. ParamA … ParamO for vowels. */
  extraParameters?: ReadonlyArray<{ id: string; min: number; max: number; default: number }>;
  /**
   * A physics file (`<name>.physics3.json`, written with Mochi2D's
   * `writePhysics`): "Hair" drives ParamAngleX from ParamCustom (it
   * overwrites it), and an unnamed second setting moves ParamBodyAngleX
   * from ParamAngleZ at half weight.
   */
  withPhysics?: boolean;
  /**
   * A motion-sync file (`<name>.motionsync3.json`, written with Mochi2D's
   * `writeMotionSync`): one setting, "Mouth basic", whose
   * vowels open and shape the mouth (ParamMouthOpenY, ParamMouthForm).
   */
  withMotionSync?: boolean;
  /**
   * The mouth's draw order changes with ParamMouthOpenY: closed
   * it is drawn over the body (600), open behind it (200).
   */
  mouthBehindWhenOpen?: boolean;
}

/** Each element's mouth: [ParamMouthOpenY, ParamMouthForm], in MOTION_SYNC_ELEMENTS order. */
export const MOTION_SYNC_SHAPES: Record<(typeof MOTION_SYNC_ELEMENTS)[number], [number, number]> = {
  Silence: [0, 0],
  A: [1, 0.1],
  I: [0.35, 1],
  U: [0.3, -0.8],
  E: [0.55, 0.6],
  O: [0.7, -1],
};

/** The synthetic motion-sync settings (Mochi2D's setting data, anim/motion-sync/file.d.ts), as file text. */
export function syntheticMotionSync(): string {
  return writeMotionSync({
    settings: [
      {
        id: 'MotionSync1',
        name: 'Mouth basic',
        analysisType: MOTION_SYNC_ANALYSIS_TYPE,
        useCase: 'Mouth',
        parameters: [
          { id: 'ParamMouthOpenY', name: 'Mouth open', min: 0, max: 1, damper: 0, smooth: 0 },
          { id: 'ParamMouthForm', name: 'Mouth form', min: -1, max: 1, damper: 0, smooth: 0 },
        ],
        elements: MOTION_SYNC_ELEMENTS.map((id) => ({
          id,
          name: id,
          min: 0,
          max: 1,
          scale: 1,
          enabled: true,
        })),
        shapes: MOTION_SYNC_ELEMENTS.map((e) => [...MOTION_SYNC_SHAPES[e]]),
        // The most likely element's shape, with little smoothing: easy to check.
        blendRatio: 0,
        smoothing: 1,
        sampleRate: 30,
      },
    ],
  });
}

/** Two pendulum particles: a root that follows the input, and a weight hanging from it. */
const PENDULUM = [
  { x: 0, y: 0, mobility: 1, delay: 1, acceleration: 1, radius: 0 },
  { x: 0, y: 10, mobility: 0.95, delay: 0.9, acceleration: 1.5, radius: 10 },
];
const NORMAL = {
  position: { minimum: -10, default: 0, maximum: 10 },
  angle: { minimum: -10, default: 0, maximum: 10 },
};

/** The synthetic physics data (Mochi2D's `PhysicsFile`, anim/physics.d.ts), as file text. */
export function syntheticPhysics(): string {
  return writePhysics({
    fps: 30,
    settings: [
      {
        id: 'PhysicsSetting1',
        inputs: [{ source: 'ParamCustom', weight: 100, type: 'X', reflect: false }],
        outputs: [
          {
            destination: 'ParamAngleX',
            vertexIndex: 1,
            scale: 30,
            weight: 100,
            type: 'Angle',
            reflect: false,
          },
        ],
        particles: PENDULUM,
        ...NORMAL,
      },
      {
        id: 'PhysicsSetting2',
        inputs: [{ source: 'ParamAngleZ', weight: 100, type: 'Angle', reflect: false }],
        outputs: [
          {
            destination: 'ParamBodyAngleX',
            vertexIndex: 1,
            scale: 1,
            weight: 50,
            type: 'Angle',
            reflect: false,
          },
        ],
        particles: PENDULUM,
        ...NORMAL,
      },
    ],
    names: [{ id: 'PhysicsSetting1', name: 'Hair' }],
  });
}

/** Version written. Version 3 is the newest one without color entries and blend-shape groups. */
export const SYNTHETIC_MOC_VERSION: MocVersion = 3;

/** Parameters of the synthetic model: id, min, max, default. */
export const SYNTHETIC_PARAMETERS: readonly {
  id: string;
  min: number;
  max: number;
  default: number;
}[] = [
  { id: 'ParamAngleX', min: -30, max: 30, default: 0 },
  { id: 'ParamAngleY', min: -30, max: 30, default: 0 },
  { id: 'ParamAngleZ', min: -30, max: 30, default: 0 },
  { id: 'ParamEyeLOpen', min: 0, max: 1, default: 1 },
  { id: 'ParamEyeROpen', min: 0, max: 1, default: 1 },
  { id: 'ParamMouthOpenY', min: 0, max: 1, default: 0 },
  { id: 'ParamMouthForm', min: -1, max: 1, default: 0 },
  { id: 'ParamBodyAngleX', min: -10, max: 10, default: 0 },
  { id: 'ParamCustom', min: 0, max: 1, default: 0 },
];

/** Art-mesh IDs, in mesh order. */
export const SYNTHETIC_MESH_IDS = ['ArtMeshBody', 'ArtMeshMouth'] as const;

/** Returns the files of a model folder, paths relative to the folder (no folder prefix). */
export function syntheticModelFiles(opts: SyntheticModelOptions = {}): Record<string, Uint8Array> {
  const item = opts.withItemExtras ?? false;
  const name = opts.name ?? (item ? 'hat' : 'test');
  const color = opts.color ?? (item ? [60, 120, 220] : [240, 180, 150]);
  const canvasSize = item ? 256 : 512;

  const files: Record<string, Uint8Array> = {};
  const params = [...SYNTHETIC_PARAMETERS, ...(opts.extraParameters ?? [])];
  files[`${name}.moc3`] = buildMoc(canvasSize, params, opts.mouthBehindWhenOpen ?? false);
  files['texture_00.png'] = opts.textureSize
    ? buildNoiseTexture(color, opts.textureSize, opts.compressTextures ? 6 : 0)
    : buildTexture(color);

  const json = (value: unknown): Uint8Array => strToU8(JSON.stringify(value, null, 2));

  // The settings file (`*.model3.json`). Mochi2D's ModelSettings type
  // (core/settings/model-settings.d.ts) lists what it reads: the moc and
  // texture paths, display info, named expressions, motion groups, and
  // parameter groups (`Target`/`Name`/`Ids`), here LipSync and EyeBlink.
  const textureNames = Array.from(
    { length: Math.max(1, opts.textures ?? 1) },
    (_, i) => `texture_${String(i).padStart(2, '0')}.png`,
  );
  for (const t of textureNames.slice(1)) files[t] = files['texture_00.png']!;
  const fileReferences: Record<string, unknown> = {
    Moc: `${name}.moc3`,
    Textures: textureNames,
  };
  if (opts.withPhysics) {
    fileReferences.Physics = `${name}.physics3.json`;
    files[`${name}.physics3.json`] = strToU8(syntheticPhysics());
  }
  if (opts.withMotionSync) {
    fileReferences.MotionSync = `${name}.motionsync3.json`;
    files[`${name}.motionsync3.json`] = strToU8(syntheticMotionSync());
  }
  if (!item) {
    fileReferences.DisplayInfo = `${name}.cdi3.json`;
    fileReferences.Expressions = [{ Name: 'Blush', File: 'blush.exp3.json' }];
    fileReferences.Motions = { Wave: [{ File: 'wave.motion3.json' }] };
  }
  const settings = {
    Version: 3,
    FileReferences: fileReferences,
    Groups: [
      { Target: 'Parameter', Name: 'LipSync', Ids: ['ParamMouthOpenY'] },
      { Target: 'Parameter', Name: 'EyeBlink', Ids: ['ParamEyeLOpen', 'ParamEyeROpen'] },
    ],
  };
  files[`${name}.model3.json`] = json(settings);

  if (item) {
    // Item settings (lib/items/item-settings.d.ts): only the `ItemSettings`
    // object of a `*.vtube.json` next to the settings file is read. The head
    // angles of the main model are forwarded with these factors.
    files[`${name}.vtube.json`] = json({
      ItemSettings: {
        Multiplier_HeadAngleX: 1,
        Multiplier_HeadAngleY: 1,
        Multiplier_HeadAngleZ: 1,
        Shift_HeadAngleX: 0,
        Shift_HeadAngleY: 0,
        Shift_HeadAngleZ: 0,
        Smoothing_HeadAngleX: 0,
        Smoothing_HeadAngleY: 0,
        Smoothing_HeadAngleZ: 0,
        OnlyMoveWhenPinned: false,
        AllowNormalHotkeyTriggers: true,
      },
    });
    return files;
  }

  // Display info (`parseDisplayInfo`, anim/model-data.d.ts): names for the
  // parameters, plus (empty) parameter groups and parts.
  files[`${name}.cdi3.json`] = json({
    Version: 3,
    Parameters: params.map((p) => ({
      Id: p.id,
      GroupId: '',
      Name: displayName(p.id),
    })),
    ParameterGroups: [],
    Parts: [],
  });

  // An expression (`parseExpression`, anim/expression.d.ts): a fade in/out
  // and per-parameter values with a blend of Add, Multiply or Overwrite.
  files['blush.exp3.json'] = json({
    FadeInTime: 0.3,
    FadeOutTime: 0.3,
    Parameters: [
      { Id: 'ParamCustom', Value: 1, Blend: 'Overwrite' },
      { Id: 'ParamMouthForm', Value: 0.5, Blend: 'Add' },
    ],
  });

  // A 0.5 s motion (`parseMotion`, anim/motion.d.ts). Each curve's `Segments`
  // array starts with one point (t, v) and continues with a segment kind
  // (0 = linear) followed by that segment's end point.
  const curves = [
    {
      Target: 'Parameter',
      Id: 'ParamAngleZ',
      Segments: [0, 0, 0, 0.25, 15, 0, 0.5, 0],
    },
    {
      Target: 'Parameter',
      Id: 'ParamAngleX',
      Segments: [0, 0, 0, 0.25, -20, 0, 0.5, 0],
    },
  ];
  files['wave.motion3.json'] = json({
    Version: 3,
    Meta: {
      Duration: 0.5,
      Fps: 30,
      Loop: false,
      AreBeziersRestricted: true,
      CurveCount: curves.length,
      // Each curve: one initial point and two linear segments of one point each.
      TotalSegmentCount: curves.length * 2,
      TotalPointCount: curves.length * 3,
      UserDataCount: 0,
      TotalUserDataSize: 0,
    },
    Curves: curves,
  });

  // Benchmarks: extra expression and motion files in the folder, unlisted
  // (Mochi Studio offers files found in the folder only when the settings
  // list none, so these are listed under their own names).
  for (let i = 0; i < (opts.extraFiles ?? 0); i++) {
    files[`extra/blush_${i}.exp3.json`] = files['blush.exp3.json']!;
    files[`extra/wave_${i}.motion3.json`] = files['wave.motion3.json']!;
    (fileReferences.Expressions as unknown[]).push({
      Name: `Blush ${i}`,
      File: `extra/blush_${i}.exp3.json`,
    });
    ((fileReferences.Motions as Record<string, unknown[]>).Wave as unknown[]).push({
      File: `extra/wave_${i}.motion3.json`,
    });
  }
  files[`${name}.model3.json`] = json(settings);
  return files;
}

/** "ParamMouthOpenY" → "Mouth Open Y". */
function displayName(id: string): string {
  return id.replace(/^Param/, '').replace(/([a-z])([A-Z])/g, '$1 $2');
}

// ---------------------------------------------------------------------------
// The `.moc3` file
// ---------------------------------------------------------------------------

/**
 * Builds and writes the `.moc3`. The structure (docs/moc-data.md, "MocData",
 * and the doc comments of core/moc/data.d.ts):
 *
 * - One root part, with one keyform and an empty band (no parameter moves it).
 * - No deformers: both art meshes have `deformer = -1`, so their keyform
 *   positions are model-space coordinates directly.
 * - Two art meshes of 4 vertices and 2 triangles each, both on texture 0:
 *   - the body, bound to ParamAngleX with keys −30, 0, 30 (3 keyforms that
 *     slide it left/right);
 *   - the mouth, bound to ParamMouthOpenY with keys 0 and 1 (2 keyforms:
 *     a thin slit and a tall opening).
 * - Parameter bindings: each binding is a run of `keys` and is owned by exactly
 *   one parameter (`firstBinding`/`bindingCount`). A keyform binding ("band")
 *   is a run of `bindingIndices`, and an object's keyform count is the product
 *   of its bindings' key counts (1 for an empty band). Parameters no mesh uses
 *   own no bindings.
 * - One draw-order group (group 0, the root) listing the two art meshes.
 *
 * The data is checked with `validateMoc` at the strict level before writing;
 * any error throws, so a test sees the reason at once.
 */
function buildMoc(
  canvasSize: number,
  params = SYNTHETIC_PARAMETERS,
  mouthBehindWhenOpen = false,
): Uint8Array {
  const data = buildMocData(canvasSize, params, mouthBehindWhenOpen);
  const check = validateMoc(data, { version: SYNTHETIC_MOC_VERSION, level: 'strict' });
  const errors = check.diagnostics.filter((d) => d.severity === 'error');
  if (errors.length > 0) {
    throw new Error(
      'synthetic moc is invalid:\n' +
        errors
          .map((d) => `${d.code} ${d.kind}[${d.index ?? ''}].${d.field ?? ''}: ${d.message}`)
          .join('\n'),
    );
  }
  return writeMoc(data, { version: SYNTHETIC_MOC_VERSION });
}

/** A rectangle's 4 corners (x, y pairs): top-left, top-right, bottom-right, bottom-left. */
function rect(cx: number, cy: number, halfW: number, halfH: number): number[] {
  return [
    cx - halfW,
    cy - halfH,
    cx + halfW,
    cy - halfH,
    cx + halfW,
    cy + halfH,
    cx - halfW,
    cy + halfH,
  ];
}

/** UVs of the same corner order over a texture region (v stored top-down, docs/moc-data.md). */
function uvRect(u0: number, v0: number, u1: number, v1: number): number[] {
  return [u0, v0, u1, v0, u1, v1, u0, v1];
}

const i32 = (values: number[]): Int32Array => Int32Array.from(values);
const f32 = (values: number[]): Float32Array => Float32Array.from(values);

export function buildMocData(
  canvasSize: number,
  params = SYNTHETIC_PARAMETERS,
  mouthBehindWhenOpen = false,
): MocData {
  // Canvas (§1b.4): `pixelsPerUnit` canvas pixels per model unit, and the
  // model origin in canvas pixels from the top-left corner. With one unit
  // spanning the whole canvas and the origin at its center, the canvas covers
  // model coordinates −0.5 … 0.5 in both directions.
  const canvas = {
    pixelsPerUnit: Math.fround(canvasSize),
    originX: Math.fround(canvasSize / 2),
    originY: Math.fround(canvasSize / 2),
    width: Math.fround(canvasSize),
    height: Math.fround(canvasSize),
    flags: 0,
  };

  // Parameters. Only ParamAngleX (binding 0) and ParamMouthOpenY (binding 1)
  // own bindings; the others have a count of 0.
  const bindingOwner: Record<string, number> = { ParamAngleX: 0, ParamMouthOpenY: 1 };
  const firstBinding: number[] = [];
  const bindingCount: number[] = [];
  let nextBinding = 0;
  for (const p of params) {
    const owned = bindingOwner[p.id];
    if (owned !== undefined) {
      firstBinding.push(owned);
      bindingCount.push(1);
      nextBinding = owned + 1;
    } else {
      firstBinding.push(nextBinding);
      bindingCount.push(0);
    }
  }

  // Keys of the two bindings, ascending within each.
  const keys = f32([-30, 0, 30, 0, 1]);
  const parameterBindings = { firstKey: i32([0, 3]), keyCount: i32([3, 2]) };

  // Bands: 0 = empty (the part), 1 = [binding 0] (body), 2 = [binding 1] (mouth).
  const bindingIndices = i32([0, 1]);
  const bands = { firstEntry: i32([0, 0, 1]), entryCount: i32([0, 1, 1]) };

  // Keyform positions. Body: a large quad that slides with ParamAngleX.
  // Mouth: a slit (closed) or a tall box (open), below the body's center.
  // Stored positions have y pointing down; with canvas flag bit 0 clear the
  // runtime converts them to output space with y up (instance.d.ts:
  // "y up unless canvas flag bit 0"), so stored y = +0.2 ends up below the
  // center (output y = −0.2), and `rect`'s first two corners are the top ones.
  const bodyHalfW = 0.36;
  const bodyHalfH = 0.44;
  const shift = 0.08;
  const mouthY = 0.2;
  const positions = [
    ...rect(-shift, 0, bodyHalfW, bodyHalfH), // ParamAngleX = −30
    ...rect(0, 0, bodyHalfW, bodyHalfH), // ParamAngleX = 0
    ...rect(shift, 0, bodyHalfW, bodyHalfH), // ParamAngleX = 30
    ...rect(0, mouthY, 0.12, 0.01), // ParamMouthOpenY = 0 (closed)
    ...rect(0, mouthY, 0.12, 0.08), // ParamMouthOpenY = 1 (open)
  ];

  // UVs: the body samples the texture's left half, the mouth its right half
  // (see buildTexture).
  const uvs = f32([...uvRect(0.05, 0.05, 0.45, 0.95), ...uvRect(0.55, 0.05, 0.95, 0.95)]);

  // Two triangles per quad, local to each mesh.
  const triangleIndices = Uint16Array.from([0, 1, 2, 0, 2, 3, 0, 1, 2, 0, 2, 3]);

  const empty = (): Int32Array => new Int32Array(0);
  const emptyF = (): Float32Array => new Float32Array(0);

  return {
    canvas,
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
      bilinear: empty(), // from version 2
    },
    rotationDeformers: {
      band: empty(),
      firstKeyform: empty(),
      keyformCount: empty(),
      baseAngle: emptyF(),
    },
    artMeshes: {
      ids: [...SYNTHETIC_MESH_IDS],
      band: i32([1, 2]),
      firstKeyform: i32([0, 3]),
      keyformCount: i32([3, 2]),
      visible: i32([1, 1]),
      enabled: i32([1, 1]),
      part: i32([0, 0]),
      deformer: i32([-1, -1]),
      texture: i32([0, 0]),
      flags: Uint8Array.from([0, 0]),
      vertexCount: i32([4, 4]),
      firstUv: i32([0, 8]),
      firstTriangleIndex: i32([0, 6]),
      triangleIndexCount: i32([6, 6]),
      firstMask: i32([0, 0]),
      maskCount: i32([0, 0]),
    },
    parameters: {
      ids: params.map((p) => p.id),
      max: f32(params.map((p) => p.max)),
      min: f32(params.map((p) => p.min)),
      defaultValue: f32(params.map((p) => p.default)),
      repeat: i32(params.map(() => 0)),
      decimals: i32(params.map(() => 1)),
      firstBinding: i32(firstBinding),
      bindingCount: i32(bindingCount),
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
    // Body keyforms 0–2 (draw order 400), mouth keyforms 3–4 (draw order 600,
    // so the mouth is drawn over the body).
    artMeshKeyforms: {
      opacity: f32([1, 1, 1, 1, 1]),
      drawOrder: f32([400, 400, 400, 600, mouthBehindWhenOpen ? 200 : 600]),
      firstPosition: i32([0, 8, 16, 24, 32]),
    },
    keyformPositions: f32(positions),
    bindingIndices,
    bands,
    parameterBindings,
    keys,
    uvs,
    triangleIndices,
    maskEntries: empty(),
    drawOrderGroups: {
      firstObject: i32([0]),
      objectCount: i32([2]),
      entryCount: i32([2]),
      maxDrawOrder: i32([1000]),
      minDrawOrder: i32([0]),
    },
    drawOrderGroupObjects: { kind: i32([0, 0]), index: i32([0, 1]), nestedGroup: i32([-1, -1]) },
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
  };
}

// ---------------------------------------------------------------------------
// The texture: a minimal PNG encoder
// ---------------------------------------------------------------------------

const TEXTURE_SIZE = 64;

/**
 * A 64×64 RGBA texture: the left half is the body color, the right half a
 * darker shade for the mouth, all opaque except a transparent 1-pixel frame.
 */
function buildTexture(color: [number, number, number]): Uint8Array {
  const n = TEXTURE_SIZE;
  const rgba = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const o = (y * n + x) * 4;
      const edge = x === 0 || y === 0 || x === n - 1 || y === n - 1;
      const shade = x < n / 2 ? 1 : 0.35;
      rgba[o] = Math.round(color[0] * shade);
      rgba[o + 1] = Math.round(color[1] * shade);
      rgba[o + 2] = Math.round(color[2] * shade);
      rgba[o + 3] = edge ? 0 : 255;
    }
  }
  return encodePng(n, n, rgba);
}

/**
 * A large texture for benchmarks: the same two halves with a little noise,
 * stored without compression, so the file is about width × height × 4 bytes.
 */
function buildNoiseTexture(
  color: [number, number, number],
  n: number,
  level: 0 | 6 = 0,
): Uint8Array {
  const rgba = new Uint8Array(n * n * 4);
  let seed = 12345;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const o = (y * n + x) * 4;
      seed = (seed * 1103515245 + 12345) >>> 0;
      const jitter = ((seed >>> 16) & 15) - 8;
      const shade = x < n / 2 ? 1 : 0.35;
      rgba[o] = Math.max(0, Math.min(255, Math.round(color[0] * shade) + jitter));
      rgba[o + 1] = Math.max(0, Math.min(255, Math.round(color[1] * shade) + jitter));
      rgba[o + 2] = Math.max(0, Math.min(255, Math.round(color[2] * shade) + jitter));
      rgba[o + 3] = 255;
    }
  }
  return encodePng(n, n, rgba, level);
}

/** Encodes 8-bit RGBA pixels as a PNG (the app's own encoder). */
export { encodePng };
