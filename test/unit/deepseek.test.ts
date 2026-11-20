// Runs against the locally supplied DeepSeek-chan test model, if present in
// assets/models/DeepSeek/ (gitignored, never committed). Skipped otherwise,
// for example in CI.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultRules } from '../../src/core/mapping';
import {
  MemoryFileSet,
  openModel,
  readDisplayParameters,
  readMotionMeta,
} from '../../src/core/modelFiles';
import { MemoryFileSource, ModelRuntime } from 'mochi2d/headless';
import { physicsFacts, readPhysicsDrivers, trackingRedirects } from '../../src/core/physicsDrivers';

const DIR = new URL('../../assets/models/DeepSeek', import.meta.url).pathname;
const present = existsSync(DIR);

function walk(d: string): string[] {
  return readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

// The real model is large: reading it can take longer than the default 5 s in a full run.
describe.skipIf(!present)('DeepSeek-chan test model', { timeout: 60_000 }, () => {
  const load = async () => {
    const set = new MemoryFileSet(
      'DeepSeek',
      walk(DIR).map((p) => [`DeepSeek/${relative(DIR, p)}`, new Uint8Array(readFileSync(p))]),
    );
    return openModel(set);
  };

  it('opens, with every referenced file present', async () => {
    const m = await load();
    expect(m.missing).toEqual([]);
    expect(m.manifest.moc).toMatch(/\.moc3$/);
    expect(m.manifest.textures).toHaveLength(5);
  });

  it('discovers the expressions and motions its manifest does not list', async () => {
    const m = await load();
    expect(m.manifest.discovered).toEqual({ expressions: true, motions: true });
    expect(m.manifest.expressions.length).toBeGreaterThan(10);
    expect(m.manifest.motions.length).toBe(8);
    const idle = m.manifest.motions.find((x) => x.name === 'IDLE')!;
    expect((await readMotionMeta(m.files, idle.file))?.loop).toBe(true);
  });

  it('has the standard parameters, so the default mapping applies', async () => {
    const m = await load();
    const ids = (await readDisplayParameters(m.files, m.manifest)).map((p) => p.id);
    const outputs = defaultRules(ids).map((r) => r.output);
    for (const id of [
      'ParamAngleX',
      'ParamAngleY',
      'ParamAngleZ',
      'ParamEyeLOpen',
      'ParamEyeROpen',
      'ParamMouthOpenY',
      'ParamMouthForm',
      'ParamEyeBallX',
      'ParamBrowLY',
    ])
      expect(outputs).toContain(id);
    // Missing standard ids on this model (the mapping editor can target substitutes).
    expect(ids).not.toContain('ParamCheek');
    expect(m.manifest.groups.LipSync).toEqual([]);
  });

  it('has physics that overwrites the head angles, driven by its own parameters', async () => {
    const m = await load();
    // What Mochi2D reports for the running model: physics inputs, look-at's
    // routing (through physics on this model) and breath's parameters.
    const files = Object.fromEntries(
      walk(DIR).map((p) => [relative(DIR, p), new Uint8Array(readFileSync(p))]),
    );
    const rt = await ModelRuntime.load(MemoryFileSource.fromFiles(files, 'DeepSeek'));
    const facts = physicsFacts(rt);
    expect(facts.look.find((r) => r.target === 'ParamAngleX')?.writes).toBe('AngleX');
    const drivers = await readPhysicsDrivers(m.files, m.manifest, facts);
    // Physics writes ParamAngleX from AngleX.
    // The head angles follow AngleX/Y/Z (look-at's routing),
    // and the body PositionX/Y/Z. Body Y's LeanInput (68) is written by the
    // lean expression, so PositionY (30) wins. Body Z's PositionZ is reflected.
    expect(drivers.ParamAngleX).toEqual({ from: 'AngleX', reflect: false });
    expect(drivers.ParamAngleY?.from).toBe('AngleY');
    expect(drivers.ParamAngleZ?.from).toBe('AngleZ');
    expect(drivers.ParamBodyAngleX?.from).toBe('PositionX');
    expect(drivers.ParamBodyAngleY?.from).toBe('PositionY');
    expect(drivers.ParamBodyAngleZ).toEqual({ from: 'PositionZ', reflect: true });
    const ids = (await readDisplayParameters(m.files, m.manifest)).map((p) => p.id);
    const redirects = trackingRedirects(
      drivers,
      defaultRules(ids).map((r) => r.output),
    );
    // The default mapping's head rule goes to AngleX.
    expect(redirects.ParamAngleX?.from).toBe('AngleX');
    expect(ids).toContain('AngleX');
  });
});
