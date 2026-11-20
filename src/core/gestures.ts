/**
 * Hand gestures and gesture hotkeys:
 * a gesture per hand or a two-hand pose; two gestures combined with AND or
 * OR; an optional mirrored match; a hold time; a pinch, an OK sign, and a
 * sensitivity per gesture.
 *
 * The gestures, from the fingers' straightness (0 curled to 1 straight,
 * src/core/hands.ts) and the gap between the thumb and index tips (in hand
 * lengths, wrist to middle knuckle). At the default sensitivity (50), a
 * finger counts as straight from 0.65 and as curled up to 0.4; in between
 * it counts as neither, so a half-bent finger matches no gesture of the
 * table's last five. The tips touch closer than 0.25 hand lengths.
 *
 * | Gesture   | The thumb                | Index      | Middle   | Ring, pinky |
 * | --------- | ------------------------ | ---------- | -------- | ----------- |
 * | ok        | its tip on the index tip | not curled | straight | straight    |
 * | pinch     | its tip on the index tip | not curled | any      | any         |
 * | open      | straight                 | straight   | straight | straight    |
 * | fist      | not straight             | curled     | curled   | curled      |
 * | point     | any                      | straight   | curled   | curled      |
 * | peace     | any                      | straight   | straight | curled      |
 * | thumbsUp  | straight, pointing up    | curled     | curled   | curled      |
 *
 * They are tried in this order, so an OK sign is not also a pinch.
 * "Pointing up": the thumb's direction in the picture within about 50° of
 * straight up. The two-hand pose `together`: both hands found, palms closer
 * than 2.5 position units (an eighth of the picture's width).
 *
 * **Sensitivity** (0 to 100, default 50, per gesture and for the pose):
 * higher is recognized more easily. From 0 to 100, "straight" goes from
 * 0.75 to 0.55, "curled" from 0.3 to 0.5, "pointing up" from about 30° to
 * 65°, touching tips from 0.15 to 0.35 hand lengths, and "together" from
 * 1.5 to 3.5 position units.
 */
import type { HandReading, HandSide } from './hands';

export const GESTURES = ['open', 'fist', 'point', 'peace', 'thumbsUp', 'pinch', 'ok'] as const;
export type Gesture = (typeof GESTURES)[number];
export const TWO_HAND_POSES = ['together'] as const;
export type TwoHandPose = (typeof TWO_HAND_POSES)[number];

export const GESTURE_LABELS: Record<Gesture, string> = {
  open: 'Open hand',
  fist: 'Fist',
  point: 'Point',
  peace: 'Peace sign',
  thumbsUp: 'Thumbs up',
  pinch: 'Pinch',
  ok: 'OK sign',
};
export const POSE_LABELS: Record<TwoHandPose, string> = { together: 'Hands together' };

export const STRAIGHT = 0.65;
export const CURLED = 0.4;
/** The thumb's direction, cos of its angle from straight up, from which it points up. */
export const THUMB_UP = 0.64;
/** Thumb and index tips closer than this (hand lengths) touch. */
export const TOUCH = 0.25;
/** Palms closer than this (position units) are together. */
export const TOGETHER = 2.5;

/** How easily each gesture (and the pose) is recognized, 0 to 100; missing ones are 50. */
export type GestureSensitivity = Partial<Record<Gesture | TwoHandPose, number>>;
export const DEFAULT_SENSITIVITY = 50;

/** The thresholds for one sensitivity. */
export function thresholds(sensitivity = DEFAULT_SENSITIVITY): {
  straight: number;
  curled: number;
  thumbUp: number;
  touch: number;
  together: number;
} {
  const k = (Math.max(0, Math.min(100, sensitivity)) - 50) / 100; // −0.5 … 0.5
  return {
    straight: STRAIGHT - k * 0.2,
    curled: CURLED + k * 0.2,
    thumbUp: THUMB_UP - k * 0.44,
    touch: TOUCH + k * 0.2,
    together: TOGETHER + k * 2,
  };
}

/** A hand's gesture, or undefined for none. */
export function recognize(
  r: HandReading,
  sensitivity: GestureSensitivity = {},
): Gesture | undefined {
  const { Thumb: t, Index: i, Middle: m, Ring: rg, Pinky: p } = r.fingers;
  const is = (g: Gesture): ((test: (th: ReturnType<typeof thresholds>) => boolean) => boolean) => {
    const th = thresholds(sensitivity[g]);
    return (test) => test(th);
  };
  const s = (v: number, th: { straight: number }) => v >= th.straight;
  const c = (v: number, th: { curled: number }) => v <= th.curled;
  if (is('ok')((th) => r.tipGap <= th.touch && !c(i, th) && s(m, th) && s(rg, th) && s(p, th)))
    return 'ok';
  if (is('pinch')((th) => r.tipGap <= th.touch && !c(i, th))) return 'pinch';
  if (is('open')((th) => s(t, th) && s(i, th) && s(m, th) && s(rg, th) && s(p, th))) return 'open';
  if (
    is('thumbsUp')(
      (th) => c(i, th) && c(m, th) && c(rg, th) && c(p, th) && s(t, th) && r.thumbUp >= th.thumbUp,
    )
  )
    return 'thumbsUp';
  if (is('fist')((th) => c(i, th) && c(m, th) && c(rg, th) && c(p, th) && !s(t, th))) return 'fist';
  if (is('point')((th) => s(i, th) && c(m, th) && c(rg, th) && c(p, th))) return 'point';
  if (is('peace')((th) => s(i, th) && s(m, th) && c(rg, th) && c(p, th))) return 'peace';
  return undefined;
}

