import { describe, expect, it } from 'vitest';
import { globalHotkeyStatus, planGlobalHotkey, planGlobalHotkeys } from './globalHotkeys';
import type { Hotkey } from './hotkeys';

const hk = (keys: string, extra: Partial<Hotkey> = {}): Hotkey => ({
  id: keys || 'button',
  label: '',
  keys,
  button: false,
  action: { type: 'expression', expression: 'Smile' },
  ...extra,
});

describe('global hotkeys', () => {
  it('turns combinations into accelerators', () => {
    expect(planGlobalHotkey(hk('Ctrl+Shift+Digit1'), 'windows')).toEqual({
      accelerator: 'Control+Shift+1',
    });
    expect(planGlobalHotkey(hk('Alt+KeyH'), 'linux')).toEqual({ accelerator: 'Alt+H' });
    expect(planGlobalHotkey(hk('Meta+KeyK'), 'mac')).toEqual({ accelerator: 'Command+K' });
    expect(planGlobalHotkey(hk('Meta+KeyK'), 'windows')).toEqual({ accelerator: 'Super+K' });
    // Function and keypad keys need no modifier: they type nothing.
    expect(planGlobalHotkey(hk('F13'), 'windows')).toEqual({ accelerator: 'F13' });
    expect(planGlobalHotkey(hk('Numpad7'), 'windows')).toEqual({ accelerator: 'num7' });
    expect(planGlobalHotkey(hk('Shift+NumpadAdd'), 'windows')).toEqual({
      accelerator: 'Shift+numadd',
    });
  });

  it('keeps window-only what a system shortcut cannot do, saying why', () => {
    expect(planGlobalHotkey(hk('KeyH'), 'windows').reason).toMatch(/taken from every other app/);
    expect(planGlobalHotkey(hk('Shift+KeyH'), 'windows').reason).toMatch(/typing key/);
    expect(planGlobalHotkey(hk('KeyQ+KeyW'), 'windows').reason).toMatch(/Several keys/);
    expect(planGlobalHotkey(hk('Ctrl+F1', { release: 'hold' }), 'windows').reason).toMatch(
      /release/,
    );
    expect(planGlobalHotkey(hk(''), 'windows').reason).toMatch(/button only/);
    // A held motion (play and hold) is a press: it can be global.
    expect(
      planGlobalHotkey(
        hk('F2', { action: { type: 'motion', motion: { group: 'A', index: 0 }, mode: 'hold' } }),
        'windows',
      ),
    ).toEqual({ accelerator: 'F2' });
  });

  it('registers each accelerator once, and reports taken ones', () => {
    const { accelerators, plans } = planGlobalHotkeys(
      [hk('F1'), { ...hk('F1'), id: 'second' }, hk('Ctrl+KeyJ'), hk('KeyH')],
      'windows',
    );
    expect(accelerators).toEqual(['F1', 'Control+J']);
    const status = globalHotkeyStatus(
      plans,
      new Map([
        ['F1', true],
        ['Control+J', false],
      ]),
    );
    expect(status.map((s) => [s.id, s.global])).toEqual([
      ['F1', true],
      ['second', true],
      ['Ctrl+KeyJ', false],
      ['KeyH', false],
    ]);
    expect(status[2]!.reason).toMatch(/already uses/);
  });
});
