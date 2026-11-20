import { describe, expect, it } from 'vitest';
import { mouseInputs, parseMouseRange } from './mouseInput';
import { MOUSE_INPUTS } from './knownInputs';

const screen = { x: 0, y: 0, width: 1920, height: 1080 };

describe('the mouse inputs', () => {
  it('maps the pointer to −1…1 around the middle, Y up, within the range', () => {
    expect(MOUSE_INPUTS.map((i) => [i.id, i.min, i.max])).toEqual([
      ['MousePositionX', -1, 1],
      ['MousePositionY', -1, 1],
    ]);
    expect(mouseInputs({ x: 960, y: 540, area: screen })).toEqual({
      MousePositionX: 0,
      MousePositionY: 0,
    });
    // The whole screen by default: its edges are ±1; up is positive.
    expect(mouseInputs({ x: 1920, y: 0, area: screen })).toEqual({
      MousePositionX: 1,
      MousePositionY: 1,
    });
    expect(mouseInputs({ x: 480, y: 810, area: screen })).toEqual({
      MousePositionX: -0.5,
      MousePositionY: -0.5,
    });
    // Ranges the person sets, in pixels: beyond them the values stay at ±1.
    const r = { width: 400, height: 200 };
    expect(mouseInputs({ x: 1060, y: 590, area: screen }, r)).toEqual({
      MousePositionX: 0.5,
      MousePositionY: -0.5,
    });
    expect(mouseInputs({ x: 0, y: 1080, area: screen }, r)).toEqual({
      MousePositionX: -1,
      MousePositionY: -1,
    });
    // A screen that does not start at 0 (a desktop with several screens).
    expect(
      mouseInputs({ x: 2880, y: 540, area: { x: 1920, y: 0, width: 1920, height: 1080 } }),
    ).toEqual({ MousePositionX: 0, MousePositionY: 0 });
  });

  it('keeps the ranges in the settings', () => {
    expect(parseMouseRange(undefined)).toEqual({ width: 0, height: 0 });
    expect(parseMouseRange({ width: 800.4, height: -5 })).toEqual({ width: 800, height: 0 });
    expect(parseMouseRange({ width: 1e9, height: 'x' })).toEqual({ width: 20000, height: 0 });
  });
});
