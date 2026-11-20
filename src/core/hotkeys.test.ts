import { describe, expect, it, vi } from 'vitest';
import {
  ChordTracker,
  HotkeyController,
  comboFromEvent,
  comboFromMouse,
  isMouseCombo,
  comboLabel,
  findHotkeys,
  normalizeCombo,
  type Hotkey,
} from './hotkeys';

const ev = (
  code: string,
  mods: Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', boolean>> = {},
) => ({
  code,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods,
});

describe('key combinations', () => {
  it('normalises events', () => {
    expect(comboFromEvent(ev('Digit1', { shiftKey: true, ctrlKey: true }))).toBe(
      'Ctrl+Shift+Digit1',
    );
    expect(comboFromEvent(ev('ShiftLeft', { shiftKey: true }))).toBeUndefined();
  });
  it('normalises written combos', () => {
    expect(normalizeCombo('shift + ctrl + KeyA')).toBe('Ctrl+Shift+KeyA');
    expect(normalizeCombo('KeyB+KeyA')).toBe('KeyA+KeyB');
    expect(normalizeCombo('Ctrl+KeyB+KeyA')).toBe('Ctrl+KeyA+KeyB');
    expect(normalizeCombo('Ctrl+Shift+KeyA+KeyB')).toBe('Ctrl+Shift+KeyA+KeyB');
    expect(normalizeCombo('KeyA+KeyB+KeyC')).toBeUndefined();
    expect(normalizeCombo('Ctrl')).toBeUndefined();
  });
  it('tracks chords of up to two held keys, plus modifiers', () => {
    const c = new ChordTracker();
    expect(c.down(ev('KeyQ'))).toBe('KeyQ');
    expect(c.down(ev('KeyW'))).toBe('KeyQ+KeyW');
    expect(c.down(ev('ShiftLeft', { shiftKey: true }))).toBe('Shift+KeyQ+KeyW');
    expect(c.down(ev('KeyE', { shiftKey: true }))).toBeUndefined(); // three keys
    expect(c.up(ev('ShiftLeft'))).toBe('Shift');
    expect(c.up(ev('KeyE'))).toBe('KeyE');
    expect(c.up(ev('KeyW'))).toBe('KeyW');
    expect(c.down(ev('KeyE', { ctrlKey: true }))).toBe('Ctrl+KeyE+KeyQ');
    c.clear();
    expect(c.size).toBe(0);
    expect(normalizeCombo('KeyA+KeyB+KeyC')).toBeUndefined();
    expect(normalizeCombo('ctrl+alt+shift+KeyA')).toBe('Ctrl+Alt+Shift+KeyA');
  });
  it('takes mouse buttons, not the left one', () => {
    const m = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };
    expect(comboFromMouse({ ...m, button: 0 })).toBeUndefined();
    expect(comboFromMouse({ ...m, button: 1 })).toBe('MouseMiddle');
    expect(comboFromMouse({ ...m, button: 4, ctrlKey: true })).toBe('Ctrl+MouseForward');
    expect(comboLabel('Ctrl+MouseForward')).toBe('Ctrl+Mouse forward button');
    expect(isMouseCombo('Shift+MouseRight')).toBe(true);
    expect(isMouseCombo('KeyM')).toBe(false);
  });
  it('labels', () => {
    expect(comboLabel('Ctrl+KeyA')).toBe('Ctrl+A');
    expect(comboLabel('Alt+Digit3')).toBe('Alt+3');
  });
});

