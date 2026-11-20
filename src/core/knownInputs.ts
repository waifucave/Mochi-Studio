/**
 * Input names that are documented beyond the face,
 * voice and hand inputs: the controller (3.2), the mouse (5.1) and mocopi
 * body tracking (5.2), with their documented ranges.
 *
 * They are known names. The mapping editor offers them, with the documented
 * range as a new mapping's input range, and the settings import keeps the
 * mappings that use them; it does not take them for a plugin's custom
 * inputs. An input without a source has no value, like a custom input whose
 * plugin is absent, so a mapping on it does nothing. Mochi Studio has no
 * mocopi receiver, so the mocopi inputs never have a value.
 */
import type { InputInfo } from './tracking';

const centered = (id: string, label: string, min: number, max: number): InputInfo => ({
  id,
  label,
  kind: 'centered',
  min,
  max,
});
const closed = (id: string, label: string, max = 1): InputInfo => ({
  id,
  label,
  kind: 'closed',
  min: 0,
  max,
});

/** Buttons on each side of a controller (src/core/controller.ts has the split). */
const SIDE_BUTTONS = 8;

/** The 39 controller inputs, in its order. */
export const CONTROLLER_INPUTS: readonly InputInfo[] = [
  centered('ControllerStickLeftX', 'Controller: left stick X', -1, 1),
  centered('ControllerStickLeftY', 'Controller: left stick Y', -1, 1),
  centered('ControllerStickRightX', 'Controller: right stick X', -1, 1),
  centered('ControllerStickRightY', 'Controller: right stick Y', -1, 1),
  closed('ControllerStickPressLeft', 'Controller: left stick pressed (L3)'),
  closed('ControllerStickPressRight', 'Controller: right stick pressed (R3)'),
  centered('ControllerDPadX', 'Controller: D-pad left/right', -1, 1),
  centered('ControllerDPadY', 'Controller: D-pad down/up', -1, 1),
  closed('ControllerTriangle', 'Controller: top face button (Triangle, Y)'),
  closed('ControllerCross', 'Controller: bottom face button (Cross, A)'),
  closed('ControllerSquare', 'Controller: left face button (Square, X)'),
  closed('ControllerCircle', 'Controller: right face button (Circle, B)'),
  closed('ControllerShoulderLeft', 'Controller: left shoulder (L1, LB)'),
  closed('ControllerShoulderRight', 'Controller: right shoulder (R1, RB)'),
  closed('ControllerTriggerLeft', 'Controller: left trigger (L2, LT)'),
  closed('ControllerTriggerRight', 'Controller: right trigger (R2, RT)'),
  closed('ControllerOptionLeft', 'Controller: left option button (Select, Share)'),
  closed('ControllerOptionRight', 'Controller: right option button (Start, Options)'),
  closed('ControllerHome', 'Controller: home button'),
  closed('ControllerTouchPadPress', 'Controller: touchpad pressed'),
  closed('ControllerButtonsAnyLeft', 'Controller: any left-side button held'),
  closed('ControllerButtonsAnyRight', 'Controller: any right-side button held'),
  closed('ControllerButtonCountLeft', 'Controller: left-side buttons held', SIDE_BUTTONS),
  closed('ControllerButtonCountRight', 'Controller: right-side buttons held', SIDE_BUTTONS),
  centered('ControllerLean', 'Controller: lean (estimate)', -1, 1),
  closed('ControllerThumbPosLeft', 'Controller: left thumb place (estimate)', 3),
  closed('ControllerThumbPosRight', 'Controller: right thumb place (estimate)', 3),
  closed('ControllerFingerPosLeft', 'Controller: left index finger place (estimate)', 2),
  closed('ControllerFingerPosRight', 'Controller: right index finger place (estimate)', 2),
  closed('ControllerTouchPadTouchCount', 'Controller: fingers on the touchpad', 2),
  closed('ControllerTouchPadFingerLeftActive', 'Controller: touchpad first touch'),
  closed('ControllerTouchPadFingerRightActive', 'Controller: touchpad second touch'),
  closed('ControllerTouchPadFingerLeftX', 'Controller: touchpad first touch X'),
  closed('ControllerTouchPadFingerLeftY', 'Controller: touchpad first touch Y'),
  closed('ControllerTouchPadFingerRightX', 'Controller: touchpad second touch X'),
  closed('ControllerTouchPadFingerRightY', 'Controller: touchpad second touch Y'),
  centered('ControllerOrientationX', 'Controller: turn (yaw, °)', -60, 60),
  centered('ControllerOrientationY', 'Controller: tilt forwards/back (pitch, °)', -60, 60),
  centered('ControllerOrientationZ', 'Controller: tilt sideways (roll, °)', -60, 60),
];