/** What the hands show in a frame: each hand's gesture (the subject's own sides), and the pose. */
export interface HandGestures {
  left?: Gesture;
  right?: Gesture;
  together: boolean;
}

export function handGestures(
  readings: Partial<Record<HandSide, HandReading>>,
  sensitivity: GestureSensitivity = {},
): HandGestures {
  const l = readings.left;
  const r = readings.right;
  const together =
    !!l &&
    !!r &&
    Math.hypot(l.palm[0] - r.palm[0], l.palm[1] - r.palm[1]) * 20 <
      thresholds(sensitivity.together).together;
  const gl = l && recognize(l, sensitivity);
  const gr = r && recognize(r, sensitivity);
  return { ...(gl ? { left: gl } : {}), ...(gr ? { right: gr } : {}), together };
}

/** Validates stored sensitivities: known gestures and the pose, 0 to 100. */
export function parseSensitivity(v: unknown): GestureSensitivity {
  if (typeof v !== 'object' || v === null) return {};
  const out: GestureSensitivity = {};
  for (const k of [...GESTURES, ...TWO_HAND_POSES]) {
    const x = (v as Record<string, unknown>)[k];
    if (typeof x === 'number' && Number.isFinite(x)) out[k] = Math.max(0, Math.min(100, x));
  }
  return out;
}

/** A hotkey's gesture trigger. */
export interface GestureTrigger {
  /** The subject's own left and right hands' gestures (one or both). */
  left?: Gesture;
  right?: Gesture;
  /** A two-hand pose instead of the hands' gestures. */
  pose?: TwoHandPose;
  /** With both hands' gestures: both (AND) or either (OR). */
  combine: 'and' | 'or';
  /** Also match with the hands swapped (the left gesture on the right hand, and so on). */
  mirrored: boolean;
  /** Seconds the gesture must be held before the hotkey fires. */
  hold: number;
}

export const DEFAULT_GESTURE_HOLD = 0.5;
export const MAX_GESTURE_HOLD = 10;

/** Whether the hands show a trigger's gesture. */
export function gestureMatches(t: GestureTrigger, g: HandGestures): boolean {
  if (t.pose) return t.pose === 'together' && g.together;
  if (!t.left && !t.right) return false;
  const test = (left: Gesture | undefined, right: Gesture | undefined): boolean => {
    const okL = left ? g.left === left : undefined;
    const okR = right ? g.right === right : undefined;
    if (okL === undefined) return okR!;
    if (okR === undefined) return okL;
    return t.combine === 'or' ? okL || okR : okL && okR;
  };
  return test(t.left, t.right) || (t.mirrored && test(t.right, t.left));
}

/** Validates a stored trigger. */
export function parseGestureTrigger(v: unknown): GestureTrigger | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const o = v as Record<string, unknown>;
  const g = (x: unknown): Gesture | undefined =>
    GESTURES.find((n) => n === x) as Gesture | undefined;
  const left = g(o.left);
  const right = g(o.right);
  const pose = TWO_HAND_POSES.find((p) => p === o.pose);
  if (!left && !right && !pose) return undefined;
  const hold =
    typeof o.hold === 'number' && Number.isFinite(o.hold)
      ? Math.max(0, Math.min(MAX_GESTURE_HOLD, o.hold))
      : DEFAULT_GESTURE_HOLD;
  return {
    ...(pose ? { pose } : {}),
    ...(!pose && left ? { left } : {}),
    ...(!pose && right ? { right } : {}),
    combine: o.combine === 'or' ? 'or' : 'and',
    mirrored: o.mirrored === true,
    hold,
  };
}

/**
 * Fires gesture hotkeys: a hotkey fires once its gesture has been held for
 * its hold time, and is released when the gesture ends (for "while held").
 * It fires again only after the gesture has ended.
 */
export class GestureWatcher {
  private state = new Map<string, { since: number; fired: boolean }>();

  step(
    hotkeys: ReadonlyArray<{ id: string; gesture?: GestureTrigger }>,
    g: HandGestures | undefined,
    t: number,
  ): { fire: string[]; release: string[] } {
    const fire: string[] = [];
    const release: string[] = [];
    const seen = new Set<string>();
    for (const h of hotkeys) {
      if (!h.gesture) continue;
      seen.add(h.id);
      const st = this.state.get(h.id);
      if (g && gestureMatches(h.gesture, g)) {
        const s = st ?? { since: t, fired: false };
        if (!st) this.state.set(h.id, s);
        if (!s.fired && t - s.since >= h.gesture.hold * 1000) {
          s.fired = true;
          fire.push(h.id);
        }
      } else if (st) {
        if (st.fired) release.push(h.id);
        this.state.delete(h.id);
      }
    }
    for (const id of [...this.state.keys()]) if (!seen.has(id)) this.state.delete(id);
    return { fire, release };
  }

  reset(): void {
    this.state.clear();
  }
}
