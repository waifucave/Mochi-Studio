/**
 * The Camera tab's display light overlay: the capture of a
 * screen or window, its three parts, the person's settings, and the color it
 * gives now. Mochi Studio's own design.
 */
import {
  CAPTURE_PARTS,
  defaultLightOverlay,
  type CapturePart,
  type Rgb,
} from '../core/lightOverlay';
import { desktopApi } from './desktopFiles';
import { h } from './dom';
import type { Studio } from './studio';

type Notify = (message: string, kind?: 'info' | 'error') => void;

const PART_LABELS: Record<CapturePart, string> = { left: 'Left', middle: 'Middle', right: 'Right' };
const toHex = (c: Rgb): string =>
  `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
const fromHex = (v: string): Rgb => {
  const n = parseInt(v.replace('#', ''), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const css = (c: Rgb): string => `rgb(${c.map((v) => Math.round(Math.min(255, v))).join(', ')})`;

export function lightOverlayPanel(
  studio: Studio,
  notify: Notify,
): { el: HTMLElement; live(): void } {
  const el = h('div', { class: 'light-overlay', id: 'light-overlay' });
  const desk = desktopApi();
  const sourceSelect = h('select', {
    id: 'light-source',
    'aria-label': 'What to capture',
  }) as HTMLSelectElement;
  let sources: Array<{ id: string; name: string; kind: 'screen' | 'window' }> = [];
  // One listing at a time.
  let filling: Promise<void> | undefined;
  function fillSources(): Promise<void> {
    return (filling ??= fill().finally(() => (filling = undefined)));
  }
  async function fill(): Promise<void> {
    sources = (await desk?.captureSources?.()) ?? [];
    sourceSelect.replaceChildren(
      ...sources.map((s) =>
        h('option', { value: s.id }, `${s.kind === 'window' ? 'Window' : 'Screen'}: ${s.name}`),
      ),
    );
  }
  const swatchAvg = h('span', {
    class: 'light-swatch',
    id: 'light-average',
    title: 'The captured average',
  });
  const swatchOut = h('span', {
    class: 'light-swatch',
    id: 'light-color',
    title: 'The color on the model',
  });
  const status = h('p', { class: 'hint', id: 'light-status' });

  async function toggle(): Promise<void> {
    if (studio.lightOverlayOn) return studio.stopLightOverlay();
    let hint: { window: boolean } | undefined;
    if (desk?.captureSources) {
      const chosen = sources.find((s) => s.id === sourceSelect.value);
      hint = { window: chosen?.kind === 'window', ...(chosen ? { sourceId: chosen.id } : {}) };
    }
    try {
      await studio.startLightOverlay(hint);
    } catch (e) {
      notify(
        e instanceof Error && e.name === 'NotAllowedError'
          ? `The capture was not allowed, so the light overlay stays off (${(e as Error).message}).`
          : `The capture could not start: ${(e as Error).message}`,
        'error',
      );
    }
  }

  function slider(
    id: string,
    label: string,
    key: 'baseBrightness' | 'colorBoost' | 'smoothing',
    max: number,
    hint: string,
  ): HTMLElement {
    const v = studio.app.lightOverlay[key];
    const out = h('output', {}, String(v));
    return h(
      'label',
      { class: 'physics-slider' },
      label,
      h('input', {
        type: 'range',
        id,
        min: 0,
        max,
        step: 1,
        value: v,
        title: hint,
        oninput: (e: Event) => {
          const x = Number((e.target as HTMLInputElement).value);
          out.textContent = String(x);
          studio.setLightOverlaySettings({ [key]: x });
        },
      }),
      out,
    );
  }

  function refresh(): void {
    // The list again while it is empty (screens and windows come and go).
    if (desk?.captureSources && !sources.length) void fillSources();
    const s = studio.app.lightOverlay;
    const on = studio.lightOverlayOn;
    el.replaceChildren(
      h('h3', {}, 'Light from the screen'),
      h(
        'p',
        { class: 'hint' },
        'The colors of a screen or a window light the model, as a game or a video would light you. Only after you start it. The picture stays on this computer: Mochi Studio uses only the average colors of its left, middle and right thirds, and keeps, shows or sends no picture, not even to the bridge or OBS.',
      ),
      h(
        'div',
        { class: 'row' },
        desk?.captureSources ? h('label', {}, 'Capture', sourceSelect) : '',
        desk?.captureSources
          ? h(
              'button',
              {
                id: 'light-sources',
                title: 'List the screens and windows again',
                onclick: () => void fillSources(),
              },
              '↻',
            )
          : '',
        h(
          'button',
          { id: 'light-toggle', class: on ? 'on' : 'primary', onclick: () => void toggle() },
          on
            ? 'Stop the light'
            : desk?.captureSources
              ? 'Start the light'
              : 'Start: choose a screen or window…',
        ),
        swatchAvg,
        swatchOut,
      ),
      status,
      h(
        'div',
        { class: 'row' },
        h('span', {}, 'Parts'),
        ...CAPTURE_PARTS.map((p) =>
          h(
            'label',
            { class: 'check' },
            h('input', {
              type: 'checkbox',
              id: `light-part-${p}`,
              checked: s.parts[p],
              onchange: (e: Event) =>
                studio.setLightOverlaySettings({
                  parts: {
                    ...studio.app.lightOverlay.parts,
                    [p]: (e.target as HTMLInputElement).checked,
                  },
                }),
            }),
            PART_LABELS[p],
          ),
        ),
        h(
          'label',
          { class: 'check' },
          h('input', {
            type: 'checkbox',
            id: 'light-items',
            checked: s.items,
            onchange: (e: Event) =>
              studio.setLightOverlaySettings({ items: (e.target as HTMLInputElement).checked }),
          }),
          'Items too',
        ),
      ),
      slider(
        'light-base',
        'Base brightness',
        'baseBrightness',
        100,
        'Light added whatever the screen shows',
      ),
      slider(
        'light-boost',
        'Color boost',
        'colorBoost',
        100,
        '50 takes the colors as they are; 100 doubles them',
      ),
      slider(
        'light-smoothing',
        'Smoothing',
        'smoothing',
        60,
        'How slowly the light follows the screen (60: about two seconds)',
      ),
      // A static color instead of a capture, and the defaults again.
      h(
        'div',
        { class: 'row' },
        h(
          'label',
          {},
          'Static color',
          h('input', {
            type: 'color',
            id: 'light-static',
            value: toHex(s.staticColor),
            onchange: (e: Event) =>
              studio.setLightOverlaySettings({
                staticColor: fromHex((e.target as HTMLInputElement).value),
              }),
          }),
        ),
        h(
          'button',
          {
            id: 'light-static-on',
            title: 'Light the model with this color instead of a capture',
            onclick: () => studio.startStaticLight(),
          },
          'Use the static color',
        ),
        h(
          'button',
          {
            id: 'light-reset',
            title:
              'Brightness 15, overlay 40, smoothing 3, every part, items too, a white static color',
            onclick: () => studio.setLightOverlaySettings(defaultLightOverlay()),
          },
          'Reset',
        ),
      ),
      h(
        'p',
        { class: 'hint' },
        'The light can brighten the model up to 1.8 times its own colors (never past white), and darken it down to black.',
      ),
    );
    live();
  }

  function live(): void {
    const st = studio.lightOverlay;
    swatchAvg.style.background = st ? css(st.average) : 'transparent';
    swatchOut.style.background = st ? css(st.overlay) : 'transparent';
    status.textContent = studio.lightOverlayOn
      ? st
        ? `On: ${studio.lightOverlaySource === 'static' ? 'the static color' : st.isWindowCapture ? 'a window' : 'a screen'}; average ${st.average.map((v) => Math.round(v)).join(', ')}, light ${st.overlay.map((v) => Math.round(v)).join(', ')}.`
        : 'On: waiting for the first picture…'
      : 'Off.';
  }

  studio.events.on('lightOverlayChanged', refresh);
  studio.events.on('appSettingsChanged', () => {
    // Sliders being dragged keep their place; the rest follows.
    if (!el.contains(document.activeElement) || document.activeElement?.tagName !== 'INPUT')
      refresh();
  });
  refresh();
  return { el, live };
}
