import { describe, expect, it } from 'vitest';
import { ItemAnimator } from './itemAnimation';

describe('animated item playback', () => {
  it('steps frames at the item’s rate, looping', () => {
    const a = new ItemAnimator();
    a.add('gif', 4, 10);
    expect(a.tick(50)).toEqual([]);
    expect(a.tick(50)).toEqual([['gif', 1]]);
    expect(a.tick(200)).toEqual([['gif', 3]]);
    expect(a.tick(100)).toEqual([['gif', 0]]);
    expect(a.get('gif')).toMatchObject({ frames: 4, fps: 10, playing: true, frame: 0 });
  });

  it('holds the frame at 0 fps or when paused, and limits the rate to 60', () => {
    const a = new ItemAnimator();
    a.add('x', 5, 0);
    expect(a.tick(1000)).toEqual([]);
    a.control('x', { fps: 120 });
    expect(a.get('x')!.fps).toBe(60);
    a.control('x', { playing: false });
    expect(a.tick(1000)).toEqual([]);
    expect(a.control('x', { frame: 9 })).toBe(4);
    expect(a.control('nope', { frame: 1 })).toBeUndefined();
  });

  it('stops by itself at an auto-stop frame, until started again', () => {
    const a = new ItemAnimator();
    a.add('x', 6, 10);
    a.control('x', { autoStop: [2, 9] });
    expect(a.get('x')!.autoStop).toEqual([2]);
    expect(a.tick(1000)).toEqual([['x', 2]]);
    expect(a.get('x')!.playing).toBe(false);
    expect(a.tick(1000)).toEqual([]);
    a.control('x', { playing: true });
    expect(a.tick(100)).toEqual([['x', 3]]);
  });

  it('reports every frame for late joiners, and forgets removed items', () => {
    const a = new ItemAnimator();
    a.add('a', 3, 10);
    a.add('b', 3, 10);
    a.control('b', { frame: 2 });
    expect(a.frames()).toEqual([
      ['a', 0],
      ['b', 2],
    ]);
    a.remove('a');
    expect(a.has('a')).toBe(false);
    expect(a.frames()).toEqual([['b', 2]]);
  });
});

describe('a GIF’s own frame delays', () => {
  it('lasts each frame its own delay, and treats the rate as a speed factor', () => {
    const a = new ItemAnimator();
    // 100, 300 and 200 ms: an average of 5 fps.
    a.add('gif', 3, 5, true, { delays: [100, 300, 200], baseFps: 5 });
    expect(a.get('gif')).toMatchObject({ ownTiming: true, baseFps: 5, fps: 5 });
    expect(a.tick(99)).toEqual([]);
    expect(a.tick(1)).toEqual([['gif', 1]]);
    expect(a.tick(299)).toEqual([]);
    expect(a.tick(1)).toEqual([['gif', 2]]);
    expect(a.tick(200)).toEqual([['gif', 0]]);
    // Twice the rate: every delay halves.
    a.control('gif', { fps: 10 });
    expect(a.tick(50)).toEqual([['gif', 1]]);
    expect(a.tick(149)).toEqual([]);
    expect(a.tick(1)).toEqual([['gif', 2]]);
    // A long pause moves on at most one loop.
    expect(a.tick(60_000)).toEqual([]);
    expect(a.get('gif')!.frame).toBe(2);
  });

  it('ignores timing that does not fit the frames, and plays evenly then', () => {
    const a = new ItemAnimator();
    a.add('x', 3, 10, true, { delays: [100, 0, 100], baseFps: 10 });
    a.add('y', 3, 10, true, { delays: [100, 100], baseFps: 10 });
    expect(a.get('x')).toMatchObject({ ownTiming: false, baseFps: 10 });
    expect(a.get('y')!.ownTiming).toBe(false);
    expect(a.tick(100)).toEqual([
      ['x', 1],
      ['y', 1],
    ]);
  });
});
