import { describe, expect, it } from 'vitest';
import { apiKeyCombination, apiKeyName } from './apiKeyNames';
import { comboFromTriggers, keyCode } from './importers/vtubeStudio';

/** The API's key list: 99 names. */
const API_KEYS = [
  ...['LeftMouseButton', 'RightMouseButton', 'MiddleMouseButton'],
  ...['Tab', 'CapsLock', 'Escape', 'Space', 'Left', 'Up', 'Right', 'Down'],
  ...['Print', 'Delete', 'PageUp', 'PageDown'],
  ...Array.from({ length: 10 }, (_, i) => `N${i}`),
  ...Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i)),
  ...['LeftWindows', 'RightWindows'],
  ...Array.from({ length: 10 }, (_, i) => `Numpad${i}`),
  ...['Multiply', 'Add', 'Subtract', 'Decimal', 'Divide'],
  ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
  ...['NumLock', 'ScrollLock'],
  ...['LeftShift', 'RightShift', 'LeftControl', 'RightControl', 'Alt'],
];

describe('hotkeys under the API’s key names', () => {
  it('has the 99 names, and goes back to each one the importer reads', () => {
    expect(API_KEYS).toHaveLength(99);
    for (const name of API_KEYS) {
      const combo = comboFromTriggers(name === 'LeftMouseButton' ? ['Alt', name] : [name]) as {
        combo: string;
      };
      // Modifiers alone are no combination; they are checked below.
      if (!combo.combo) continue;
      const back = apiKeyCombination(combo.combo);
      expect(back[back.length - 1], name).toBe(name);
    }
    // The modifiers: one name each (the left ones), and the Windows keys as Meta.
    expect(apiKeyCombination('Ctrl+Alt+Shift+Meta+KeyA')).toEqual([
      'LeftControl',
      'Alt',
      'LeftShift',
      'LeftWindows',
      'A',
    ]);
    expect(keyCode('N7')).toBe('Digit7');
  });

  it('lists a chord’s keys and leaves out keys the API has no name for', () => {
    expect(apiKeyCombination('KeyQ+KeyW')).toEqual(['Q', 'W']);
    expect(apiKeyCombination('Ctrl+Digit1')).toEqual(['LeftControl', 'N1']);
    expect(apiKeyCombination('Alt+MouseLeft')).toEqual(['Alt', 'LeftMouseButton']);
    expect(apiKeyCombination('Enter')).toEqual([]);
    expect(apiKeyCombination('KeyQ+PadCross')).toEqual(['Q']);
    expect(apiKeyCombination('')).toEqual([]);
    expect(apiKeyName('MouseBack')).toBeUndefined();
  });
});
