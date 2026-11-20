/**
 * Hotkeys' keys under the plugin API's key names, for `HotkeysInCurrentModelRequest`'s `keyCombination`.
 * It is the reverse of the settings import's key names
 * (src/core/importers/vtubeStudio.ts, `keyCode`). Keys the API's list does
 * not have (Enter, Home, punctuation, the mouse's back and forward buttons,
 * controller buttons) are left out; modifiers come first.
 */
import { comboParts } from './hotkeys';

const MODIFIERS: Record<string, string> = {
  Ctrl: 'LeftControl',
  Shift: 'LeftShift',
  Alt: 'Alt',
  Meta: 'LeftWindows',
};

const NAMED: Record<string, string> = {
  ArrowLeft: 'Left',
  ArrowUp: 'Up',
  ArrowRight: 'Right',
  ArrowDown: 'Down',
  Tab: 'Tab',
  CapsLock: 'CapsLock',
  Escape: 'Escape',
  Space: 'Space',
  PrintScreen: 'Print',
  Delete: 'Delete',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  NumLock: 'NumLock',
  ScrollLock: 'ScrollLock',
  NumpadMultiply: 'Multiply',
  NumpadAdd: 'Add',
  NumpadSubtract: 'Subtract',
  NumpadDecimal: 'Decimal',
  NumpadDivide: 'Divide',
  MouseLeft: 'LeftMouseButton',
  MouseRight: 'RightMouseButton',
  MouseMiddle: 'MiddleMouseButton',
};

/** One key code's API name, or undefined when the API's list has none. */
export function apiKeyName(code: string): string | undefined {
  if (MODIFIERS[code]) return MODIFIERS[code];
  let m: RegExpExecArray | null;
  if ((m = /^Key([A-Z])$/.exec(code))) return m[1];
  if ((m = /^Digit([0-9])$/.exec(code))) return `N${m[1]}`;
  if (/^Numpad[0-9]$/.test(code)) return code;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  return NAMED[code];
}

/** A combination's keys under the API's names, modifiers first; keys without one are left out. */
export function apiKeyCombination(combo: string): string[] {
  return comboParts(combo)
    .map(apiKeyName)
    .filter((n): n is string => n !== undefined);
}
