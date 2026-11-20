import type { GestureTrigger } from './gestures';
import type { ScreenOverlayAction } from './lightOverlay';
import { isPadCode, padLabel } from './controller';

/** A reference to a motion of the loaded model: its group and index in that group. */
export interface MotionRef {
  group: string;
  index: number;
}

export type HotkeyAction =
  | { type: 'expression'; expression: string }
  | { type: 'motion'; motion: MotionRef; mode: 'once' | 'hold' }
  | { type: 'item'; item: string }
  /** Turns every expression off. */
  | { type: 'clearExpressions' }
  /** Starts the neutral-pose calibration. */
  | { type: 'calibrate' }
  /** Turns an item scene on or off (src/core/itemScenes.ts), fading its items over `fade` seconds. */
  | { type: 'itemScene'; scene: string; fade: number }
  /** Applies recorded light overlay settings: off, the static color or a capture. */
  | { type: 'screenOverlay'; overlay: ScreenOverlayAction };

/** How an expression or item hotkey turns off again. */
export type HotkeyRelease =
  /** Each press turns it on or off. */
  | 'toggle'
  /** On while the keys (or the button) are held, off when released. */
  | 'hold'
  /** On when pressed; off by itself after `seconds` (a press while on turns it off). */
  | 'timer';

export interface Hotkey {
  id: string;
  label: string;
  /**
   * Normalised key combination: up to two keys held together, plus modifiers
   * first (`Ctrl+Shift+Digit1`, `KeyQ+KeyW`); empty = button only.
   */
  keys: string;
  /** Show an on-screen button for touch input. */
  button: boolean;
  /** A hand gesture that also fires it (src/core/gestures.ts). */
  gesture?: GestureTrigger;
  /**
   * An imported file's `HandGestureSettings`, kept
   * verbatim and written back unchanged with the settings. Never used: the
   * file's gesture names are not known, so it fires nothing.
   */
  importedGesture?: Record<string, unknown>;
  action: HotkeyAction;
  /** For expression, item and item scene hotkeys. Default `toggle`. */
  release?: HotkeyRelease;
  /** For `timer`: seconds until it turns off. */
  seconds?: number;
}

const MODIFIERS = ['Ctrl', 'Alt', 'Shift', 'Meta'] as const;
/** The most keys a chord may have, besides modifiers (the familiar limit). */
export const MAX_CHORD_KEYS = 2;

/** Mouse buttons that can be hotkeys (the left button stays for clicking). */
export const MOUSE_BUTTONS: Record<number, string> = {
  1: 'MouseMiddle',
  2: 'MouseRight',
  3: 'MouseBack',
  4: 'MouseForward',
};
/**
 * The left button: only with a modifier (Alt+click and the
 * like), never a plain click, and only a click, never a drag of the model.
 */
export const MOUSE_LEFT = 'MouseLeft';
/** How far the pointer may move between press and release for a left click to count. */
export const CLICK_SLOP_PX = 4;
const MOUSE_LABELS: Record<string, string> = {
  MouseLeft: 'Left click',
  MouseMiddle: 'Middle mouse button',
  MouseRight: 'Right mouse button',
  MouseBack: 'Mouse back button',
  MouseForward: 'Mouse forward button',
};
export const isMouseCombo = (combo: string): boolean => /(^|\+)Mouse[A-Z]/.test(combo);
/** A combination with a controller button or stick direction (src/core/controller.ts). */
export const isPadCombo = (combo: string): boolean => comboParts(combo).some(isPadCode);

