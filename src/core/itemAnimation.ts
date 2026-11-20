/**
 * Playback of animated items: each item's frame count, frame
 * rate (0–60; 0 holds the frame shown), play state, the frame shown, and the
 * frames where playback stops by itself (the plugin API's auto-stop frames).
 * A GIF whose frames have their own delays keeps them: its frame
 * rate is then a speed factor against the GIF's own average rate.
 * Pure: the studio ticks it every frame and shows the frames it reports.
 */
import { MAX_FPS } from './animatedItem';

export interface ItemAnimationState {
  frames: number;
  fps: number;
  playing: boolean;
  frame: number;
  autoStop: number[];
  /** The frames keep their GIF's own delays: `fps` is a speed factor against `baseFps`. */
  ownTiming: boolean;
  /** The rate the item came with (a GIF's average rate, or the folder default). */
  baseFps: number;
}

/** A GIF's own timing: each frame's delay (ms), and the average rate they make. */
export interface FrameTiming {
  delays: readonly number[];
  baseFps: number;
}

interface Entry extends Omit<ItemAnimationState, 'ownTiming' | 'baseFps'> {
  /** Milliseconds into the frame shown. */
  acc: number;
  baseFps: number;
  timing?: FrameTiming;
}

export class ItemAnimator {
  private items = new Map<string, Entry>();

  /**
   * An animated item appears (or comes back with its saved rate and play
   * state). With `timing`, each frame lasts its own delay, scaled by
   * `timing.baseFps / fps`.
   */
  add(id: string, frames: number, fps: number, playing = true, timing?: FrameTiming): void {
    const n = Math.max(1, Math.floor(frames));
    const usable =
      timing &&
      timing.delays.length === n &&
      timing.baseFps > 0 &&
      timing.delays.every((d) => Number.isFinite(d) && d > 0);
    this.items.set(id, {
      frames: n,
      fps: clampFps(fps),
      playing,
      frame: 0,
      autoStop: [],
      acc: 0,
      baseFps: usable ? timing.baseFps : clampFps(fps),
      ...(usable ? { timing: { delays: [...timing.delays], baseFps: timing.baseFps } } : {}),
    });
  }

  remove(id: string): void {
    this.items.delete(id);
  }

  has(id: string): boolean {
    return this.items.has(id);
  }

  get(id: string): ItemAnimationState | undefined {
    const e = this.items.get(id);
    return e
      ? {
          frames: e.frames,
          fps: e.fps,
          playing: e.playing,
          frame: e.frame,
          autoStop: [...e.autoStop],
          ownTiming: !!e.timing,
          baseFps: e.baseFps,
        }
      : undefined;
  }

  /**
   * Changes an item's playback. A jump to a frame restarts that frame's time;
   * starting playback again after an auto-stop goes on from the frame shown.
   * Returns the frame shown afterwards.
   */
  control(
    id: string,
    c: { fps?: number; frame?: number; playing?: boolean; autoStop?: readonly number[] },
  ): number | undefined {
    const e = this.items.get(id);
    if (!e) return undefined;
    if (c.fps !== undefined) e.fps = clampFps(c.fps);
    if (c.autoStop !== undefined)
      e.autoStop = [...new Set(c.autoStop)].filter((f) => f >= 0 && f < e.frames);
    if (c.frame !== undefined) {
      e.frame = Math.max(0, Math.min(e.frames - 1, Math.floor(c.frame)));
      e.acc = 0;
    }
    if (c.playing !== undefined) {
      if (c.playing && !e.playing) e.acc = 0;
      e.playing = c.playing;
    }
    return e.frame;
  }

  /** Advances every playing item by `dt` milliseconds; returns the items whose frame changed. */
  tick(dt: number): Array<[string, number]> {
    const changed: Array<[string, number]> = [];
    for (const [id, e] of this.items) {
      if (!e.playing || e.fps <= 0 || e.frames < 2) continue;
      e.acc += Math.max(0, dt);
      const before = e.frame;
      // A long pause (a hidden window) moves on by the frames it missed, at most one loop.
      let steps = 0;
      for (let ms = duration(e); e.acc >= ms; ms = duration(e)) {
        if (steps === e.frames) {
          e.acc %= ms;
          break;
        }
        e.acc -= ms;
        e.frame = (e.frame + 1) % e.frames;
        steps++;
        if (e.autoStop.includes(e.frame)) {
          e.playing = false;
          e.acc = 0;
          break;
        }
      }
      if (e.frame !== before) changed.push([id, e.frame]);
    }
    return changed;
  }

  /** Every animated item's frame, for an output view that joins late. */
  frames(): Array<[string, number]> {
    return [...this.items].map(([id, e]) => [id, e.frame]);
  }

  clear(): void {
    this.items.clear();
  }
}

/** How long the frame shown lasts (ms) at the item's rate: its own delay scaled, or 1/fps. */
function duration(e: Entry): number {
  return e.timing ? (e.timing.delays[e.frame]! * e.timing.baseFps) / e.fps : 1000 / e.fps;
}

export function clampFps(fps: number): number {
  return Number.isFinite(fps) ? Math.max(0, Math.min(MAX_FPS, fps)) : 0;
}
