import { describe, expect, it } from 'vitest';
import {
  FrameGovernor,
  LOWER_EVERY_MS,
  MIN_FPS,
  RAISE_AFTER_MS,
  START_FPS,
  TELL_AFTER_MS,
  startFps,
  rateText,
} from './frameGovernor';

function setup(wanted: number) {
  let t = 0;
  const applied: number[] = [];
  const told: number[] = [];
  const g = new FrameGovernor(
    wanted,
    { apply: (f) => applied.push(f), tell: (f) => told.push(f) },
    START_FPS,
    () => t,
  );
  /** Samples every 250 ms for `ms`, the window answering in `answer` ms. */
  const run = (ms: number, answer: number) => {
    for (const end = t + ms; t < end; t += 250) g.sample(answer);
  };
  return { g, applied, told, run, at: () => t, advance: (ms: number) => (t += ms) };
}

describe('the frame governor', () => {
  it('starts at no more than START_FPS and goes up to the rate asked for while the window answers', () => {
    const { g, run, told } = setup(60);
    expect(g.fps).toBe(START_FPS);
    run(30_000, 10);
    expect(g.fps).toBe(60);
    expect(g.held).toBe(false);
    expect(told).toEqual([]);
  });

  it('halves the rate while the window is slow, down to MIN_FPS, and tells once', () => {
    const { g, run, told, applied } = setup(30);
    run(20_000, 10);
    expect(g.fps).toBe(30);
    // Each step a LOWER_EVERY_MS apart: 30, 15, 7, 3, 2.
    run(LOWER_EVERY_MS * 4 + 1, 3000);
    expect(applied.slice(-4)).toEqual([15, 7, 3, 2]);
    expect(g.fps).toBe(MIN_FPS);
    expect(g.held).toBe(true);
    expect(told).toEqual([]);
    // Still slow at MIN_FPS: paused (0) by the time the person is told, once.
    run(TELL_AFTER_MS, 3000);
    expect(g.fps).toBe(0);
    expect(told).toEqual([0]);
    run(TELL_AFTER_MS * 4, 3000);
    expect(told).toEqual([0]);
  });

  it('comes back up more slowly each time it had to come down, and stops below the rate that was too much', () => {
    const { g, run, at } = setup(30);
    run(20_000, 10);
    // Too much at 30: the window is slow whenever the rate is above 20.
    const answer = () => (g.fps > 20 ? 600 : 10);
    const rates: number[] = [];
    for (const end = at() + 120_000; at() < end;) {
      run(250, answer());
      rates.push(g.fps);
    }
    const lastMinute = rates.slice(-240);
    expect(Math.max(...lastMinute)).toBeLessThanOrEqual(30);
    // Most of the last minute at a rate the window keeps up with.
    expect(lastMinute.filter((f) => f <= 20).length).toBeGreaterThan(200);
    expect(g.held).toBe(true);
  });

  it('holds and tells about an output that sends far below its rate, though the window answers', () => {
    const { g, run, told, advance, at } = setup(30);
    // The window answers at once; the page paints once every 2 s (as if starved).
    let nextPaint = at();
    for (const end = at() + 20_000; at() < end;) {
      if (at() >= nextPaint) {
        g.allow();
        nextPaint += 2000;
      }
      run(250, 10);
    }
    expect(g.held).toBe(true);
    expect(g.sendingFps).toBeLessThan(1);
    // Brought down to about what it gets (at least MIN_FPS), not raised meanwhile.
    expect(g.fps).toBe(MIN_FPS);
    expect(told).toHaveLength(1);
    expect(rateText(told[0]!)).toBe('less than 1');
    // Frames come again at the allowed rate: raised step by step, and no longer held once back
    // at the rate asked for.
    for (const end = at() + 300_000; at() < end;) {
      g.allow();
      advance(1000 / g.fps);
      g.sample(10);
    }
    expect(g.held).toBe(false);
    expect(told).toHaveLength(1);
  });

  it('pauses an output still too much at MIN_FPS, and starts it again when the app answers', () => {
    const { g, run, applied } = setup(30);
    run(20_000, 10);
    run(5000, 3000);
    expect(g.fps).toBe(0);
    expect(applied).toContain(0);
    expect(g.allow()).toBe(false);
    expect(g.held).toBe(true);
    // (Each step down doubled the wait before a step up, to at most a minute.)
    run(70_000, 10);
    expect(g.fps).toBeGreaterThanOrEqual(MIN_FPS);
  });

  it('does not watch the rate when asked not to (a page that paints only when it changes)', () => {
    let t = 0;
    const g = new FrameGovernor(10, { apply: () => {}, tell: () => {} }, 10, () => t, false);
    g.allow();
    for (let i = 0; i < 80; i++) {
      t += 250;
      g.sample(10);
    }
    expect(g.held).toBe(false);
  });

  it('begins a larger output at a lower rate', () => {
    expect(startFps(1280, 720)).toBe(START_FPS);
    expect(startFps(960, 540)).toBe(START_FPS);
    expect(startFps(1920, 1080)).toBe(7);
    expect(startFps(3840, 2160)).toBe(MIN_FPS);
  });

  it('skips paints that come sooner than the rate allows, without keeping them', () => {
    const { g, advance } = setup(10);
    expect(g.fps).toBe(10);
    let sent = 0;
    for (let i = 0; i < 60; i++) {
      if (g.allow()) sent++;
      advance(1000 / 60);
    }
    // One second of 60 paints a second, at 10 frames a second.
    expect(sent).toBeGreaterThanOrEqual(9);
    expect(sent).toBeLessThanOrEqual(11);
  });

  it('takes a new rate asked for, kept below it while held', () => {
    const { g, run, applied } = setup(30);
    run(20_000, 10);
    g.setWanted(60);
    expect(g.fps).toBe(30);
    run(RAISE_AFTER_MS * 10, 10);
    expect(g.fps).toBe(60);
    run(LOWER_EVERY_MS * 2 + 1, 3000);
    expect(g.held).toBe(true);
    const held = g.fps;
    g.setWanted(24);
    expect(g.fps).toBe(Math.min(held, 24));
    g.setWanted(5);
    expect(applied.at(-1)).toBe(5);
    expect(g.held).toBe(false);
  });
});
