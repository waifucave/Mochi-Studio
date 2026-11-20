/**
 * The controller: the 39 controller inputs from the
 * browser's Gamepad API, and its buttons and stick directions as hotkey
 * triggers.
 *
 * - **Which controllers** (3.1): none, all of them combined, or one,
 *   chosen by its name. Combined: a button counts while any controller
 *   holds it, a stick and a trigger are the one pushed furthest, and the
 *   touchpad and orientation come from the first controller that has them.
 * - **The buttons** follow the browser's standard layout. Sticks get a dead
 *   zone of 0.1 (`STICK_DEAD_ZONE`), Y is positive upwards, and the D-pad is
 *   −1, 0 or 1 on each axis.
 * - **Touchpad and orientation** only where the browser gives them (the
 *   Gamepad extensions' `touches` and `pose`); otherwise those inputs are
 *   absent, and so is the touchpad press without that button.
 * - **Mochi Studio's own definitions** for what the documentation leaves
 *   open:
 *   - the left side's buttons are the D-pad's four, L1, L2, L3 and the left
 *     option button; the right side's are the four face buttons, R1, R2, R3
 *     and the right option button (`CONTROLLER_SIDE_BUTTONS`). A trigger
 *     counts as held past half-way. Home and the touchpad are on neither;
 *   - `ControllerLean`: half a step towards the side whose buttons are held
 *     (none or both: no step), plus a quarter of the two sticks' X, within
 *     −1 to 1;
 *   - the thumb places (0 the buttons, 1 the stick, 2 an option button, 3
 *     the touchpad): the last place each thumb was seen at, by what it
 *     holds or touches: the touchpad's touch on its side, then the option
 *     button, then the stick (pushed past 0.3, or pressed), then the D-pad or
 *     face buttons. Before any, the left thumb is on its stick (1) and the
 *     right on the buttons (0);
 *   - the index finger places (0 the shoulder button, 1 the trigger, 2
 *     both): the trigger counts from 0.1; the last place stays while
 *     neither is touched, from 0.
 * - **Orientation** in degrees from the pose when the controller was first
 *   seen, or since `resetOrientation`: yaw, pitch and roll, not limited.
 */
import { clamp } from './math';
import type { InputValues } from './tracking';

export interface PadButton {
  pressed: boolean;
  value: number;
}
/** A touch on a touchpad (the Gamepad extensions): x and y from −1 (left, top) to 1. */
export interface PadTouch {
  touchId: number;
  position: ArrayLike<number>;
}
export interface PadPose {
  hasOrientation?: boolean;
  /** A quaternion: x, y, z, w. */
  orientation: ArrayLike<number> | null;
}
/** What Mochi Studio reads of a `Gamepad`. */
export interface PadLike {
  id: string;
  index: number;
  connected: boolean;
  axes: readonly number[];
  buttons: readonly PadButton[];
  touches?: readonly PadTouch[] | null;
  pose?: PadPose | null;
}

/** Which controllers are read: none, all, or one by its name (`Gamepad.id`). */
export type ControllerChoice = string;
export const NO_CONTROLLER = 'none';
export const ALL_CONTROLLERS = 'all';

export const STICK_DEAD_ZONE = 0.1;
/** A stick direction counts as pressed past this, and released below the second. */
const DIRECTION_ON = 0.6;
const DIRECTION_OFF = 0.4;

/** The standard layout's buttons, by index (the browser's "standard" mapping). */
const BUTTON = {
  Cross: 0,
  Circle: 1,
  Square: 2,
  Triangle: 3,
  L1: 4,
  R1: 5,
  L2: 6,
  R2: 7,
  Select: 8,
  Start: 9,
  L3: 10,
  R3: 11,
  Up: 12,
  Down: 13,
  Left: 14,
  Right: 15,
  Home: 16,
  Touchpad: 17,
} as const;
type ButtonName = keyof typeof BUTTON;
const BUTTON_NAMES = Object.keys(BUTTON) as ButtonName[];
const STICK_DIRECTIONS = ['Up', 'Down', 'Left', 'Right'] as const;

