import { describe, expect, it } from 'vitest';
import { newSceneId, parseItemScenes, toggleScene, type ItemScene } from './itemScenes';

const at = (x: number) => ({ x, y: 0, scale: 1, rotation: 0, front: true });
const scenes: ItemScene[] = [
  {
    id: 'a',
    name: 'Desk',
    group: 'room',
    items: [{ id: 'lamp', placement: at(1) }, { id: 'mug' }],
  },
  { id: 'b', name: 'Bed', group: 'room', items: [{ id: 'pillow' }, { id: 'lamp' }] },
  { id: 'c', name: 'Hat', items: [{ id: 'hat' }] },
];

describe('item scenes', () => {
  it('shows a scene’s items, and hides them again unless another scene holds them', () => {
    const on = toggleScene(scenes, new Set(), 'a', true);
    expect([...on.active]).toEqual(['a']);
    expect(on.show).toEqual(scenes[0]!.items);
    expect(on.hide).toEqual([]);
    const both = toggleScene(scenes, on.active, 'c', true);
    expect([...both.active].sort()).toEqual(['a', 'c']);
    const off = toggleScene(scenes, both.active, 'c', false);
    expect(off).toEqual({ active: new Set(['a']), show: [], hide: ['hat'] });
  });

  it('turns the group’s other scenes off, keeping items the new one holds', () => {
    const r = toggleScene(scenes, new Set(['a', 'c']), 'b', true);
    expect([...r.active].sort()).toEqual(['b', 'c']);
    expect(r.show.map((i) => i.id)).toEqual(['pillow', 'lamp']);
    expect(r.hide).toEqual(['mug']);
  });

  it('ignores unknown and stale scenes', () => {
    expect(toggleScene(scenes, new Set(['gone']), 'nope', true)).toEqual({
      active: new Set(),
      show: [],
      hide: [],
    });
    expect(toggleScene(scenes, new Set(), 'a', false).hide).toEqual([]);
  });

  it('reads stored scenes safely, and makes new IDs', () => {
    expect(
      parseItemScenes([
        {
          id: 'a',
          name: ' Desk ',
          group: ' room ',
          items: [{ id: 'lamp', placement: at(2) }, { id: 'x', placement: { x: 'no' } }, 5],
        },
        { id: 'a', name: 'dup', items: [] },
        { id: 'b', items: 'no' },
        'junk',
      ]),
    ).toEqual([
      {
        id: 'a',
        name: 'Desk',
        group: 'room',
        items: [{ id: 'lamp', placement: at(2) }, { id: 'x' }],
      },
    ]);
    expect(newSceneId(['scene1', 'scene3'])).toBe('scene2');
  });
});
