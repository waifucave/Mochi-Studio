import { describe, expect, it } from 'vitest';
import { CONTROLLER_INPUTS } from './knownInputs';
import {
  ALL_CONTROLLERS,
  ControllerReader,
  NO_CONTROLLER,
  PAD_TRIGGERS,
  deadZone,
  quatToEuler,
  type PadLike,
} from './controller';
import { comboLabel, normalizeCombo } from './hotkeys';
import { planGlobalHotkey } from './globalHotkeys';

/** A standard-layout controller: buttons by index (pressed when given), axes as given. */
function pad(
  o: {
    id?: string;
    index?: number;
    axes?: number[];
    pressed?: number[];
    values?: Record<number, number>;
    buttons?: number;
  } & Partial<Pick<PadLike, 'touches' | 'pose'>> = {},
): PadLike {
  const n = o.buttons ?? 17;
  return {
    id: o.id ?? 'Test pad (STANDARD GAMEPAD)',
    index: o.index ?? 0,
    connected: true,
    axes: o.axes ?? [0, 0, 0, 0],
    buttons: Array.from({ length: n }, (_, i) => {
      const value = o.values?.[i] ?? (o.pressed?.includes(i) ? 1 : 0);
      return { pressed: value >= 0.5, value };
    }),
    ...(o.touches !== undefined ? { touches: o.touches } : {}),
    ...(o.pose !== undefined ? { pose: o.pose } : {}),
  };
}