describe('HotkeyController', () => {
  const target = () => {
    const items = new Set<string>();
    const scenes = new Set<string>();
    return {
      setExpression: vi.fn(),
      playMotion: vi.fn(),
      setItemVisible: vi.fn((i: string, v: boolean) => (v ? items.add(i) : items.delete(i))),
      isItemVisible: (i: string) => items.has(i),
      setItemScene: vi.fn((s: string, on: boolean) => (on ? scenes.add(s) : scenes.delete(s))),
      isItemSceneOn: (s: string) => scenes.has(s),
      calibrate: vi.fn(),
      applyScreenOverlay: vi.fn(),
    };
  };
  const hk = (action: Hotkey['action'], keys = 'KeyE'): Hotkey => ({
    id: 'x',
    label: '',
    keys,
    button: true,
    action,
  });

  it('turns expressions and items off when released, or after some seconds', () => {
    const t = target();
    const pending: Array<{ fn: () => void; ms: number }> = [];
    const c = new HotkeyController(t, (fn, ms) => {
      const p = { fn, ms };
      pending.push(p);
      return () => pending.splice(pending.indexOf(p), 1);
    });
    const held = { ...hk({ type: 'expression', expression: 'wink' }), release: 'hold' as const };
    c.fire(held);
    c.fire(held); // key repeat or a second press: still on
    expect([...c.activeExpressions]).toEqual(['wink']);
    c.release(held);
    expect([...c.activeExpressions]).toEqual([]);
    const timed = {
      ...hk({ type: 'item', item: 'hat' }),
      id: 't',
      release: 'timer' as const,
      seconds: 2,
    };
    c.fire(timed);
    expect(t.isItemVisible('hat')).toBe(true);
    expect(pending.map((p) => p.ms)).toEqual([2000]);
    pending[0]!.fn();
    expect(t.isItemVisible('hat')).toBe(false);
    // A press while on turns it off and cancels the timer.
    c.fire(timed);
    c.fire(timed);
    expect(t.isItemVisible('hat')).toBe(false);
    expect(pending).toHaveLength(1);
  });

  it('toggles item scenes with their fade, and switches them off after a time', () => {
    const t = target();
    const pending: Array<{ fn: () => void; ms: number }> = [];
    const c = new HotkeyController(t, (fn, ms) => {
      const p = { fn, ms };
      pending.push(p);
      return () => pending.splice(pending.indexOf(p), 1);
    });
    const scene = hk({ type: 'itemScene', scene: 'desk', fade: 1.5 });
    c.fire(scene);
    expect(t.isItemSceneOn('desk')).toBe(true);
    c.fire(scene);
    expect(t.setItemScene.mock.calls).toEqual([
      ['desk', true, 1.5],
      ['desk', false, 1.5],
    ]);
    const hour = { ...scene, id: 's', release: 'timer' as const, seconds: 3600 };
    c.fire(hour);
    expect(pending.map((p) => p.ms)).toEqual([3_600_000]);
    pending[0]!.fn();
    expect(t.isItemSceneOn('desk')).toBe(false);
  });

  it('clears all expressions and starts calibration', () => {
    const t = target();
    const c = new HotkeyController(t);
    c.fire(hk({ type: 'expression', expression: 'a' }));
    c.fire(hk({ type: 'expression', expression: 'b' }));
    c.fire(hk({ type: 'clearExpressions' }));
    expect([...c.activeExpressions]).toEqual([]);
    expect(t.setExpression.mock.calls.slice(2)).toEqual([
      ['a', false],
      ['b', false],
    ]);
    c.fire(hk({ type: 'calibrate' }));
    expect(t.calibrate).toHaveBeenCalledOnce();
  });

  it('toggles expressions', () => {
    const t = target();
    const c = new HotkeyController(t);
    const h = hk({ type: 'expression', expression: 'blush' });
    c.fire(h);
    c.fire(h);
    expect(t.setExpression.mock.calls).toEqual([
      ['blush', true],
      ['blush', false],
    ]);
  });
  it('plays motions with their mode and toggles items', () => {
    const t = target();
    const c = new HotkeyController(t);
    c.fire(hk({ type: 'motion', motion: { group: '', index: 2 }, mode: 'hold' }));
    expect(t.playMotion).toHaveBeenCalledWith({ group: '', index: 2 }, 'hold');
    const item = hk({ type: 'item', item: 'umbrella' });
    c.fire(item);
    c.fire(item);
    expect(t.setItemVisible.mock.calls).toEqual([
      ['umbrella', true],
      ['umbrella', false],
    ]);
  });
  it('finds hotkeys by combo, ignoring button-only ones', () => {
    const list = [hk({ type: 'item', item: 'a' }, 'KeyA'), hk({ type: 'item', item: 'b' }, '')];
    expect(findHotkeys(list, 'KeyA')).toHaveLength(1);
    expect(findHotkeys(list, '')).toHaveLength(0);
  });
});

describe('the left mouse button with a modifier', () => {
  it('is a hotkey key only with a modifier', async () => {
    const { comboFromLeftClick, isLeftClickCombo, comboLabel } = await import('./hotkeys');
    const e = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };
    expect(comboFromLeftClick(e)).toBeUndefined();
    expect(comboFromLeftClick({ ...e, altKey: true })).toBe('Alt+MouseLeft');
    expect(comboFromLeftClick({ ...e, ctrlKey: true, shiftKey: true })).toBe(
      'Ctrl+Shift+MouseLeft',
    );
    expect(isLeftClickCombo('Alt+MouseLeft')).toBe(true);
    expect(isLeftClickCombo('KeyQ+MouseLeft')).toBe(false);
    expect(comboLabel('Alt+MouseLeft')).toBe('Alt+Left click');
  });

  it('reads the modifiers of real events, whose flags live on their prototype', async () => {
    const { comboFromLeftClick, comboFromMouse } = await import('./hotkeys');
    class FakeEvent {
      get altKey() {
        return true;
      }
      get ctrlKey() {
        return false;
      }
      get shiftKey() {
        return false;
      }
      get metaKey() {
        return false;
      }
      get button() {
        return 2;
      }
    }
    const e = new FakeEvent();
    expect(comboFromLeftClick(e)).toBe('Alt+MouseLeft');
    expect(comboFromMouse(e)).toBe('Alt+MouseRight');
  });
});
