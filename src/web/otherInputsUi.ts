/**
 * The Camera tab's mouse and controller section: the mouse
 * inputs' X and Y ranges, and which controllers are read. Both are
 * app-wide.
 */
import { ALL_CONTROLLERS, NO_CONTROLLER } from '../core/controller';
import { MAX_MOUSE_RANGE } from '../core/mouseInput';
import { h, select } from './dom';
import type { Studio } from './studio';

export function otherInputsPanel(studio: Studio): { el: HTMLElement; refresh(): void } {
  const el = h('div', { class: 'other-inputs', id: 'other-inputs' });
  const screenSelect = h('select', {
    id: 'mouse-screen',
    'aria-label': 'Screen',
    onchange: (e: Event) => {
      const v = (e.target as HTMLSelectElement).value;
      studio.setMouseScreen(v === 'main' ? undefined : Number(v));
    },
  }) as HTMLSelectElement;
  /** Fills the screen choice from the desktop app's list (it can change as screens come and go). */
  async function fillScreens(): Promise<void> {
    const list = await studio.screens();
    const chosen = studio.app.mouseScreen;
    screenSelect.replaceChildren(
      h('option', { value: 'main', selected: chosen === undefined }, 'The main screen'),
      ...list.map((d) =>
        h(
          'option',
          { value: String(d.id), selected: d.id === chosen },
          `${d.label} (${d.bounds.width}×${d.bounds.height}${d.primary ? ', main' : ''})`,
        ),
      ),
      ...(chosen !== undefined && !list.some((d) => d.id === chosen)
        ? [h('option', { value: String(chosen), selected: true }, 'A screen not connected now')]
        : []),
    );
  }

  function refresh(): void {
    const app = studio.app;
    const where = 'page';
    const range = (axis: 'width' | 'height', id: string, label: string): HTMLElement =>
      h(
        'label',
        {},
        label,
        h('input', {
          type: 'number',
          id,
          min: 0,
          max: MAX_MOUSE_RANGE,
          step: 10,
          value: app.mouseRange[axis],
          onchange: (e: Event) => {
            const v = Number((e.target as HTMLInputElement).value);
            studio.setMouseRange({ ...studio.app.mouseRange, [axis]: Number.isFinite(v) ? v : 0 });
          },
        }),
      );
    const names = studio.controllers;
    const chosen = app.controller;
    const options: Array<readonly [string, string]> = [
      [NO_CONTROLLER, 'No controller'],
      [ALL_CONTROLLERS, 'All controllers'],
      ...names.map((n) => [n, n] as const),
      ...(chosen !== NO_CONTROLLER && chosen !== ALL_CONTROLLERS && !names.includes(chosen)
        ? [[chosen, `${chosen} (not connected)`] as const]
        : []),
    ];
    const choice = select(options, chosen, (v) => studio.setController(v), 'Controller');
    choice.id = 'controller-choice';
    // Desktop app: which screen the ranges are centred on.
    const screenChoice =
      studio.pointerScope === 'screen'
        ? h('label', { id: 'mouse-screen-label' }, 'Screen', screenSelect)
        : '';
    el.replaceChildren(
      h('h3', {}, 'Mouse and controller'),
      h(
        'p',
        { class: 'hint' },
        'Mappings can use the mouse pointer (MousePositionX and MousePositionY, −1 to 1) and a game controller’s sticks, buttons and triggers (the Controller… inputs). Controller buttons and stick directions can also be a hotkey’s keys.',
      ),
      h(
        'div',
        { class: 'row' },
        range('width', 'mouse-range-x', 'Pointer range X (px)'),
        range('height', 'mouse-range-y', 'Y (px)'),
        screenChoice,
      ),
      h(
        'p',
        { class: 'hint', id: 'mouse-range-hint' },
        `Around the middle of the ${studio.pointerScope === 'screen' ? 'screen chosen' : where}; 0 is the whole ${studio.pointerScope === 'screen' ? 'screen' : where}. X is positive to the right, Y upwards, and both stay at −1 or 1 beyond the range.${studio.pointerScope === 'page' ? ' In a browser the pointer counts only over this page; the desktop app follows it anywhere on the screen.' : ''}`,
      ),
      h(
        'div',
        { class: 'row' },
        h('label', {}, 'Controller', choice),
        h(
          'button',
          {
            id: 'controller-reset-orientation',
            title:
              'For controllers whose orientation the browser gives: the way it points now becomes straight ahead',
            onclick: () => studio.resetControllerOrientation(),
          },
          'Reset orientation',
        ),
      ),
      h(
        'p',
        { class: 'hint', id: 'controller-status' },
        names.length
          ? `${names.length === 1 ? 'One controller' : `${names.length} controllers`} connected.`
          : 'No controller seen yet: connect one and press one of its buttons, so the browser shows it.',
      ),
    );
  }

  studio.events.on('controllersChanged', refresh);
  studio.events.on('appSettingsChanged', () => {
    refresh();
    if (studio.pointerScope === 'screen') void fillScreens();
  });
  refresh();
  if (studio.pointerScope === 'screen') void fillScreens();
  return { el, refresh };
}
