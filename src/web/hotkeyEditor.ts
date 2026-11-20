import {
  ChordTracker,
  MOUSE_BUTTONS,
  comboFromMouse,
  comboLabel,
  comboParts,
  type Hotkey,
  type HotkeyAction,
  importedGestureNames,
  comboFromLeftClick,
  CLICK_SLOP_PX,
} from '../core/hotkeys';
import { MAX_SCENE_FADE_S, MAX_SCENE_SECONDS } from '../core/itemScenes';
import {
  DEFAULT_GESTURE_HOLD,
  GESTURE_LABELS,
  GESTURES,
  MAX_GESTURE_HOLD,
  parseGestureTrigger,
  POSE_LABELS,
  TWO_HAND_POSES,
  type Gesture,
  type GestureTrigger,
  type TwoHandPose,
} from '../core/gestures';
import { h, select } from './dom';
import type { Studio } from './studio';

let capturing: ((combo: string | undefined) => void) | undefined;

/** True while a "press a key" capture is active (global hotkeys pause). */
export function isCapturing(): boolean {
  return !!capturing;
}

export function hotkeyEditor(studio: Studio): { el: HTMLElement; refresh(): void } {
  const el = h('div', { class: 'hotkeys' });

  const update = (id: string, patch: Partial<Hotkey>): void => {
    const s = studio.settings;
    if (!s) return;
    studio.updateSettings({
      hotkeys: s.hotkeys.map((x) => (x.id === id ? { ...x, ...patch } : x)),
    });
  };

  function defaultAction(type: HotkeyAction['type']): HotkeyAction {
    const m = studio.model?.manifest;
    if (type === 'expression') return { type, expression: m?.expressions[0]?.name ?? '' };
    if (type === 'motion') {
      const mo = m?.motions[0];
      return { type, motion: { group: mo?.group ?? '', index: mo?.index ?? 0 }, mode: 'once' };
    }
    if (type === 'clearExpressions' || type === 'calibrate') return { type };
    if (type === 'screenOverlay') return { type, overlay: studio.recordScreenOverlay() };
    if (type === 'itemScene')
      return { type, scene: studio.settings?.itemScenes[0]?.id ?? '', fade: 0.5 };
    return { type: 'item', item: studio.items[0]?.id ?? '' };
  }

  function targetControl(hk: Hotkey): HTMLElement {
    const a = hk.action;
    const m = studio.model?.manifest;
    if (a.type === 'expression')
      return select(
        (m?.expressions ?? []).map((e) => [e.name, e.name] as const),
        a.expression,
        (v) => update(hk.id, { action: { ...a, expression: v } }),
        'Expression',
      );
    if (a.type === 'motion') {
      const opts = (m?.motions ?? []).map(
        (x) => [`${x.group}\u0000${x.index}`, x.group ? `${x.group} / ${x.name}` : x.name] as const,
      );
      return h(
        'span',
        { class: 'row' },
        select(
          opts,
          `${a.motion.group}\u0000${a.motion.index}`,
          (v) => {
            const [group = '', index = '0'] = v.split('\u0000');
            update(hk.id, { action: { ...a, motion: { group, index: Number(index) } } });
          },
          'Animation',
        ),
        select(
          [
            ['once', 'Play once'],
            ['hold', 'Hold last frame'],
          ] as const,
          a.mode,
          (v) => update(hk.id, { action: { ...a, mode: v } }),
          'Animation mode',
        ),
      );
    }
    if (a.type === 'clearExpressions' || a.type === 'calibrate') return h('span');
    if (a.type === 'itemScene') {
      const scenes = studio.settings?.itemScenes ?? [];
      if (!scenes.length)
        return h('span', { class: 'hint' }, 'Make an item scene in the Items sheet first.');
      return h(
        'span',
        { class: 'row' },
        select(
          scenes.map((x) => [x.id, x.group ? `${x.name} (${x.group})` : x.name] as const),
          a.scene,
          (v) => update(hk.id, { action: { ...a, scene: v } }),
          'Item scene',
        ),
        h(
          'label',
          {},
          'Fade (s)',
          h('input', {
            type: 'number',
            class: 'scene-fade',
            min: 0,
            max: MAX_SCENE_FADE_S,
            step: 0.1,
            value: a.fade,
            'aria-label': 'Fade in seconds',
            onchange: (e: Event) => {
              const v = Number((e.target as HTMLInputElement).value);
              update(hk.id, {
                action: {
                  ...a,
                  fade: Number.isFinite(v) ? Math.max(0, Math.min(MAX_SCENE_FADE_S, v)) : 0,
                },
              });
            },
          }),
        ),
      );
    }
    if (a.type === 'screenOverlay') {
      // The light's settings, recorded from the Camera tab.
      const o = a.overlay;
      const what = !o.on
        ? 'Turns the light off'
        : o.source === 'static'
          ? `The static color ${o.settings.staticColor.join(', ')}`
          : 'A capture (started in the Camera tab)';
      return h(
        'span',
        { class: 'row' },
        h(
          'span',
          { class: 'hint screen-overlay-summary' },
          `${what}; brightness ${o.settings.baseBrightness}, overlay ${o.settings.colorBoost}, smoothing ${o.settings.smoothing}`,
        ),
        h(
          'button',
          {
            class: 'screen-overlay-record',
            title:
              'Takes the light’s current settings: on or off, its source, and the panel’s values',
            onclick: () =>
              update(hk.id, {
                action: { type: 'screenOverlay', overlay: studio.recordScreenOverlay() },
              }),
          },
          'Record settings',
        ),
      );
    }
    const items = studio.items;
    return items.length
      ? select(
          items.map((i) => [i.id, i.label] as const),
          a.item,
          (v) => update(hk.id, { action: { ...a, item: v } }),
          'Item',
        )
      : h('span', { class: 'hint' }, 'Add an item in the Items tab first.');
  }

  /** A hand gesture that also fires the hotkey: per hand, or a two-hand pose. */
  function gestureControl(hk: Hotkey): HTMLElement {
    const g = hk.gesture;
    const set = (patch: Partial<GestureTrigger> | undefined): void => {
      if (!patch) return update(hk.id, { gesture: undefined });
      const next = parseGestureTrigger({
        combine: 'and',
        mirrored: false,
        hold: DEFAULT_GESTURE_HOLD,
        ...g,
        ...patch,
      });
      update(hk.id, { gesture: next });
    };
    const gestureSelect = (side: 'left' | 'right') =>
      select(
        [['', 'None'], ...GESTURES.map((x) => [x, GESTURE_LABELS[x]] as const)] as const,
        g?.[side] ?? '',
        (v) => {
          const next = { ...g, [side]: (v || undefined) as Gesture | undefined, pose: undefined };
          set(next.left || next.right ? next : undefined);
        },
        side === 'left' ? 'Left hand' : 'Right hand',
      );
    const summary = !g
      ? 'Gesture: none'
      : g.pose
        ? `Gesture: ${POSE_LABELS[g.pose]}`
        : `Gesture: ${[
            g.left ? `left ${GESTURE_LABELS[g.left]}` : '',
            g.right ? `right ${GESTURE_LABELS[g.right]}` : '',
          ]
            .filter(Boolean)
            .join(g.combine === 'or' ? ' or ' : ' and ')}`;
    // An imported file's gesture settings: kept as they are, never used.
    const imported = importedGestureNames(hk.importedGesture);
    return h(
      'details',
      { class: 'hotkey-gesture' },
      h('summary', {}, summary),
      imported.length
        ? h(
            'p',
            { class: 'hint imported-gesture' },
            `The imported settings file gives this hotkey the gesture ${imported.map((n) => `“${n}”`).join(' and ')}. It is kept with the hotkey as it is, but not used: the file's gesture names are not known yet. Set a gesture of Mochi Studio's below instead.`,
          )
        : '',
      h(
        'div',
        { class: 'row' },
        h('label', {}, 'Your left hand', gestureSelect('left')),
        h('label', {}, 'Your right hand', gestureSelect('right')),
        select(
          [
            ['and', 'Both (AND)'],
            ['or', 'Either (OR)'],
          ] as const,
          g?.combine ?? 'and',
          (v) => g && set({ combine: v }),
          'Combine',
        ),
      ),
      h(
        'div',
        { class: 'row' },
        h(
          'label',
          {},
          'Or both hands',
          select(
            [['', 'None'], ...TWO_HAND_POSES.map((x) => [x, POSE_LABELS[x]] as const)] as const,
            g?.pose ?? '',
            (v) =>
              v
                ? set({ pose: v as TwoHandPose, left: undefined, right: undefined })
                : set(undefined),
            'Two-hand pose',
          ),
        ),
        h(
          'label',
          { class: 'check' },
          h('input', {
            type: 'checkbox',
            class: 'gesture-mirrored',
            checked: g?.mirrored ?? false,
            disabled: !g,
            onchange: (e: Event) => set({ mirrored: (e.target as HTMLInputElement).checked }),
          }),
          'Either hand (mirrored)',
        ),
        h(
          'label',
          {},
          'Hold (s)',
          h('input', {
            type: 'number',
            class: 'gesture-hold',
            min: 0,
            max: MAX_GESTURE_HOLD,
            step: 0.1,
            value: g?.hold ?? DEFAULT_GESTURE_HOLD,
            disabled: !g,
            onchange: (e: Event) => set({ hold: Number((e.target as HTMLInputElement).value) }),
          }),
        ),
      ),
    );
  }

  /** For expression, item and item scene hotkeys: how they turn off again. */
  function releaseControl(hk: Hotkey): HTMLElement | string {
    const t = hk.action.type;
    if (t !== 'expression' && t !== 'item' && t !== 'itemScene') return '';
    const release = hk.release ?? 'toggle';
    // An item scene can switch itself off after up to an hour.
    const most = t === 'itemScene' ? MAX_SCENE_SECONDS : 3600;
    return h(
      'span',
      { class: 'row' },
      select(
        [
          ['toggle', 'Press: on / off'],
          ['hold', 'On while held'],
          ['timer', 'On for some seconds'],
        ] as const,
        release,
        (v) =>
          update(hk.id, {
            release: v === 'toggle' ? undefined : v,
            seconds: v === 'timer' ? (hk.seconds ?? 5) : undefined,
          }),
        'Turns off',
      ),
      release === 'timer'
        ? h('input', {
            type: 'number',
            min: 0.1,
            max: most,
            step: 0.5,
            value: hk.seconds ?? 5,
            'aria-label': 'Seconds',
            class: 'seconds',
            onchange: (e: Event) =>
              update(hk.id, {
                seconds: Math.min(
                  most,
                  Math.max(0.1, Number((e.target as HTMLInputElement).value) || 5),
                ),
              }),
          })
        : '',
    );
  }

  function refresh(): void {
    el.replaceChildren();
    const s = studio.settings;
    if (!s) {
      el.append(h('p', { class: 'hint' }, 'Load a model to set up hotkeys.'));
      return;
    }
    const rows = s.hotkeys.map((hk) => {
      const keyBtn = h(
        'button',
        {
          class: 'keycap',
          title:
            'Click, then press up to two keys together (with Ctrl, Alt, Shift if you like), a mouse button (the left one with a modifier, such as Alt+click), or a controller button or stick direction. Esc clears.',
        },
        hk.keys ? comboLabel(hk.keys) : 'Set key',
      );
      keyBtn.addEventListener('click', () => {
        keyBtn.textContent = 'Press keys, a mouse button or a controller button…';
        keyBtn.classList.add('capturing');
        capturing = (combo) => {
          capturing = undefined;
          update(hk.id, { keys: combo ?? '' });
        };
      });
      return h(
        'div',
        { class: 'hotkey', 'data-hotkey': hk.id },
        h('input', {
          value: hk.label,
          placeholder: 'Label',
          'aria-label': 'Label',
          onchange: (e: Event) => update(hk.id, { label: (e.target as HTMLInputElement).value }),
        }),
        keyBtn,
        select(
          [
            ['expression', 'Expression (toggle)'],
            ['motion', 'Play animation'],
            ['item', 'Item (show/hide)'],
            ['itemScene', 'Toggle item scene'],
            ['clearExpressions', 'All expressions off'],
            ['calibrate', 'Calibrate'],
            ['screenOverlay', 'Screen overlay (the light)'],
          ] as const,
          hk.action.type,
          (v) => update(hk.id, { action: defaultAction(v) }),
          'Action',
        ),
        h('span', { class: 'row' }, targetControl(hk)),
        releaseControl(hk),
        gestureControl(hk),
        h(
          'label',
          {},
          h('input', {
            type: 'checkbox',
            checked: hk.button,
            onchange: (e: Event) =>
              update(hk.id, { button: (e.target as HTMLInputElement).checked }),
          }),
          'Button',
        ),
        h(
          'button',
          {
            class: 'icon danger',
            'aria-label': 'Remove hotkey',
            title: 'Remove hotkey',
            onclick: () =>
              studio.updateSettings({ hotkeys: s.hotkeys.filter((x) => x.id !== hk.id) }),
          },
          '✕',
        ),
      );
    });
    el.append(
      h(
        'div',
        { class: 'row' },
        h(
          'button',
          {
            onclick: () => {
              const type: HotkeyAction['type'] = studio.model?.manifest.expressions.length
                ? 'expression'
                : 'motion';
              studio.updateSettings({
                hotkeys: [
                  ...s.hotkeys,
                  {
                    id: `h${Date.now().toString(36)}`,
                    label: '',
                    keys: '',
                    button: true,
                    action: defaultAction(type),
                  },
                ],
              });
            },
          },
          'Add hotkey',
        ),
      ),
      rows.length
        ? h('div', { class: 'list' }, rows)
        : h('p', { class: 'hint' }, 'No hotkeys yet.'),
    );
  }

  refresh();
  return { el, refresh };
}