/** The hotkey trigger of a button or stick direction: `PadCross`, `PadLeftStickUp`. */
export const padCode = (name: string): string => `Pad${name}`;
export const isPadCode = (code: string): boolean => /^Pad[A-Z]/.test(code);

const BUTTON_LABELS: Record<ButtonName, string> = {
  Cross: 'Cross (A)',
  Circle: 'Circle (B)',
  Square: 'Square (X)',
  Triangle: 'Triangle (Y)',
  L1: 'L1 (LB)',
  R1: 'R1 (RB)',
  L2: 'L2 (LT)',
  R2: 'R2 (RT)',
  Select: 'Select (Share, View)',
  Start: 'Start (Options, Menu)',
  L3: 'L3 (left stick press)',
  R3: 'R3 (right stick press)',
  Up: 'D-pad up',
  Down: 'D-pad down',
  Left: 'D-pad left',
  Right: 'D-pad right',
  Home: 'Home',
  Touchpad: 'Touchpad press',
};

/** Every trigger code and its label, for the hotkey editor. */
export const PAD_TRIGGERS: ReadonlyArray<readonly [string, string]> = [
  ...BUTTON_NAMES.map((b) => [padCode(b), `Controller ${BUTTON_LABELS[b]}`] as const),
  ...(['Left', 'Right'] as const).flatMap((s) =>
    STICK_DIRECTIONS.map(
      (d) =>
        [
          padCode(`${s}Stick${d}`),
          `Controller ${s.toLowerCase()} stick ${d.toLowerCase()}`,
        ] as const,
    ),
  ),
];
const PAD_LABELS = new Map(PAD_TRIGGERS);
export const padLabel = (code: string): string => PAD_LABELS.get(code) ?? code;

/** One controller's reading: sticks after the dead zone (Y up), button values 0–1. */
interface Reading {
  sticks: [number, number, number, number];
  buttons: Partial<Record<ButtonName, number>>;
  touches?: readonly PadTouch[];
  orientation?: ArrayLike<number>;
}

export function deadZone(x: number, y: number, dz = STICK_DEAD_ZONE): [number, number] {
  const m = Math.hypot(x, y);
  if (!(m > dz)) return [0, 0];
  const k = Math.min(1, (m - dz) / (1 - dz)) / m;
  return [clamp(x * k, -1, 1) || 0, clamp(y * k, -1, 1) || 0];
}

function readPad(p: PadLike): Reading {
  const a = (i: number): number => {
    const v = p.axes[i];
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  };
  // The browser's Y axes point down; the inputs' point up.
  const [lx, ly] = deadZone(a(0), -a(1));
  const [rx, ry] = deadZone(a(2), -a(3));
  const buttons: Reading['buttons'] = {};
  for (const name of BUTTON_NAMES) {
    const b = p.buttons[BUTTON[name]];
    if (!b) continue;
    // An analog button (a trigger) keeps its value; a button that only says it is pressed is 1.
    const v = typeof b.value === 'number' && Number.isFinite(b.value) ? b.value : 0;
    buttons[name] = clamp(v > 0 ? v : b.pressed ? 1 : 0, 0, 1);
  }
  const pose = p.pose;
  return {
    sticks: [lx, ly, rx, ry],
    buttons,
    ...(Array.isArray(p.touches) ? { touches: p.touches } : {}),
    ...(pose && pose.hasOrientation !== false && pose.orientation && pose.orientation.length >= 4
      ? { orientation: pose.orientation }
      : {}),
  };
}

/** Several controllers as one: buttons held by any, sticks and triggers pushed furthest. */
function combine(rs: readonly Reading[]): Reading {
  const furthest = (i: 0 | 2): [number, number] => {
    let best: [number, number] = [0, 0];
    for (const r of rs) {
      const v: [number, number] = [r.sticks[i], r.sticks[i + 1]!];
      if (Math.hypot(...v) > Math.hypot(...best)) best = v;
    }
    return best;
  };
  const buttons: Reading['buttons'] = {};
  for (const r of rs)
    for (const [k, v] of Object.entries(r.buttons) as [ButtonName, number][])
      buttons[k] = Math.max(buttons[k] ?? 0, v);
  const touches = rs.find((r) => r.touches)?.touches;
  const orientation = rs.find((r) => r.orientation)?.orientation;
  return {
    sticks: [...furthest(0), ...furthest(2)],
    buttons,
    ...(touches ? { touches } : {}),
    ...(orientation ? { orientation } : {}),
  };
}

