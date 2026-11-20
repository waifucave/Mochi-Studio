import { describe, expect, it } from 'vitest';
import { loadMoc, MemoryFileSource, ModelRuntime, validateMoc } from 'mochi2d/headless';
import {
  animatedItemFiles,
  animatedMarkerOf,
  animatedMocData,
  ATLAS_SIDE,
  framePartId,
  fpsFromDelays,
  MAX_ATLASES,
  naturalCompare,
  planAtlas,
  varyingDelays,
} from './animatedItem';

const marker = {
  name: 'spin',
  flipped: false as const,
  source: 'gif' as const,
  frames: 3,
  fps: 10,
};

describe('animated items', () => {
  it('packs frames into atlases, scaling down only when they do not fit', () => {
    const small = planAtlas(100, 50, 12);
    expect(small).toMatchObject({ scale: 1, cellWidth: 100, cellHeight: 50, atlases: [{}] });
    expect(small.frames[1]).toEqual({ texture: 0, x: 104, y: 0 });
    // 64 frames of 2048 × 2048 cannot keep their size in 4 atlases.
    const big = planAtlas(2048, 2048, 64);
    expect(big.atlases.length).toBeLessThanOrEqual(MAX_ATLASES);
    expect(big.scale).toBeLessThan(0.3);
    for (const a of big.atlases) {
      expect(a.width).toBeLessThanOrEqual(ATLAS_SIDE);
      expect(a.height).toBeLessThanOrEqual(ATLAS_SIDE);
    }
    const many = planAtlas(500, 500, 1024);
    expect(many.frames).toHaveLength(1024);
    expect(many.atlases.length).toBeLessThanOrEqual(MAX_ATLASES);
    // Cells never overlap within an atlas.
    const seen = new Set(many.frames.map((f) => `${f.texture}:${f.x}:${f.y}`));
    expect(seen.size).toBe(1024);
  });

  it('writes a model Mochi2D accepts, one part and quad per frame', () => {
    const layout = planAtlas(64, 64, 3);
    const data = animatedMocData(64, 64, layout);
    const files = animatedItemFiles([new Uint8Array(1)], 64, 64, layout, marker);
    const moc = files.find(([p]) => p === 'image.moc3')![1];
    const check = validateMoc(data, { version: 3, level: 'strict' });
    expect(check.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    // Warnings too: the format is written as genuine files are.
    expect(check.diagnostics.map((d) => d.code)).toEqual([]);
    const m = loadMoc(moc);
    expect([...m.meshes.ids]).toEqual(['ArtMeshFrame0', 'ArtMeshFrame1', 'ArtMeshFrame2']);
    expect(data.parts.ids).toEqual(['PartFrame0', 'PartFrame1', 'PartFrame2']);
    expect(animatedMarkerOf(files)).toEqual(marker);
    expect(
      animatedMarkerOf([
        ['mochi-image-item.json', new TextEncoder().encode('{"name":"x","flipped":false}')],
      ]),
    ).toBeUndefined();
  });

  it('shows one frame at a time through part opacities', async () => {
    const layout = planAtlas(64, 64, 3);
    const files = animatedItemFiles([new Uint8Array(0)], 64, 64, layout, marker);
    const rt = await ModelRuntime.load(MemoryFileSource.fromFiles(Object.fromEntries(files)));
    rt.update(0);
    const shown = (): number[] =>
      [...rt.instance.drawableVisible].map((v, i) =>
        v && rt.instance.drawableOpacity[i]! > 0 ? 1 : 0,
      );
    // Loaded: frame 0 only.
    expect(shown()).toEqual([1, 0, 0]);
    rt.setPartOpacity(framePartId(0), 0);
    rt.setPartOpacity(framePartId(2), 1);
    rt.update(0);
    expect(shown()).toEqual([0, 0, 1]);
  });

  it('takes a GIF’s frame rate from its delays, and sorts frame names naturally', () => {
    expect(fpsFromDelays([100, 100, 100])).toBe(10);
    expect(fpsFromDelays([20, 20])).toBe(50);
    expect(fpsFromDelays([5, 5])).toBe(60);
    expect(fpsFromDelays([])).toBe(10);
    // Delays are kept only when they vary.
    expect(varyingDelays([100, 100, 100])).toBeUndefined();
    expect(varyingDelays([100, 300, 200])).toEqual([100, 300, 200]);
    expect(fpsFromDelays([100, 300, 200])).toBe(5);
    expect(['f10.png', 'f2.png', 'f1.png'].sort(naturalCompare)).toEqual([
      'f1.png',
      'f2.png',
      'f10.png',
    ]);
  });
});