/** The mouse inputs (5.1): the pointer within the set pixel ranges, −1 to 1. */
export const MOUSE_INPUTS: readonly InputInfo[] = [
  centered('MousePositionX', 'Mouse: pointer X', -1, 1),
  centered('MousePositionY', 'Mouse: pointer Y', -1, 1),
];

/**
 * The 29 mocopi inputs (5.2), with their default ranges. The last name is
 * printed without its axis letter in the documentation; `…RightAngleZ` is
 * assumed.
 */
export const MOCOPI_INPUTS: readonly InputInfo[] = [
  closed('MocopiConnected', 'mocopi: connected'),
  centered('MocopiHipAngleZ', 'mocopi: hip sway (°)', -30, 30),
  centered('MocopiAngleX', 'mocopi: head turn (°)', -30, 30),
  centered('MocopiAngleY', 'mocopi: head nod (°)', -30, 30),
  centered('MocopiAngleZ', 'mocopi: head lean (°)', -30, 30),
  centered('MocopiBodyAngleX', 'mocopi: body turn (°)', -10, 10),
  centered('MocopiBodyAngleY', 'mocopi: body lean forwards/back (°)', -10, 10),
  centered('MocopiBodyAngleZ', 'mocopi: body lean sideways (°)', -10, 10),
  centered('MocopiBodyPositionX', 'mocopi: body position X', -1, 1),
  centered('MocopiBodyPositionY', 'mocopi: body position Y', -1, 1),
  centered('MocopiBodyPositionZ', 'mocopi: body position Z', -1, 1),
  ...(['Left', 'Right'] as const).flatMap((s): InputInfo[] => {
    const side = s.toLowerCase();
    return [
      centered(`MocopiUpperArm${s}AngleY`, `mocopi: ${side} upper arm forwards/back (°)`, -90, 90),
      centered(`MocopiUpperArm${s}AngleZ`, `mocopi: ${side} upper arm up/down (°)`, -180, 180),
      centered(`MocopiLowerArm${s}AngleX`, `mocopi: ${side} wrist turn (°)`, -180, 180),
      centered(`MocopiLowerArm${s}AngleY`, `mocopi: ${side} lower arm forwards/back (°)`, -90, 90),
      centered(`MocopiLowerArm${s}AngleZ`, `mocopi: ${side} lower arm bend (°)`, -180, 180),
      centered(`MocopiUpperLeg${s}AngleY`, `mocopi: ${side} upper leg forwards/back (°)`, -30, 30),
      centered(`MocopiUpperLeg${s}AngleZ`, `mocopi: ${side} upper leg sideways (°)`, -30, 30),
      centered(`MocopiLowerLeg${s}AngleY`, `mocopi: ${side} lower leg forwards/back (°)`, -30, 30),
      centered(`MocopiLowerLeg${s}AngleZ`, `mocopi: ${side} lower leg sideways (°)`, -30, 30),
    ];
  }),
];

export const CONTROLLER_INPUT_IDS: ReadonlySet<string> = new Set(
  CONTROLLER_INPUTS.map((i) => i.id),
);
export const MOCOPI_INPUT_IDS: ReadonlySet<string> = new Set(MOCOPI_INPUTS.map((i) => i.id));

/**
 * Why an input may have no value, for the import report and the mapping
 * editor: undefined for inputs whose source Mochi Studio has.
 */
export function missingSource(id: string): string | undefined {
  if (MOCOPI_INPUT_IDS.has(id)) return 'Mochi Studio has no mocopi body tracking yet';
  return undefined;
}
