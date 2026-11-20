import { describe, expect, it } from 'vitest';
import { syntheticHand } from '../../test/support/hands';
import { HAND_INPUTS, handInputs, readHand } from './hands';

describe('hand tracking', () => {
  it('lists the 26 documented hand inputs, with their ranges', () => {
    expect(HAND_INPUTS).toHaveLength(26);
    const by = (id: string) => HAND_INPUTS.find((i) => i.id === id)!;
    expect(by('HandLeftFound')).toMatchObject({ min: 0, max: 1 });
    expect(by('HandRightPositionX')).toMatchObject({ min: -10, max: 10 });
    expect(by('HandLeftAngleZ')).toMatchObject({ min: -180, max: 180 });
    expect(by('HandRightFinger_5_Pinky')).toMatchObject({ min: 0, max: 1 });
  });

  it('reads how straight each finger is, the same for any size, place or turn', () => {
    const fingers = { Thumb: 0.2, Index: 1, Middle: 0.5, Ring: 0, Pinky: 0.75 };
    for (const o of [
      {},
      { size: 0.3, at: [0.2, 0.4] as [number, number] },
      { roll: 70 },
      { roll: -120 },
    ]) {
      const r = readHand(syntheticHand({ side: 'right', fingers, ...o }))!;
      for (const [f, v] of Object.entries(fingers))
        expect(r.fingers[f as keyof typeof fingers]).toBeCloseTo(v, 1);
      expect(r.open).toBeCloseTo(0.49, 1);
    }
  });

  it('gives the found flags, places, angles and fingers as inputs', () => {
    const left = syntheticHand({ side: 'left', at: [0.75, 0.5], roll: 20 });
    const right = syntheticHand({
      side: 'right',
      at: [0.25, 0.8],
      size: 0.3,
      fingers: { Index: 0 },
    });
    const i = handInputs([left, right], false);
    expect(i).toMatchObject({ HandLeftFound: 1, HandRightFound: 1, BothHandsFound: 1 });
    // X is mirror-symmetric: positive outwards for both hands. The subject's left
    // hand is on the picture's right, the right hand on its left: both are out to their sides.
    expect(i.HandLeftPositionX).toBeGreaterThan(3);
    expect(i.HandRightPositionX).toBeGreaterThan(3);
    expect(i.HandRightPositionY).toBeLessThan(i.HandLeftPositionY!);
    // Twice the usual size: nearer.
    expect(i.HandRightPositionZ).toBeGreaterThan(5);
    expect(Math.abs(i.HandLeftPositionZ!)).toBeLessThan(2);
    expect(i.HandLeftAngleZ).toBeCloseTo(20, 0);
    expect(i.HandRightFinger_2_Index).toBeCloseTo(0, 1);
    expect(i.HandLeftOpen).toBeCloseTo(1, 1);
    expect(i.HandDistance).toBeGreaterThan(5);
    // Mirrored, like the face: the names swap and the angles change sign; X stays, since
    // outwards is outwards in a mirror too.
    const m = handInputs([left], true);
    expect(m).toMatchObject({ HandRightFound: 1, HandLeftFound: 0, BothHandsFound: 0 });
    expect(m.HandRightPositionX).toBeCloseTo(i.HandLeftPositionX!, 6);
    expect(m.HandRightAngleZ).toBeCloseTo(-20, 0);
    expect(m.HandDistance).toBeUndefined();
    expect(m.HandLeftOpen).toBeUndefined();
    // No hands: only the flags.
    expect(handInputs([], false)).toEqual({
      HandLeftFound: 0,
      HandRightFound: 0,
      BothHandsFound: 0,
    });
  });

  it('turns the hand left and right (AngleX), and finds where the thumb points', () => {
    for (const side of ['left', 'right'] as const) {
      const facing = readHand(syntheticHand({ side }))!;
      expect(Math.abs(facing.angleX)).toBeLessThan(1);
      // Turned to face the picture's right: positive, for either hand.
      expect(readHand(syntheticHand({ side, turn: 40 }))!.angleX).toBeCloseTo(40, 0);
      expect(readHand(syntheticHand({ side, turn: -25 }))!.angleX).toBeCloseTo(-25, 0);
      // The fingers stay as they are.
      expect(readHand(syntheticHand({ side, turn: 40 }))!.open).toBeCloseTo(1, 1);
    }
    expect(
      handInputs([syntheticHand({ side: 'left', turn: 30 })], false).HandLeftAngleX,
    ).toBeCloseTo(30, 0);
    expect(
      handInputs([syntheticHand({ side: 'left', turn: 30 })], true).HandRightAngleX,
    ).toBeCloseTo(-30, 0);
    const flat = readHand(syntheticHand({ side: 'right' }))!;
    expect(flat.thumbUp).toBeGreaterThan(0.6);
    const down = readHand(syntheticHand({ side: 'right', roll: 180 }))!;
    expect(down.thumbUp).toBeLessThan(-0.6);
    expect(Math.abs(down.angleZ)).toBeCloseTo(180, 0);
  });
});
