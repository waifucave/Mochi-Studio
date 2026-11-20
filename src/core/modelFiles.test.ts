import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  MemoryFileSet,
  ModelLoadError,
  fileSetFromUrl,
  fileSetFromZip,
  normalizePath,
  openModel,
  parseManifest,
  readDisplayParameters,
  readMotionMeta,
} from './modelFiles';

// A made-up minimal model for tests (not a real model's data).
const manifest = JSON.stringify({
  Version: 3,
  FileReferences: {
    Moc: 'a.moc3',
    Textures: ['tex/t0.png'],
    DisplayInfo: 'a.cdi3.json',
    Expressions: [{ Name: 'Smile', File: 'exp/smile.exp3.json' }],
    Motions: { Idle: [{ File: 'mot/idle.motion3.json' }], Tap: [{ File: 'mot/tap.motion3.json' }] },
  },
  Groups: [{ Target: 'Parameter', Name: 'EyeBlink', Ids: ['ParamEyeLOpen'] }],
});
const files: Record<string, Uint8Array> = {
  'Model/a.model3.json': strToU8(manifest),
  'Model/a.moc3': new Uint8Array([1, 2, 3]),
  'Model/tex/t0.png': new Uint8Array([4]),
  'Model/a.cdi3.json': strToU8(
    JSON.stringify({ Parameters: [{ Id: 'ParamAngleX', Name: 'Angle X' }, { Id: 'P2' }] }),
  ),
  'Model/exp/smile.exp3.json': strToU8('{}'),
  'Model/mot/idle.motion3.json': strToU8(JSON.stringify({ Meta: { Duration: 2.5, Loop: true } })),
};

describe('paths', () => {
  it('normalises', () => {
    expect(normalizePath('a\\b/./c/../d')).toBe('a/b/d');
    expect(normalizePath('/x//y/')).toBe('x/y');
  });
});

describe('MemoryFileSet', () => {
  it('re-roots at the manifest folder and resolves case-insensitively', async () => {
    const set = new MemoryFileSet('t', Object.entries(files));
    expect(set.paths()).toContain('a.model3.json');
    expect(set.has('TEX/T0.PNG')).toBe(true);
    expect(await set.read('a.moc3')).toEqual(new Uint8Array([1, 2, 3]));
    await expect(set.read('nope')).rejects.toThrow(ModelLoadError);
  });
  it('requires a manifest', () => {
    expect(() => new MemoryFileSet('t', [['x.png', new Uint8Array()]])).toThrow(/model3/);
  });
});

describe('openModel', () => {
  it('reads the manifest, reports missing files and builds a stable key', async () => {
    const m = await openModel(fileSetFromZip('z', zipSync(files)));
    expect(m.manifest.expressions).toEqual([{ name: 'Smile', file: 'exp/smile.exp3.json' }]);
    expect(m.manifest.motions.map((x) => [x.group, x.index, x.name])).toEqual([
      ['Idle', 0, 'idle'],
      ['Tap', 0, 'tap'],
    ]);
    expect(m.missing).toEqual(['mot/tap.motion3.json']);
    expect(m.key).toMatch(/^a\.model3\.json#[0-9a-f]{8}$/);
    const again = await openModel(new MemoryFileSet('f', Object.entries(files)));
    expect(again.key).toBe(m.key);
    expect(await readDisplayParameters(m.files, m.manifest)).toEqual([
      { id: 'ParamAngleX', name: 'Angle X' },
      { id: 'P2', name: 'P2' },
    ]);
    expect(await readMotionMeta(m.files, 'mot/idle.motion3.json')).toEqual({
      duration: 2.5,
      loop: true,
    });
  });

  it('discovers unlisted expressions and motions', async () => {
    const bare = JSON.stringify({ Version: 3, FileReferences: { Moc: 'a.moc3', Textures: [] } });
    const m = await openModel(
      new MemoryFileSet('f', Object.entries({ ...files, 'Model/a.model3.json': strToU8(bare) })),
    );
    expect(m.manifest.discovered).toEqual({ expressions: true, motions: true });
    expect(m.manifest.expressions.map((e) => e.name)).toEqual(['smile']);
    expect(m.manifest.motions).toEqual([
      { group: '', index: 0, file: 'mot/idle.motion3.json', name: 'idle' },
    ]);
  });

  it('rejects broken manifests', () => {
    expect(() => parseManifest('{', 'x')).toThrow(/valid JSON/);
    expect(() => parseManifest('{"FileReferences":{}}', 'x')).toThrow(/moc3/);
  });
});

describe('fileSetFromUrl', () => {
  const serve = (base: string) => async (url: string) => {
    const path = decodeURIComponent(new URL(url).pathname).replace(base, 'Model/');
    const d = files[path];
    return {
      ok: !!d,
      status: d ? 200 : 404,
      arrayBuffer: async () => (d ?? new Uint8Array()).slice().buffer,
    };
  };
  it('loads referenced files relative to the manifest URL', async () => {
    const set = await fileSetFromUrl('https://example.test/m/a.model3.json', serve('/m/'));
    const m = await openModel(set);
    expect(await set.read(m.manifest.moc)).toEqual(new Uint8Array([1, 2, 3]));
    await expect(set.read('mot/tap.motion3.json')).rejects.toThrow(/404/);
  });
  it('loads a zip URL', async () => {
    const zip = zipSync(files);
    const set = await fileSetFromUrl('https://example.test/model.zip', async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => zip.slice().buffer,
    }));
    expect(set.has('a.moc3')).toBe(true);
  });
});
