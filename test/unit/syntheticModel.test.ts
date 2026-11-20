// Checks the synthetic model folder of test/support/syntheticModel.ts with
// Mochi2D itself: the `.moc3` validates, the folder loads in a headless
// runtime, the mouth and head parameters move the meshes, and the motion,
// expression and item model work.
import {
  MemoryFileSource,
  ModelRuntime,
  parseMotion,
  MOTION_SYNC_ELEMENTS,
  parseMotionSync,
  parsePhysics,
  readMoc,
  validateMoc,
  writeMotionSync,
  writePhysics,
} from 'mochi2d/headless';
import { describe, expect, it } from 'vitest';
import {
  SYNTHETIC_MESH_IDS,
  SYNTHETIC_MOC_VERSION,
  SYNTHETIC_PARAMETERS,
  syntheticModelFiles,
} from '../support/syntheticModel';

function load(files: Record<string, Uint8Array>, settings: string): Promise<ModelRuntime> {
  return ModelRuntime.load(new MemoryFileSource('synthetic', Object.entries(files)), settings);
}

const MOUTH = SYNTHETIC_MESH_IDS.indexOf('ArtMeshMouth');
const BODY = SYNTHETIC_MESH_IDS.indexOf('ArtMeshBody');

describe('synthetic model', () => {
  const files = syntheticModelFiles();

  it('has the expected files', () => {
    expect(Object.keys(files).sort()).toEqual(
      [
        'blush.exp3.json',
        'test.cdi3.json',
        'test.model3.json',
        'test.moc3',
        'texture_00.png',
        'wave.motion3.json',
      ].sort(),
    );
    const png = files['texture_00.png']!;
    expect(Array.from(png.subarray(0, 8))).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
  });

  it('writes a .moc3 that passes strict validation and reads back', () => {
    const moc = files['test.moc3']!;
    const check = validateMoc(moc, { level: 'strict' });
    expect(check.diagnostics).toEqual([]);
    expect(check.valid).toBe(true);
    const { data, version } = readMoc(moc);
    expect(version).toBe(SYNTHETIC_MOC_VERSION);
    expect(data.artMeshes.ids).toEqual([...SYNTHETIC_MESH_IDS]);
    expect(data.canvas.width).toBe(512);
  });

  it('has a motion that parses', () => {
    const motion = parseMotion(files['wave.motion3.json']!);
    expect(motion.curves.length).toBeGreaterThan(0);
    expect(motion.duration).toBeCloseTo(0.5);
  });

  it('loads in a headless runtime with its parameters', async () => {
    const rt = await load(files, 'test.model3.json');
    rt.update(1 / 60);
    for (const p of SYNTHETIC_PARAMETERS) {
      const info = rt.parameters.find((q) => q.id === p.id);
      expect(info, p.id).toBeDefined();
      expect(info).toMatchObject({ min: p.min, max: p.max, default: p.default });
    }
    expect(rt.parameters.find((q) => q.id === 'ParamMouthOpenY')?.name).toBe('Mouth Open Y');
    expect(rt.instance.drawableVertices).toHaveLength(2);
  });

  it('opens the mouth with ParamMouthOpenY and moves the body with ParamAngleX', async () => {
    const rt = await load(files, 'test.model3.json');
    // Keep automatic effects (blink, breath, idle) from changing anything.
    for (const e of ['eyeBlink', 'breath', 'idle', 'lipSync'] as const) rt.setEffect(e, false);

    rt.setParameter('ParamMouthOpenY', 0);
    rt.update(1 / 60);
    const closed = Array.from(rt.instance.drawableVertices[MOUTH]!);
    const bodyCenter = Array.from(rt.instance.drawableVertices[BODY]!);

    rt.setParameter('ParamMouthOpenY', 1);
    rt.update(1 / 60);
    const open = Array.from(rt.instance.drawableVertices[MOUTH]!);
    expect(open).not.toEqual(closed);
    const height = (v: number[]) => Math.max(v[1]!, v[5]!) - Math.min(v[1]!, v[5]!);
    expect(height(open)).toBeGreaterThan(height(closed) * 4);

    rt.setParameter('ParamAngleX', 30);
    rt.update(1 / 60);
    const bodyRight = Array.from(rt.instance.drawableVertices[BODY]!);
    expect(bodyRight[0]!).toBeGreaterThan(bodyCenter[0]! + 0.05);
  });

  it('plays the Wave motion and the Blush expression', async () => {
    const rt = await load(files, 'test.model3.json');
    rt.update(1 / 60);
    await expect(rt.startMotion('Wave', 0)).resolves.toMatchObject({ motion: 'wave.motion3.json' });
    await rt.setExpression('Blush');
    for (let i = 0; i < 15; i++) rt.update(1 / 60);
    expect(Math.abs(rt.getParameter('ParamAngleZ'))).toBeGreaterThan(1);
    for (let i = 0; i < 30; i++) rt.update(1 / 60);
    expect(rt.getParameter('ParamCustom')).toBeCloseTo(1);
  });

  it('has a physics file written with writePhysics, which Mochi2D loads and runs', async () => {
    const phys = syntheticModelFiles({ withPhysics: true });
    const text = new TextDecoder().decode(phys['test.physics3.json']!);
    // writePhysics is the inverse of parsePhysics: the text reads back as the data.
    const data = parsePhysics(text);
    expect(writePhysics(data)).toBe(text);
    expect(data.settings.map((x) => x.id)).toEqual(['PhysicsSetting1', 'PhysicsSetting2']);
    const rt = await load(phys, 'test.model3.json');
    for (const e of ['eyeBlink', 'breath', 'idle', 'lipSync'] as const) rt.setEffect(e, false);
    // Named from the file's dictionary; a setting without a name is named by its ID.
    expect(rt.physicsSettings.map((x) => [x.id, x.name])).toEqual([
      ['PhysicsSetting1', 'Hair'],
      ['PhysicsSetting2', 'PhysicsSetting2'],
    ]);
    // Hair overwrites ParamAngleX from ParamCustom; the other setting writes at half weight.
    expect([...rt.physicsInputs.keys()]).toEqual(['ParamAngleX']);
    expect(rt.physicsInputs.get('ParamAngleX')!.map((i) => i.id)).toEqual(['ParamCustom']);
    // Moving the input swings the output.
    for (let i = 0; i < 10; i++) rt.update(1 / 60);
    const rest = rt.getParameter('ParamAngleX');
    rt.setParameter('ParamCustom', 1);
    let swing = 0;
    for (let i = 0; i < 30; i++) {
      rt.setParameter('ParamCustom', 1);
      rt.update(1 / 60);
      swing = Math.max(swing, Math.abs(rt.getParameter('ParamAngleX') - rest));
    }
    expect(swing).toBeGreaterThan(1);
  });

  it('has a motion-sync file written with writeMotionSync, which Mochi2D reads as written', async () => {
    const ms = syntheticModelFiles({ withMotionSync: true });
    const text = new TextDecoder().decode(ms['test.motionsync3.json']!);
    const file = parseMotionSync(text);
    expect(file.warnings).toEqual([]);
    expect(writeMotionSync(file)).toBe(text);
    const [setting] = file.settings;
    expect(setting).toMatchObject({ id: 'MotionSync1', name: 'Mouth basic', usable: true });
    expect(setting!.elements.every((e) => e.known)).toBe(true);
    expect(setting!.shapes[MOTION_SYNC_ELEMENTS.indexOf('O')]).toEqual([0.7, -1]);
    const rt = await load(ms, 'test.model3.json');
    expect(rt.settings.motionSync).toBe('test.motionsync3.json');
  });

  it('builds an item model with item settings', async () => {
    const hat = syntheticModelFiles({ name: 'hat', color: [40, 80, 200], withItemExtras: true });
    expect(Object.keys(hat).sort()).toEqual(
      ['hat.model3.json', 'hat.moc3', 'hat.vtube.json', 'texture_00.png'].sort(),
    );
    expect(validateMoc(hat['hat.moc3']!, { level: 'strict' }).valid).toBe(true);
    const vtube = JSON.parse(new TextDecoder().decode(hat['hat.vtube.json']!));
    expect(vtube.ItemSettings.Multiplier_HeadAngleX).toBe(1);

    const rt = await load(hat, 'hat.model3.json');
    rt.update(1 / 60);
    expect(rt.parameters.map((p) => p.id)).toContain('ParamAngleX');
    expect(rt.instance.drawableVertices).toHaveLength(2);
  });
});