type Quat = [number, number, number, number];
const quat = (q: ArrayLike<number>): Quat => [q[0] ?? 0, q[1] ?? 0, q[2] ?? 0, q[3] ?? 1];
const conj = ([x, y, z, w]: Quat): Quat => [-x, -y, -z, w];
function mul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}
const DEG = 180 / Math.PI;
/** Yaw (about the vertical axis), pitch (about the side axis) and roll (about the forward axis), degrees. */
export function quatToEuler(q: Quat): [number, number, number] {
  const [x, y, z, w] = q;
  const yaw = Math.atan2(2 * (w * y + x * z), 1 - 2 * (x * x + y * y));
  const pitch = Math.asin(clamp(2 * (w * x - y * z), -1, 1));
  const roll = Math.atan2(2 * (w * z + x * y), 1 - 2 * (x * x + z * z));
  return [yaw * DEG, pitch * DEG, roll * DEG];
}

export interface ControllerFrame {
  /** The controller inputs; empty without a controller. */
  inputs: InputValues;
  /** The trigger codes held now (buttons and stick directions). */
  pressed: Set<string>;
  /** The controllers read, by name. */
  used: string[];
}

/** Reads the chosen controllers each frame, keeping what the estimates need. */
export class ControllerReader {
  private thumb = { left: 1, right: 0 };
  private finger = { left: 0, right: 0 };
  private zero: Quat | undefined;
  private directions = new Set<string>();

  /** The current orientation becomes zero. */
  resetOrientation(): void {
    this.zero = undefined;
  }

  read(pads: ReadonlyArray<PadLike | null>, choice: ControllerChoice): ControllerFrame {
    const live = pads.filter((p): p is PadLike => !!p && p.connected);
    const chosen =
      choice === NO_CONTROLLER
        ? []
        : choice === ALL_CONTROLLERS
          ? live
          : live.filter((p) => p.id === choice).slice(0, 1);
    if (!chosen.length) {
      this.directions.clear();
      return { inputs: {}, pressed: new Set(), used: [] };
    }
    const r = combine(chosen.map(readPad));
    return { inputs: this.inputs(r), pressed: this.pressed(r), used: chosen.map((p) => p.id) };
  }

  private pressed(r: Reading): Set<string> {
    const out = new Set<string>();
    for (const [k, v] of Object.entries(r.buttons)) if (v >= 0.5) out.add(padCode(k));
    const [lx, ly, rx, ry] = r.sticks;
    const sides = { Left: [lx, ly], Right: [rx, ry] } as const;
    for (const [s, [x, y]] of Object.entries(sides)) {
      const amounts = { Up: y, Down: -y, Left: -x, Right: x };
      for (const d of STICK_DIRECTIONS) {
        const code = padCode(`${s}Stick${d}`);
        const on = this.directions.has(code)
          ? amounts[d] > DIRECTION_OFF
          : amounts[d] > DIRECTION_ON;
        if (on) this.directions.add(code);
        else this.directions.delete(code);
        if (on) out.add(code);
      }
    }
    return out;
  }