export interface KeyLike {
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

const MODIFIER_CODES: Record<string, (typeof MODIFIERS)[number]> = {
  ControlLeft: 'Ctrl',
  ControlRight: 'Ctrl',
  AltLeft: 'Alt',
  AltRight: 'Alt',
  ShiftLeft: 'Shift',
  ShiftRight: 'Shift',
  MetaLeft: 'Meta',
  MetaRight: 'Meta',
};

/** Builds a normalised combination from modifier names and other key codes. */
function joinCombo(mods: Iterable<string>, keys: Iterable<string>): string | undefined {
  const m = new Set(mods);
  const k = [...new Set(keys)].sort();
  const parts = [...MODIFIERS.filter((x) => m.has(x)), ...k];
  if (!k.length || k.length > MAX_CHORD_KEYS) return undefined;
  return parts.join('+');
}

/**
 * Normalises a keyboard event into a combination string (one key and the
 * held modifiers). Uses `code` (the physical key), so combinations work the
 * same with any keyboard layout. Returns undefined for a lone modifier.
 */
export function comboFromEvent(e: KeyLike): string | undefined {
  if (MODIFIER_CODES[e.code] || !e.code) return undefined;
  return joinCombo(modsOf(e), [e.code]);
}

/** A mouse button with the held modifiers, or undefined for the left button. */
export function comboFromMouse(e: Omit<KeyLike, 'code'> & { button: number }): string | undefined {
  const code = MOUSE_BUTTONS[e.button];
  return code ? joinCombo(modsOf(withCode(e, code)), [code]) : undefined;
}

/**
 * A left click with the held modifiers (`Alt+MouseLeft`), or undefined for a
 * plain click: the left button counts only with a modifier.
 */
export function comboFromLeftClick(e: Omit<KeyLike, 'code'>): string | undefined {
  const mods = modsOf(withCode(e, MOUSE_LEFT));
  return mods.length ? joinCombo(mods, [MOUSE_LEFT]) : undefined;
}

/** Whether a combination is a left click with modifiers, and nothing else (no other key). */
export function isLeftClickCombo(combo: string): boolean {
  const parts = comboParts(combo);
  return parts.includes(MOUSE_LEFT) && parts.every((p) => p === MOUSE_LEFT || isModifier(p));
}
const isModifier = (p: string): boolean => (MODIFIERS as readonly string[]).includes(p);

/**
 * The modifier flags of an event, with a code. (A DOM event's flags are
 * getters on its prototype, so spreading the event would drop them.)
 */
const withCode = (e: Omit<KeyLike, 'code'>, code: string): KeyLike => ({
  code,
  ctrlKey: e.ctrlKey,
  altKey: e.altKey,
  shiftKey: e.shiftKey,
  metaKey: e.metaKey,
});

function modsOf(e: KeyLike): string[] {
  const mods: string[] = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Meta');
  return mods;
}

/**
 * Parses and re-normalises a user-written combination
 * (`shift+ctrl+KeyA` -> `Ctrl+Shift+KeyA`, `KeyW+KeyQ` -> `KeyQ+KeyW`).
 */
export function normalizeCombo(s: string): string | undefined {
  const parts = s
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return undefined;
  const mods: string[] = [];
  const keys: string[] = [];
  for (const p of parts) {
    const m = MODIFIERS.find((x) => x.toLowerCase() === p.toLowerCase());
    if (m) mods.push(m);
    else keys.push(p);
  }
  return joinCombo(mods, keys);
}

/** The keys of a combination: modifier names and key codes. */
export function comboParts(combo: string): string[] {
  return combo ? combo.split('+') : [];
}

/**
 * Follows which keys are held, so chords (keys held together) can be
 * matched. `down` returns the chord now held; `up` returns the parts that
 * were released, so "while held" hotkeys can turn off.
 */
export class ChordTracker {
  private held = new Set<string>();

  down(e: KeyLike): string | undefined {
    if (!e.code) return undefined;
    if (!MODIFIER_CODES[e.code]) this.held.add(e.code);
    return this.held.size ? joinCombo(modsOf(e), this.held) : undefined;
  }

  /** @returns the part released: a key code or a modifier name */
  up(e: KeyLike): string | undefined {
    const mod = MODIFIER_CODES[e.code];
    if (mod) return mod;
    this.held.delete(e.code);
    return e.code;
  }

  /** Forgets every held key (for example when the window loses focus). */
  clear(): void {
    this.held.clear();
  }
  get size(): number {
    return this.held.size;
  }
}

/** A readable label: `Ctrl+Shift+Digit1` -> `Ctrl+Shift+1`. */
export function comboLabel(combo: string): string {
  return combo
    .split('+')
    .map((p) =>
      p
        .replace(/^Key([A-Z])$/, '$1')
        .replace(/^Digit(\d)$/, '$1')
        .replace(/^Numpad(\d)$/, 'Num$1')
        .replace(/^Mouse[A-Za-z]+$/, (m) => MOUSE_LABELS[m] ?? m)
        .replace(/^Pad[A-Za-z0-9]+$/, (m) => (isPadCode(m) ? padLabel(m) : m)),
    )
    .join('+');
}

export function findHotkeys(hotkeys: readonly Hotkey[], combo: string): Hotkey[] {
  return hotkeys.filter((h) => h.keys && h.keys === combo);
}

/** Where hotkey actions go. Implemented by the app on top of the avatar runtime. */
export interface HotkeyTarget {
  setExpression(name: string, on: boolean): void;
  playMotion(ref: MotionRef, mode: 'once' | 'hold'): void;
  setItemVisible(item: string, visible: boolean): void;
  isItemVisible(item: string): boolean;
  /** Turns an item scene on or off, fading over `fade` seconds. */
  setItemScene(scene: string, on: boolean, fade: number): void;
  isItemSceneOn(scene: string): boolean;
  calibrate(): void;
  /** A «Screen Overlay» hotkey's settings (src/core/lightOverlay.ts). */
  applyScreenOverlay(a: ScreenOverlayAction): void;
}

/** Actions that are on or off: expressions, items and item scenes. */
type Switchable = Extract<HotkeyAction, { type: 'expression' | 'item' | 'itemScene' }>;
const switchable = (a: HotkeyAction): a is Switchable =>
  a.type === 'expression' || a.type === 'item' || a.type === 'itemScene';

/** Schedules a call; returns a function that cancels it. */
export type Scheduler = (fn: () => void, ms: number) => () => void;
const defaultScheduler: Scheduler = (fn, ms) => {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
};

/** Keeps toggle state for expressions and items and dispatches hotkeys. */
export class HotkeyController {
  readonly activeExpressions = new Set<string>();
  private timers = new Map<string, () => void>();
  private held = new Set<string>();

