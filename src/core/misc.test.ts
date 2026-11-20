import { describe, expect, it } from 'vitest';
import { backgroundCss } from './background';
import { Emitter } from './events';
import { FrameLimiter } from './frameCap';
import { layoutWithIds } from './items';
import { dragTransform, normalizeRotation, zoomAround } from './scene';
import { ParamDiffer, isSyncMessage } from './sync';

describe('FrameLimiter', () => {
  it('averages the cap on a faster display', () => {
    const f = new FrameLimiter(30);
    let n = 0;
    for (let t = 0; t < 10_000; t += 1000 / 144) if (f.shouldRender(t)) n++;
    expect(n).toBeGreaterThanOrEqual(299);
    expect(n).toBeLessThanOrEqual(301);
  });
  it('is uncapped at 0', () => {
    const f = new FrameLimiter(0);
    expect([0, 1, 2].every((t) => f.shouldRender(t))).toBe(true);
  });
  it('does not burst after a stall', () => {
    const f = new FrameLimiter(60);
    f.shouldRender(0);
    expect(f.shouldRender(5000)).toBe(true);
    expect(f.shouldRender(5001)).toBe(false);
  });
});

describe('scene transform', () => {
  it('drags in canvas-height units', () => {
    expect(dragTransform({ x: 0, y: 0, zoom: 1, rotation: 0 }, 50, -100, 500)).toEqual({
      x: 0.1,
      y: -0.2,
      zoom: 1,
      rotation: 0,
    });
  });
  it('zooms around the cursor', () => {
    const t = zoomAround({ x: 0, y: 0, zoom: 1, rotation: 0 }, 2, 0.5, 0);
    expect(t).toEqual({ x: -0.5, y: 0, zoom: 2, rotation: 0 });
    expect(zoomAround(t, 1000, 0, 0).zoom).toBe(10);
  });
  it('normalises rotation', () => {
    expect(normalizeRotation(190)).toBe(-170);
    expect(normalizeRotation(-540)).toBe(180);
  });
});

describe('background', () => {
  it('produces CSS', () => {
    expect(backgroundCss({ kind: 'chroma', color: '#00ff00' })).toEqual({ background: '#00ff00' });
    expect(
      backgroundCss({ kind: 'image', src: 'data:image/png;base64,"x', fit: 'contain' })[
        'background-image'
      ],
    ).toBe('url("data:image/png;base64,%22x")');
  });
});

describe('sync', () => {
  it('sends only changed parameters', () => {
    const d = new ParamDiffer();
    expect(d.diff({ a: 1, b: 2 })).toEqual({ values: { a: 1, b: 2 }, removed: [] });
    expect(d.diff({ a: 1, b: 2.5 })).toEqual({ values: { b: 2.5 }, removed: [] });
    expect(d.diff({ a: 1, b: 2.5 })).toBeUndefined();
    expect(d.diff({ b: 2.5 })).toEqual({ values: {}, removed: ['a'] });
    expect(d.diff({ b: 2.5 })).toBeUndefined();
  });
  it('recognises messages', () => {
    expect(isSyncMessage({ type: 'params', values: {} })).toBe(true);
    expect(isSyncMessage({ type: 'evil' })).toBe(false);
    expect(isSyncMessage(null)).toBe(false);
  });
});

describe('Emitter', () => {
  it('subscribes and unsubscribes', () => {
    const e = new Emitter<{ x: number }>();
    const got: number[] = [];
    const off = e.on('x', (v) => got.push(v));
    e.emit('x', 1);
    off();
    e.emit('x', 2);
    expect(got).toEqual([1]);
  });
});

describe('item layouts', () => {
  it('gives layouts saved before Mochi2D 0.4.0 the ids Mochi Studio stored alongside', () => {
    const old = {
      format: 'mochi2d-item-layout/1',
      items: [{ name: 'hat.model3.json' }, { name: 'hat.model3.json' }] as {
        name: string;
        id?: string;
      }[],
      mochiStudioIds: ['a', 'b'],
    };
    expect(layoutWithIds(old).items).toEqual([
      { name: 'hat.model3.json', id: 'a' },
      { name: 'hat.model3.json', id: 'b' },
    ]);
    // New layouts already carry ids.
    const now = { items: [{ id: 'x' }] };
    expect(layoutWithIds(now)).toBe(now);
  });
});
