/**
 * The Camera tab's hand tracking:
 * what the camera tracks (the face, the hands, or both), and a hand preview,
 * off by default, that draws only the detected points (never the camera
 * picture), with the fingers, how open each hand is, the distance between
 * the hands and the gestures seen. It is in the settings, never in outputs.
 */
import { FINGERS, type HandReading, type HandSide } from '../core/hands';
import {
  DEFAULT_SENSITIVITY,
  GESTURE_LABELS,
  GESTURES,
  POSE_LABELS,
  TWO_HAND_POSES,
  type Gesture,
  type TwoHandPose,
} from '../core/gestures';
import { h, select } from './dom';
import { TRACKING_MODES, type TrackingMode } from './faceTracker';
import type { Studio } from './studio';

type Notify = (message: string, kind?: 'error') => void;

const MODE_LABELS: Record<TrackingMode, string> = {
  face: 'Face only',
  hands: 'Hands only',
  both: 'Face and hands',
};

/** The bones between the 21 points (MediaPipe's hand landmarks). */
const BONES: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 4],
  [0, 5],
  [5, 6],
  [6, 7],
  [7, 8],
  [5, 9],
  [9, 10],
  [10, 11],
  [11, 12],
  [9, 13],
  [13, 14],
  [14, 15],
  [15, 16],
  [13, 17],
  [0, 17],
  [17, 18],
  [18, 19],
  [19, 20],
];

export function handsPanel(
  studio: Studio,
  notify: Notify,
): { el: HTMLElement; refresh(): void; live(): void } {
  const canvas = h('canvas', {
    id: 'hand-preview',
    width: 320,
    height: 240,
    'aria-label': 'Hand points (no camera picture)',
  });
  const readouts = h('div', { class: 'hand-readouts', id: 'hand-readouts' });
  const preview = h('div', { class: 'hand-preview', hidden: true }, canvas, readouts);
  const controls = h('div');
  const el = h('div', { class: 'hands' }, controls, preview);
  let sensitivityOpen = false;

  /** A slider per gesture and for the two-hand pose, 0 to 100. */
  function sensitivity(): HTMLElement {
    const sens = studio.app.gestureSensitivity;
    const all: Array<Gesture | TwoHandPose> = [...GESTURES, ...TWO_HAND_POSES];
    return h(
      'details',
      {
        class: 'gesture-sensitivity',
        id: 'gesture-sensitivity',
        open: sensitivityOpen,
        ontoggle: (e: Event) => {
          sensitivityOpen = (e.target as HTMLDetailsElement).open;
        },
      },
      h('summary', {}, 'Gesture sensitivity'),
      h(
        'p',
        { class: 'hint' },
        'Higher: the gesture is recognized more easily, and more often by mistake. 50 is the default.',
      ),
      ...all.map((g) => {
        const label = g === 'together' ? POSE_LABELS[g] : GESTURE_LABELS[g as Gesture];
        const value = sens[g] ?? DEFAULT_SENSITIVITY;
        const shown = h('output', {}, String(value));
        return h(
          'label',
          { class: 'slider' },
          label,
          h('input', {
            type: 'range',
            min: 0,
            max: 100,
            step: 5,
            value,
            'data-gesture': g,
            'aria-label': `${label}: sensitivity`,
            oninput: (e: Event) => {
              shown.textContent = (e.target as HTMLInputElement).value;
            },
            onchange: (e: Event) =>
              studio.setGestureSensitivity(g, Number((e.target as HTMLInputElement).value)),
          }),
          shown,
        );
      }),
    );
  }

  function refresh(): void {
    // The section's own state, not its toggle event (which comes later than a re-render may).
    const shown = controls.querySelector<HTMLDetailsElement>('details.gesture-sensitivity');
    if (shown) sensitivityOpen = shown.open;
    const mode = select(
      TRACKING_MODES.map((m) => [m, MODE_LABELS[m]] as const),
      studio.trackingMode,
      (v) =>
        void studio
          .setTrackingMode(v)
          .catch((e: Error) => notify(e.message, 'error'))
          .finally(refresh),
      'The camera tracks',
    );
    mode.id = 'tracking-mode';
    controls.replaceChildren(
      h('label', {}, 'The camera tracks', mode),
      studio.trackingMode !== 'face'
        ? h(
            'label',
            { class: 'check' },
            h('input', {
              type: 'checkbox',
              id: 'hand-preview-toggle',
              checked: studio.app.handPreview,
              onchange: (e: Event) => {
                studio.setHandPreview((e.target as HTMLInputElement).checked);
                refresh();
              },
            }),
            'Show the hands here (their points only, never the picture)',
          )
        : '',
      studio.trackingMode !== 'face' ? sensitivity() : '',
    );
    preview.hidden = !(studio.trackingMode !== 'face' && studio.app.handPreview);
  }

  /** Draws the hands and their readouts (from the UI's timer). */
  function live(): void {
    if (preview.hidden) return;
    const g = canvas.getContext('2d');
    const hands = studio.handReadings;
    const frame = studio.latestHands;
    if (g) {
      g.clearRect(0, 0, canvas.width, canvas.height);
      g.fillStyle = 'rgba(127,127,127,0.12)';
      g.fillRect(0, 0, canvas.width, canvas.height);
      // As in a mirror, like the camera picture.
      for (const hand of frame) {
        g.strokeStyle = hand.side === 'left' ? '#3a86ff' : '#ff6b8b';
        g.fillStyle = g.strokeStyle;
        g.lineWidth = 2;
        const at = (i: number): [number, number] => {
          const p = hand.points[i]!;
          return [(1 - p[0]) * canvas.width, p[1] * canvas.height];
        };
        g.beginPath();
        for (const [a, b] of BONES) {
          g.moveTo(...at(a));
          g.lineTo(...at(b));
        }
        g.stroke();
        for (let i = 0; i < hand.points.length; i++) {
          const [x, y] = at(i);
          g.beginPath();
          g.arc(x, y, 2.5, 0, Math.PI * 2);
          g.fill();
        }
      }
    }
    const gest = studio.handGestures;
    const row = (side: HandSide, r: HandReading | undefined) =>
      h(
        'div',
        { class: 'hand-readout', 'data-side': side },
        h('b', {}, side === 'left' ? 'Your left hand' : 'Your right hand'),
        r
          ? h(
              'span',
              {},
              `open ${r.open.toFixed(2)} · ${FINGERS.map((f) => `${f.toLowerCase()} ${r.fingers[f].toFixed(2)}`).join(' · ')}`,
              gest?.[side] ? h('span', { class: 'chip gesture' }, GESTURE_LABELS[gest[side]!]) : '',
            )
          : h('span', { class: 'hint' }, 'not seen'),
      );
    const distance = studio.lastInputs.HandDistance;
    readouts.replaceChildren(
      row('left', hands.left),
      row('right', hands.right),
      h(
        'div',
        { class: 'hint' },
        distance === undefined
          ? 'Both hands: not seen together.'
          : `Distance between the hands: ${distance.toFixed(1)}${gest?.together ? ' (together)' : ''}`,
      ),
    );
  }

  refresh();
  return { el, refresh, live };
}