  constructor(
    private target: HotkeyTarget,
    private schedule: Scheduler = defaultScheduler,
  ) {}

  private isOn(a: HotkeyAction): boolean {
    if (a.type === 'expression') return this.activeExpressions.has(a.expression);
    if (a.type === 'item') return this.target.isItemVisible(a.item);
    if (a.type === 'itemScene') return this.target.isItemSceneOn(a.scene);
    return false;
  }

  private set(a: HotkeyAction, on: boolean): void {
    if (a.type === 'expression') {
      if (on) this.activeExpressions.add(a.expression);
      else this.activeExpressions.delete(a.expression);
      this.target.setExpression(a.expression, on);
    } else if (a.type === 'item') this.target.setItemVisible(a.item, on);
    else if (a.type === 'itemScene') this.target.setItemScene(a.scene, on, a.fade);
  }

  /** A press of the hotkey's keys or button. */
  fire(h: Hotkey): void {
    const a = h.action;
    switch (a.type) {
      case 'expression':
      case 'item':
      case 'itemScene': {
        const release = h.release ?? 'toggle';
        if (release === 'hold') {
          this.held.add(h.id);
          if (!this.isOn(a)) this.set(a, true);
          return;
        }
        this.timers.get(h.id)?.();
        this.timers.delete(h.id);
        const on = !this.isOn(a);
        this.set(a, on);
        if (on && release === 'timer') {
          const ms = Math.max(0, h.seconds ?? 5) * 1000;
          this.timers.set(
            h.id,
            this.schedule(() => {
              this.timers.delete(h.id);
              if (this.isOn(a)) this.set(a, false);
            }, ms),
          );
        }
        break;
      }
      case 'motion':
        this.target.playMotion(a.motion, a.mode);
        break;
      case 'clearExpressions':
        for (const e of [...this.activeExpressions]) {
          this.activeExpressions.delete(e);
          this.target.setExpression(e, false);
        }
        break;
      case 'calibrate':
        this.target.calibrate();
        break;
      case 'screenOverlay':
        this.target.applyScreenOverlay(a.overlay);
        break;
    }
  }

  /** The hotkey's keys or button were released: "while held" hotkeys turn off. */
  release(h: Hotkey): void {
    if (!this.held.delete(h.id)) return;
    if (switchable(h.action) && this.isOn(h.action)) this.set(h.action, false);
  }

  /** Ids of "while held" hotkeys that are down. */
  get heldHotkeys(): ReadonlySet<string> {
    return this.held;
  }

  reset(): void {
    this.activeExpressions.clear();
    for (const cancel of this.timers.values()) cancel();
    this.timers.clear();
    this.held.clear();
  }
}

/** The largest imported gesture-settings object kept (as JSON text). */
export const MAX_IMPORTED_GESTURE_JSON = 4000;

/**
 * An imported `HandGestureSettings` object, as it is (a JSON copy), or
 * undefined when it is not a JSON object or is too large.
 */
export function keepImportedGesture(v: unknown): Record<string, unknown> | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  let text: string;
  try {
    text = JSON.stringify(v);
  } catch {
    return undefined;
  }
  return text.length <= MAX_IMPORTED_GESTURE_JSON
    ? (JSON.parse(text) as Record<string, unknown>)
    : undefined;
}

/** The gestures an imported `HandGestureSettings` names, for the editor and the report. */
export function importedGestureNames(g: Record<string, unknown> | undefined): string[] {
  if (!g) return [];
  return (['GestureLeft', 'GestureRight'] as const)
    .map((k) => (typeof g[k] === 'string' ? (g[k] as string) : ''))
    .filter(Boolean);
}