/** Global key handling: capture for the editor, otherwise fire hotkeys. */
/**
 * The window's own key handler. `isGlobal` names hotkeys the desktop app has
 * registered with the system: those fire from there, not twice.
 */
export function installKeyHandler(
  studio: Studio,
  isGlobal: (id: string) => boolean = () => false,
): void {
  const chords = new ChordTracker();
  /** While capturing: the largest chord held since the first key went down. */
  let captured: string | undefined;
  const releaseAll = (): void => {
    chords.clear();
    for (const id of [...studio.heldHotkeys]) studio.releaseHotkey(id);
  };
  addEventListener('blur', releaseAll);
  addEventListener('keydown', (e) => {
    if (capturing) {
      e.preventDefault();
      if (e.code === 'Escape') {
        chords.clear();
        captured = undefined;
        return capturing(undefined);
      }
      const c = chords.down(e);
      if (c && (!captured || c.split('+').length >= captured.split('+').length)) captured = c;
      return;
    }
    const t = e.target as HTMLElement | null;
    const typing =
      t &&
      (t.tagName === 'INPUT' ||
        t.tagName === 'TEXTAREA' ||
        t.tagName === 'SELECT' ||
        t.isContentEditable);
    const combo = chords.down(e);
    if (typing || e.repeat || !combo) return;
    const matches =
      studio.settings?.hotkeys.filter((x) => x.keys === combo && !isGlobal(x.id)) ?? [];
    if (!matches.length) return;
    e.preventDefault();
    for (const m of matches) void studio.run('fire_hotkey', { id: m.id }).catch(() => undefined);
  });
  // Controller buttons and stick directions, alone or with keys held. The
  // studio reads the controllers each frame, so they work whichever window has focus.
  const mods = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };
  const trackMods = (e: KeyboardEvent): void => {
    mods.ctrlKey = e.ctrlKey;
    mods.altKey = e.altKey;
    mods.shiftKey = e.shiftKey;
    mods.metaKey = e.metaKey;
  };
  addEventListener('keydown', trackMods, { capture: true });
  addEventListener('keyup', trackMods, { capture: true });
  studio.events.on('padTrigger', ({ code, down }) => {
    const e = { code, ...mods };
    if (down) {
      const c = chords.down(e);
      if (capturing) {
        if (c && (!captured || c.split('+').length >= captured.split('+').length)) captured = c;
        return;
      }
      const matches = c ? (studio.settings?.hotkeys.filter((x) => x.keys === c) ?? []) : [];
      for (const m of matches) void studio.run('fire_hotkey', { id: m.id }).catch(() => undefined);
      return;
    }
    chords.up(e);
    if (capturing) {
      if (chords.size === 0 && captured) {
        const c = captured;
        captured = undefined;
        capturing(c);
      }
      return;
    }
    for (const id of [...studio.heldHotkeys]) {
      const h = studio.settings?.hotkeys.find((x) => x.id === id);
      if (h && comboParts(h.keys).includes(code))
        void studio.run('release_hotkey', { id }).catch(() => undefined);
    }
  });
  // The left button with a modifier (Alt+click and the like): a click only, on
  // release, so a drag of the model never counts and a plain click never does.
  let leftDown: { x: number; y: number; combo: string } | undefined;
  // Pointer events: the stage cancels its pointer's default, which stops mouse events.
  addEventListener(
    'pointerdown',
    (e) => {
      if (e.button !== 0 || !e.isPrimary) return;
      const combo = comboFromLeftClick(e);
      leftDown = combo ? { x: e.clientX, y: e.clientY, combo } : undefined;
    },
    { capture: true },
  );
  addEventListener(
    'pointerup',
    (e) => {
      if (e.button !== 0 || !e.isPrimary || !leftDown) return;
      const { x, y, combo } = leftDown;
      leftDown = undefined;
      if (Math.hypot(e.clientX - x, e.clientY - y) > CLICK_SLOP_PX) return;
      if (capturing) {
        e.preventDefault();
        chords.clear();
        captured = undefined;
        return capturing(combo);
      }
      const matches = studio.settings?.hotkeys.filter((h) => h.keys === combo) ?? [];
      for (const m of matches) {
        void studio.run('fire_hotkey', { id: m.id }).catch(() => undefined);
        // A click has no "while held": a hold hotkey lets go at once.
        if (studio.heldHotkeys.has(m.id))
          void studio.run('release_hotkey', { id: m.id }).catch(() => undefined);
      }
    },
    { capture: true },
  );
  // Mouse buttons (not the left one) as hotkeys, in this window.
  addEventListener(
    'mousedown',
    (e) => {
      const combo = comboFromMouse(e);
      if (!combo) return;
      if (capturing) {
        e.preventDefault();
        e.stopPropagation();
        chords.clear();
        captured = undefined;
        return capturing(combo);
      }
      const matches = studio.settings?.hotkeys.filter((x) => x.keys === combo) ?? [];
      if (!matches.length) return;
      e.preventDefault();
      for (const m of matches) void studio.run('fire_hotkey', { id: m.id }).catch(() => undefined);
    },
    { capture: true },
  );
  addEventListener('mouseup', (e) => {
    const code = MOUSE_BUTTONS[e.button];
    if (!code) return;
    for (const id of [...studio.heldHotkeys]) {
      const h = studio.settings?.hotkeys.find((x) => x.id === id);
      if (h && comboParts(h.keys).includes(code))
        void studio.run('release_hotkey', { id }).catch(() => undefined);
    }
  });
  // A right button that is a hotkey opens no context menu.
  addEventListener('contextmenu', (e) => {
    if (
      capturing ||
      studio.settings?.hotkeys.some((x) => comboParts(x.keys).includes('MouseRight'))
    )
      e.preventDefault();
  });
  addEventListener('keyup', (e) => {
    const part = chords.up(e);
    if (capturing) {
      if (chords.size === 0 && captured) {
        const c = captured;
        captured = undefined;
        capturing(c);
      }
      return;
    }
    if (!part) return;
    for (const id of [...studio.heldHotkeys]) {
      const h = studio.settings?.hotkeys.find((x) => x.id === id);
      if (h && comboParts(h.keys).includes(part))
        void studio.run('release_hotkey', { id }).catch(() => undefined);
    }
  });
}
