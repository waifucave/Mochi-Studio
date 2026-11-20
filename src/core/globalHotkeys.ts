/**
 * Hotkeys that work while another app has focus (the desktop app only).
 *
 * The desktop app registers them with the system through Electron's
 * `globalShortcut`, whose accelerators are a modifier set plus one key, and
 * which reports presses only. So some hotkeys stay window-only, each with
 * the reason:
 *
 * - several non-modifier keys held together (`KeyQ+KeyW`);
 * - "on while held" hotkeys, which need the key's release;
 * - plain typing keys (a letter, a digit, Space, Enter… without Ctrl, Alt or
 *   Cmd/Win): registered system-wide, they would be taken from every other
 *   app, so typing in a game's chat would fire the hotkey instead;
 * - keys an accelerator cannot name.
 *
 * A key the system or another app has already taken is reported after
 * registering (`GlobalHotkeyStatus.taken`).
 */
import { comboParts, isMouseCombo, isPadCombo, type Hotkey } from './hotkeys';

export type Platform = 'mac' | 'windows' | 'linux';

const MODIFIER_ACCELERATOR = (p: Platform): Record<string, string> => ({
  Ctrl: 'Control',
  Alt: 'Alt',
  Shift: 'Shift',
  Meta: p === 'mac' ? 'Command' : 'Super',
});

const NAMED: Record<string, string> = {
  Space: 'Space',
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Escape: 'Escape',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`',
  PrintScreen: 'PrintScreen',
  NumpadAdd: 'numadd',
  NumpadSubtract: 'numsub',
  NumpadMultiply: 'nummult',
  NumpadDivide: 'numdiv',
  NumpadDecimal: 'numdec',
  MediaPlayPause: 'MediaPlayPause',
  MediaStop: 'MediaStop',
  MediaTrackNext: 'MediaNextTrack',
  MediaTrackPrevious: 'MediaPreviousTrack',
  AudioVolumeUp: 'VolumeUp',
  AudioVolumeDown: 'VolumeDown',
  AudioVolumeMute: 'VolumeMute',
};

/** Keys that type something: taken system-wide without Ctrl, Alt or Cmd/Win, they would block typing. */
function typingKey(code: string): boolean {
  return (
    /^Key[A-Z]$/.test(code) ||
    /^Digit\d$/.test(code) ||
    [
      'Space',
      'Enter',
      'Tab',
      'Backspace',
      'Minus',
      'Equal',
      'BracketLeft',
      'BracketRight',
      'Backslash',
      'Semicolon',
      'Quote',
      'Comma',
      'Period',
      'Slash',
      'Backquote',
    ].includes(code)
  );
}

/** The accelerator key for a physical key code, or undefined. */
function acceleratorKey(code: string): string | undefined {
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1];
  m = /^Digit(\d)$/.exec(code);
  if (m) return m[1];
  m = /^F(\d{1,2})$/.exec(code);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 24) return `F${m[1]}`;
  m = /^Numpad(\d)$/.exec(code);
  if (m) return `num${m[1]}`;
  return NAMED[code];
}

export type GlobalHotkeyPlan =
  { accelerator: string; reason?: undefined } | { accelerator?: undefined; reason: string };

/** Whether a hotkey can be global, and its accelerator; or why not. */
export function planGlobalHotkey(h: Hotkey, platform: Platform): GlobalHotkeyPlan {
  if (!h.keys) return { reason: 'It has no keys (button only).' };
  const isHold =
    h.release === 'hold' &&
    (h.action.type === 'expression' || h.action.type === 'item' || h.action.type === 'itemScene');
  if (isHold)
    return {
      reason:
        '“On while held” needs the key’s release, which the system does not report to other apps’ shortcuts.',
    };
  if (isMouseCombo(h.keys))
    return { reason: 'Mouse buttons work only while Mochi Studio’s window has focus.' };
  if (isPadCombo(h.keys))
    return {
      reason:
        'Controller buttons are read by Mochi Studio itself, not by the system: they work as long as it gets the controller.',
    };
  const mods = MODIFIER_ACCELERATOR(platform);
  const parts = comboParts(h.keys);
  const modParts = parts.filter((p) => p in mods);
  const keys = parts.filter((p) => !(p in mods));
  if (keys.length !== 1)
    return {
      reason:
        'Several keys held together cannot be a system-wide shortcut; use one key with modifiers.',
    };
  const key = keys[0]!;
  const strong = modParts.some((p) => p !== 'Shift');
  if (typingKey(key) && !strong)
    return {
      reason:
        'A typing key without Ctrl, Alt or Cmd/Win would be taken from every other app while Mochi Studio runs. Add a modifier, or use F1–F24 or the numeric keypad.',
    };
  const accel = acceleratorKey(key);
  if (!accel) return { reason: 'The system cannot register this key as a shortcut.' };
  return { accelerator: [...modParts.map((p) => mods[p]!), accel].join('+') };
}

export interface GlobalHotkeyStatus {
  id: string;
  /** Registered with the system: it works while another app has focus. */
  global: boolean;
  /** Why it works only while Mochi Studio has focus. */
  reason?: string;
  accelerator?: string;
}

/** The accelerators to register (each once), and every hotkey's plan. */
export function planGlobalHotkeys(
  hotkeys: readonly Hotkey[],
  platform: Platform,
): { accelerators: string[]; plans: Map<string, GlobalHotkeyPlan> } {
  const plans = new Map(hotkeys.map((h) => [h.id, planGlobalHotkey(h, platform)] as const));
  const accelerators = [
    ...new Set([...plans.values()].flatMap((p) => (p.accelerator ? [p.accelerator] : []))),
  ];
  return { accelerators, plans };
}

/** Each hotkey's status, once the app has tried to register the accelerators. */
export function globalHotkeyStatus(
  plans: ReadonlyMap<string, GlobalHotkeyPlan>,
  registered: ReadonlyMap<string, boolean>,
): GlobalHotkeyStatus[] {
  return [...plans].map(([id, p]) => {
    if (!p.accelerator) return { id, global: false, reason: p.reason };
    if (registered.get(p.accelerator)) return { id, global: true, accelerator: p.accelerator };
    return {
      id,
      global: false,
      accelerator: p.accelerator,
      reason:
        'The system or another app already uses this key combination, so it works only while Mochi Studio has focus. Choose another, or free it in that app.',
    };
  });
}
