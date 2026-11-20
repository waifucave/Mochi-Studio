import { describe, expect, it } from 'vitest';
import { loadMoc, validateMoc } from 'mochi2d/headless';
import { imageItemFiles, imageMocData } from './imageItem';

describe('image items', () => {
  it('make a valid one-quad model as large as the image', () => {
    const data = imageMocData(300, 150);
    const check = validateMoc(data, { version: 3, level: 'strict' });
    expect(check.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const files = Object.fromEntries(
      imageItemFiles(new Uint8Array([1]), 300, 150, { name: 'Star', flipped: false }),
    );
    expect(Object.keys(files).sort()).toEqual([
      'image.moc3',
      'image.model3.json',
      'mochi-image-item.json',
      'texture_00.png',
    ]);
    const moc = loadMoc(files['image.moc3']!);
    expect(moc.meshes.ids).toEqual(['ArtMeshImage']);
    expect(moc.canvas.width).toBe(300);
    expect(moc.canvas.height).toBe(150);
  });
});
