import { describe, expect, it } from 'vitest';
import { syntheticHand } from '../../test/support/hands';
import {
  GestureWatcher,
  gestureMatches,
  handGestures,
  parseGestureTrigger,
  parseSensitivity,
  recognize,
  thresholds,
  type GestureTrigger,
} from './gestures';
import { readHand, type Finger } from './hands';

const hand = (
  fingers: Partial<Record<Finger, number>>,
  roll = 0,
  side: 'left' | 'right' = 'right',
  touch = false,
) => readHand(syntheticHand({ side, fingers, roll, touch }))!;
const curled = { Index: 0, Middle: 0, Ring: 0, Pinky: 0 };

describe('hand gestures', () => {
  it('recognizes the five gestures from the fingers', () => {
    expect(recognize(hand({}))).toBe('open');
    expect(recognize(hand({ ...curled, Thumb: 0.2 }))).toBe('fist');
    expect(recognize(hand({ ...curled, Index: 1, Thumb: 0.2 }))).toBe('point');
    expect(recognize(hand({ ...curled, Index: 1, Middle: 1 }))).toBe('peace');
    expect(recognize(hand({ ...curled, Thumb: 1 }))).toBe('thumbsUp');
    // Turned upside down, the thumb points down: no thumbs up.
    expect(recognize(hand({ ...curled, Thumb: 1 }, 180))).toBeUndefined();
    // Half-bent fingers match nothing.
    expect(recognize(hand({ Index: 0.5, Middle: 0.5, Ring: 0.5, Pinky: 0.5 }))).toBeUndefined();
    // Any size or turn in the picture (but the thumb's way up).
    expect(recognize(hand({ ...curled, Index: 1 }, 60, 'left'))).toBe('point');
  });

  it('recognizes a pinch and an OK sign from the touching tips', () => {
    // The tips together, the index half bent: the other fingers straight make an OK sign.
    expect(hand({ Index: 0.6 }, 0, 'right', true).tipGap).toBeLessThan(0.2);
    expect(recognize(hand({ Index: 0.6 }, 0, 'right', true))).toBe('ok');
    expect(recognize(hand({ Index: 0.6, Middle: 0, Ring: 0, Pinky: 0 }, 0, 'right', true))).toBe(
      'pinch',
    );
    expect(recognize(hand({ Index: 0.6, Middle: 0.5 }, 30, 'left', true))).toBe('pinch');
    // A fist's thumb may lie on the curled index: still a fist.
    expect(recognize(hand({ ...curled, Thumb: 0.2 }, 0, 'right', true))).toBe('fist');
    // Apart, nothing of the kind.
    expect(hand({ Index: 0.6 }).tipGap).toBeGreaterThan(0.5);
    expect(recognize(hand({ Index: 0.6, Middle: 0, Ring: 0, Pinky: 0 }))).toBeUndefined();
  });

  it('follows each gesture’s sensitivity', () => {
    const loose = hand({ Thumb: 0.6, Index: 0.6, Middle: 0.6, Ring: 0.6, Pinky: 0.6 });
    expect(recognize(loose)).toBeUndefined();
    expect(recognize(loose, { open: 100 })).toBe('open');
    // Another gesture's sensitivity changes nothing for this one.
    expect(recognize(loose, { fist: 100 })).toBeUndefined();
    const stiff = hand({ Thumb: 0.7, Index: 0.7, Middle: 0.7, Ring: 0.7, Pinky: 0.7 });
    expect(recognize(stiff)).toBe('open');
    expect(recognize(stiff, { open: 0 })).toBeUndefined();
    // A thumb about 57° from straight up (the synthetic thumb leans 31°, turned 26° more):
    // only a sensitive thumbs up takes it.
    const tilted = hand({ ...curled, Thumb: 1 }, 26);
    expect(tilted.thumbUp).toBeGreaterThan(Math.cos((65 * Math.PI) / 180));
    expect(tilted.thumbUp).toBeLessThan(Math.cos((50 * Math.PI) / 180));
    expect(recognize(tilted)).toBeUndefined();
    expect(recognize(tilted, { thumbsUp: 100 })).toBe('thumbsUp');
    // Palms three position units apart are together only when sensitive.
    const l = readHand(syntheticHand({ side: 'left', at: [0.575, 0.6] }))!;
    const r = readHand(syntheticHand({ side: 'right', at: [0.425, 0.6] }))!;
    expect(handGestures({ left: l, right: r }).together).toBe(false);
    expect(handGestures({ left: l, right: r }, { together: 100 }).together).toBe(true);
    expect(thresholds()).toMatchObject({ straight: 0.65, curled: 0.4, touch: 0.25 });
    expect(thresholds(100).straight).toBeCloseTo(0.55);
    expect(parseSensitivity({ pinch: 140, open: -3, ok: 'x', wave: 10 })).toEqual({
      pinch: 100,
      open: 0,
    });
  });

  it('finds the hands together', () => {
    const l = readHand(syntheticHand({ side: 'left', at: [0.55, 0.6] }))!;
    const r = readHand(syntheticHand({ side: 'right', at: [0.47, 0.6] }))!;
    expect(handGestures({ left: l, right: r })).toEqual({
      left: 'open',
      right: 'open',
      together: true,
    });
    const far = readHand(syntheticHand({ side: 'right', at: [0.1, 0.6] }))!;
    expect(handGestures({ left: l, right: far }).together).toBe(false);
    expect(handGestures({ left: l }).together).toBe(false);
  });

  it('matches triggers: one hand, both with AND or OR, mirrored, and the pose', () => {
    const t = (o: Partial<GestureTrigger>): GestureTrigger => ({
      combine: 'and',
      mirrored: false,
      hold: 0,
      ...o,
    });
    const g = { left: 'fist' as const, right: 'peace' as const, together: false };
    expect(gestureMatches(t({ left: 'fist' }), g)).toBe(true);
    expect(gestureMatches(t({ right: 'fist' }), g)).toBe(false);
    expect(gestureMatches(t({ right: 'fist', mirrored: true }), g)).toBe(true);
    expect(gestureMatches(t({ left: 'fist', right: 'open' }), g)).toBe(false);
    expect(gestureMatches(t({ left: 'fist', right: 'open', combine: 'or' }), g)).toBe(true);
    expect(gestureMatches(t({ left: 'peace', right: 'fist' }), g)).toBe(false);
    expect(gestureMatches(t({ left: 'peace', right: 'fist', mirrored: true }), g)).toBe(true);
    expect(gestureMatches(t({ pose: 'together' }), g)).toBe(false);
    expect(gestureMatches(t({ pose: 'together' }), { ...g, together: true })).toBe(true);
    expect(gestureMatches(t({}), g)).toBe(false);
  });

  it('fires a hotkey after the hold time, once, and releases it when the gesture ends', () => {
    const w = new GestureWatcher();
    const hk = [
      {
        id: 'h',
        gesture: { left: 'fist' as const, combine: 'and' as const, mirrored: false, hold: 0.5 },
      },
    ];
    const fist = { left: 'fist' as const, together: false };
    const none = { together: false };
    expect(w.step(hk, fist, 0)).toEqual({ fire: [], release: [] });
    expect(w.step(hk, fist, 499)).toEqual({ fire: [], release: [] });
    expect(w.step(hk, fist, 500)).toEqual({ fire: ['h'], release: [] });
    expect(w.step(hk, fist, 900)).toEqual({ fire: [], release: [] });
    expect(w.step(hk, none, 950)).toEqual({ fire: [], release: ['h'] });
    // A short gesture fires nothing, and its end releases nothing.
    w.step(hk, fist, 1000);
    expect(w.step(hk, none, 1200)).toEqual({ fire: [], release: [] });
    // Without hands (tracking off), nothing matches.
    w.step(hk, fist, 2000);
    expect(w.step(hk, fist, 2600).fire).toEqual(['h']);
    expect(w.step(hk, undefined, 2700).release).toEqual(['h']);
  });

  it('reads stored triggers safely', () => {
    expect(parseGestureTrigger({ left: 'fist', right: 'nope', combine: 'or', hold: 99 })).toEqual({
      left: 'fist',
      combine: 'or',
      mirrored: false,
      hold: 10,
    });
    expect(parseGestureTrigger({ pose: 'together', left: 'fist', mirrored: true })).toEqual({
      pose: 'together',
      combine: 'and',
      mirrored: true,
      hold: 0.5,
    });
    expect(parseGestureTrigger({ combine: 'and' })).toBeUndefined();
    expect(parseGestureTrigger('fist')).toBeUndefined();
  });
});