  private inputs(r: Reading): InputValues {
    const b = (n: ButtonName): number => r.buttons[n] ?? 0;
    const held = (n: ButtonName): boolean => b(n) >= 0.5;
    const flag = (n: ButtonName): number => (held(n) ? 1 : 0);
    const [lx, ly, rx, ry] = r.sticks;
    const out: InputValues = {
      ControllerStickLeftX: lx,
      ControllerStickLeftY: ly,
      ControllerStickRightX: rx,
      ControllerStickRightY: ry,
      ControllerStickPressLeft: flag('L3'),
      ControllerStickPressRight: flag('R3'),
      ControllerDPadX: flag('Right') - flag('Left'),
      ControllerDPadY: flag('Up') - flag('Down'),
      ControllerTriangle: flag('Triangle'),
      ControllerCross: flag('Cross'),
      ControllerSquare: flag('Square'),
      ControllerCircle: flag('Circle'),
      ControllerShoulderLeft: flag('L1'),
      ControllerShoulderRight: flag('R1'),
      ControllerTriggerLeft: b('L2'),
      ControllerTriggerRight: b('R2'),
      ControllerOptionLeft: flag('Select'),
      ControllerOptionRight: flag('Start'),
      ControllerHome: flag('Home'),
    };
    if (r.buttons.Touchpad !== undefined) out.ControllerTouchPadPress = flag('Touchpad');

    // The side aggregates (Mochi Studio's split, above).
    const left = (['Up', 'Down', 'Left', 'Right', 'L1', 'L2', 'L3', 'Select'] as const).filter(
      held,
    );
    const right = (
      ['Triangle', 'Cross', 'Square', 'Circle', 'R1', 'R2', 'R3', 'Start'] as const
    ).filter(held);
    const anyL = left.length ? 1 : 0;
    const anyR = right.length ? 1 : 0;
    out.ControllerButtonsAnyLeft = anyL;
    out.ControllerButtonsAnyRight = anyR;
    out.ControllerButtonCountLeft = left.length;
    out.ControllerButtonCountRight = right.length;
    out.ControllerLean = clamp(0.5 * (anyR - anyL) + 0.25 * (lx + rx), -1, 1);

    // The touchpad, where the browser gives it: the first two touches.
    let touchLeft = false;
    let touchRight = false;
    if (r.touches) {
      const t = r.touches.slice(0, 2);
      out.ControllerTouchPadTouchCount = t.length;
      (['Left', 'Right'] as const).forEach((s, i) => {
        const touch = t[i];
        out[`ControllerTouchPadFinger${s}Active`] = touch ? 1 : 0;
        // 0 at the left and at the bottom, 1 at the right and at the top.
        const px = touch ? clamp(((touch.position[0] ?? 0) + 1) / 2, 0, 1) : 0;
        const py = touch ? clamp((1 - (touch.position[1] ?? 0)) / 2, 0, 1) : 0;
        out[`ControllerTouchPadFinger${s}X`] = px;
        out[`ControllerTouchPadFinger${s}Y`] = py;
        if (touch && px < 0.5) touchLeft = true;
        if (touch && px >= 0.5) touchRight = true;
      });
    }

    // Where the thumbs and index fingers probably are (Mochi Studio's estimates, above).
    const moved = (x: number, y: number): boolean => Math.hypot(x, y) > 0.3;
    if (touchLeft) this.thumb.left = 3;
    else if (held('Select')) this.thumb.left = 2;
    else if (moved(lx, ly) || held('L3')) this.thumb.left = 1;
    else if (held('Up') || held('Down') || held('Left') || held('Right')) this.thumb.left = 0;
    if (touchRight) this.thumb.right = 3;
    else if (held('Start')) this.thumb.right = 2;
    else if (moved(rx, ry) || held('R3')) this.thumb.right = 1;
    else if (held('Triangle') || held('Cross') || held('Square') || held('Circle'))
      this.thumb.right = 0;
    for (const [side, shoulder, trigger] of [
      ['left', 'L1', 'L2'],
      ['right', 'R1', 'R2'],
    ] as const) {
      const s = held(shoulder);
      const t = b(trigger) >= 0.1;
      if (s || t) this.finger[side] = s && t ? 2 : t ? 1 : 0;
    }
    out.ControllerThumbPosLeft = this.thumb.left;
    out.ControllerThumbPosRight = this.thumb.right;
    out.ControllerFingerPosLeft = this.finger.left;
    out.ControllerFingerPosRight = this.finger.right;

    // Orientation, where the browser gives it, from the zero pose.
    if (r.orientation) {
      const q = quat(r.orientation);
      this.zero ??= q;
      const [yaw, pitch, roll] = quatToEuler(mul(conj(this.zero), q));
      out.ControllerOrientationX = yaw;
      out.ControllerOrientationY = pitch;
      out.ControllerOrientationZ = roll;
    }
    return out;
  }
}
