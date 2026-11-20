import { describe, expect, it } from 'vitest';
import { MemoryFileSet, openModel } from '../../src/core/modelFiles';
import { buildHeavyMoc, heavyModelFiles } from '../support/heavyModel';

describe('the stream-sized synthetic model', () => {
  it('is a valid moc of DeepSeek-chan’s size', () => {
    expect(buildHeavyMoc().length).toBeGreaterThan(1_000_000);
  });

  it('opens with every file present, 509 parameters and 23 expressions', async () => {
    const files = heavyModelFiles({ textureSize: 64 });
    const m = await openModel(
      new MemoryFileSet(
        'heavy',
        Object.entries(files).map(([p, b]) => [`heavy/${p}`, b]),
      ),
    );
    expect(m.missing).toEqual([]);
    expect(m.manifest.expressions.length).toBe(23);
    expect(m.manifest.textures.length).toBe(5);
  });
});