describe('the controller', () => {
  it('gives the 39 documented names, and only those', () => {
    expect(CONTROLLER_INPUTS).toHaveLength(39);
    const known = new Set(CONTROLLER_INPUTS.map((i) => i.id));
    const r = new ControllerReader();
    const full = r.read(
      [
        pad({
          buttons: 18,
          touches: [{ touchId: 1, position: [0, 0] }],
          pose: { hasOrientation: true, orientation: [0, 0, 0, 1] },
        }),
      ],
      ALL_CONTROLLERS,
    ).inputs;
    expect(Object.keys(full).sort()).toEqual([...known].sort());
  });

  it('reads sticks (Y up, with a dead zone), buttons, the D-pad and the triggers', () => {
    const r = new ControllerReader();
    const { inputs } = r.read(
      [
        pad({
          axes: [1, 0, 0, -1],
          pressed: [0, 4, 12, 15, 10],
          values: { 7: 0.4 },
        }),
      ],
      ALL_CONTROLLERS,
    );
    expect(inputs).toMatchObject({
      ControllerStickLeftX: 1,
      ControllerStickLeftY: 0,
      ControllerStickRightY: 1,
      ControllerCross: 1,
      ControllerCircle: 0,
      ControllerShoulderLeft: 1,
      ControllerStickPressLeft: 1,
      ControllerDPadX: 1,
      ControllerDPadY: 1,
      ControllerTriggerRight: 0.4,
      ControllerTriggerLeft: 0,
    });
    // The touchpad and orientation only where the browser gives them.
    expect('ControllerTouchPadTouchCount' in inputs).toBe(false);
    expect('ControllerTouchPadPress' in inputs).toBe(false);
    expect('ControllerOrientationX' in inputs).toBe(false);
    expect(deadZone(0.05, 0.05)).toEqual([0, 0]);
    const [x, y] = deadZone(0.55, 0);
    expect(x).toBeCloseTo(0.5);
    expect(y).toBe(0);
  });

  it('chooses none, all (combined) or one controller', () => {
    const a = pad({ id: 'A', axes: [0.3, 0, 0, 0], pressed: [3] });
    const b = pad({ id: 'B', index: 1, axes: [-0.9, 0, 0, 0], pressed: [1] });
    const r = new ControllerReader();
    expect(r.read([a, b], NO_CONTROLLER)).toMatchObject({ inputs: {}, used: [] });
    const all = r.read([a, null, b], ALL_CONTROLLERS);
    expect(all.used).toEqual(['A', 'B']);
    expect(all.inputs.ControllerTriangle).toBe(1);
    expect(all.inputs.ControllerCircle).toBe(1);
    expect(all.inputs.ControllerStickLeftX).toBeCloseTo(-0.889, 2);
    const one = r.read([a, b], 'A');
    expect(one.used).toEqual(['A']);
    expect(one.inputs.ControllerCircle).toBe(0);
    // One that is not connected: no inputs.
    expect(r.read([a], 'C').inputs).toEqual({});
  });

  it('counts each side’s buttons and leans towards the side held (Mochi Studio’s definitions)', () => {
    const r = new ControllerReader();
    const left = r.read([pad({ pressed: [12, 14, 4], values: { 6: 0.8 } })], ALL_CONTROLLERS);
    expect(left.inputs).toMatchObject({
      ControllerButtonsAnyLeft: 1,
      ControllerButtonsAnyRight: 0,
      ControllerButtonCountLeft: 4,
      ControllerButtonCountRight: 0,
      ControllerLean: -0.5,
    });
    const both = r.read([pad({ pressed: [0, 1, 8], axes: [1, 0, 1, 0] })], ALL_CONTROLLERS);
    expect(both.inputs).toMatchObject({
      ControllerButtonCountLeft: 1,
      ControllerButtonCountRight: 2,
      ControllerLean: 0.5,
    });
    // Home is on neither side.
    expect(r.read([pad({ pressed: [16] })], ALL_CONTROLLERS).inputs).toMatchObject({
      ControllerHome: 1,
      ControllerButtonsAnyLeft: 0,
      ControllerButtonsAnyRight: 0,
    });
  });

  it('estimates where the thumbs and index fingers are, keeping the last place', () => {
    const r = new ControllerReader();
    const read = (p: PadLike) => r.read([p], ALL_CONTROLLERS).inputs;
    expect(read(pad())).toMatchObject({
      ControllerThumbPosLeft: 1,
      ControllerThumbPosRight: 0,
      ControllerFingerPosLeft: 0,
    });
    expect(read(pad({ pressed: [13] })).ControllerThumbPosLeft).toBe(0);
    expect(read(pad()).ControllerThumbPosLeft).toBe(0);
    expect(read(pad({ pressed: [9] })).ControllerThumbPosRight).toBe(2);
    expect(read(pad({ axes: [0, 0, 0.8, 0] })).ControllerThumbPosRight).toBe(1);
    const touched = read(pad({ buttons: 18, touches: [{ touchId: 0, position: [0.6, -1] }] }));
    expect(touched).toMatchObject({
      ControllerThumbPosRight: 3,
      ControllerTouchPadTouchCount: 1,
      ControllerTouchPadFingerLeftActive: 1,
      ControllerTouchPadFingerRightActive: 0,
      ControllerTouchPadFingerLeftX: 0.8,
      ControllerTouchPadFingerLeftY: 1,
      ControllerTouchPadPress: 0,
    });
    expect(read(pad({ values: { 6: 0.3 } })).ControllerFingerPosLeft).toBe(1);
    expect(read(pad({ values: { 6: 0.3 }, pressed: [4] })).ControllerFingerPosLeft).toBe(2);
    expect(read(pad()).ControllerFingerPosLeft).toBe(2);
    expect(read(pad({ pressed: [5] })).ControllerFingerPosRight).toBe(0);
  });

  it('gives the orientation from the first pose, and resets it', () => {
    const r = new ControllerReader();
    const turn = (deg: number): PadLike => {
      const a = (deg * Math.PI) / 360;
      return pad({ pose: { hasOrientation: true, orientation: [0, Math.sin(a), 0, Math.cos(a)] } });
    };
    expect(r.read([turn(10)], ALL_CONTROLLERS).inputs.ControllerOrientationX).toBeCloseTo(0);
    expect(r.read([turn(40)], ALL_CONTROLLERS).inputs.ControllerOrientationX).toBeCloseTo(30);
    r.resetOrientation();
    expect(r.read([turn(40)], ALL_CONTROLLERS).inputs.ControllerOrientationX).toBeCloseTo(0);
    const [, pitch, roll] = quatToEuler([Math.sin(Math.PI / 12), 0, 0, Math.cos(Math.PI / 12)]);
    expect(pitch).toBeCloseTo(30);
    expect(roll).toBeCloseTo(0);
  });

  it('turns buttons and stick directions into hotkey triggers', () => {
    const r = new ControllerReader();
    const pressed = (p: PadLike) => [...r.read([p], ALL_CONTROLLERS).pressed].sort();
    expect(pressed(pad({ pressed: [0, 15], values: { 7: 0.7 } }))).toEqual([
      'PadCross',
      'PadR2',
      'PadRight',
    ]);
    // A stick direction past 0.6 presses, and stays pressed down to 0.4.
    expect(pressed(pad({ axes: [0, -0.8, 0, 0] }))).toEqual(['PadLeftStickUp']);
    expect(pressed(pad({ axes: [0, -0.5, 0, 0] }))).toEqual(['PadLeftStickUp']);
    expect(pressed(pad({ axes: [0, -0.3, 0, 0] }))).toEqual([]);
    expect(pressed(pad({ axes: [0, -0.5, 0, 0] }))).toEqual([]);
    expect(pressed(pad({ axes: [0, 0, -0.9, 0] }))).toEqual(['PadRightStickLeft']);
    // As hotkey keys: alone or with a keyboard key, labelled, and not system-wide.
    expect(normalizeCombo('PadCross+KeyQ')).toBe('KeyQ+PadCross');
    expect(comboLabel('Shift+PadLeftStickUp')).toBe('Shift+Controller left stick up');
    expect(comboLabel('PadCross')).toBe('Controller Cross (A)');
    expect(PAD_TRIGGERS).toHaveLength(26);
    expect(
      planGlobalHotkey(
        { id: 'h', label: '', keys: 'PadCross', button: false, action: { type: 'calibrate' } },
        'linux',
      ),
    ).toMatchObject({ reason: expect.stringContaining('Controller buttons') });
  });
});
