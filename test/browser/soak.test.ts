import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { growth, runSoak } from '../support/soak';

/**
 * A stream, compressed: an hour's events in a minute
 * and a half, with tracking, a plugin, hotkeys, expressions, items, an output
 * view and the light overlay (test/support/soak.ts). Memory must not grow,
 * nothing may fail, and both pages keep drawing. The long run is
 * `npm run soak` (scripts/soak.ts).
 */
describe('a long stream, compressed', () => {
  it(
    'runs an hour of events in 90 seconds without growing or failing',
    { timeout: 240_000 },
    async () => {
      const r = await runSoak({
        minutes: Number(process.env.MOCHI_SOAK_MINUTES ?? 1.5),
        sampleEvery: 15,
        log: process.env.MOCHI_SOAK_LOG ? (m) => console.log(m) : undefined,
      });
      // MOCHI_SOAK_OUT=file.json keeps the samples.
      if (process.env.MOCHI_SOAK_OUT) writeFileSync(process.env.MOCHI_SOAK_OUT, JSON.stringify(r));
      expect(r.errors).toEqual([]);
      expect(r.events.hotkeyKey).toBeGreaterThan(60);
      expect(r.events.pluginItemLoad).toBeGreaterThan(50);
      expect(r.events.viewRefresh).toBeGreaterThanOrEqual(3);
      // The items really came and went.
      expect(r.events.pluginItemLoaded).toBeGreaterThan(50);
      expect(r.events.imageItemAdded).toBeGreaterThan(15);
      // Both pages kept drawing: at least 40% of what they drew on this machine before the
      // events (the view's figure includes its refreshes, when it draws nothing), and the
      // window in every sample's interval.
      const rates = JSON.stringify({ fps: r.fps, before: r.baseFps });
      for (const p of ['window', 'view'] as const) {
        expect(r.baseFps[p], rates).toBeGreaterThan(0);
        expect(r.fps[p], rates).toBeGreaterThan(r.baseFps[p] * 0.4);
      }
      for (let i = 1; i < r.samples.length; i++)
        expect(r.samples[i]!.window.frames).toBeGreaterThan(r.samples[i - 1]!.window.frames);
      // No growth after warm-up: a few MB of heap at most, no DOM nodes or listeners piling up.
      for (const p of ['window', 'view'] as const) {
        const g = growth(r.samples, p);
        expect(g.heapMB, `${p} heap`).toBeLessThan(4);
        expect(g.nodes, `${p} nodes`).toBeLessThan(150);
        expect(g.listeners, `${p} listeners`).toBeLessThan(50);
      }
      // Every item added was removed: the WebGL objects are back where they were.
      const first = r.samples[0]!.window.gl;
      const last = r.samples.at(-1)!.window.gl;
      expect(last.Texture).toBeLessThanOrEqual((first.Texture ?? 0) + 2);
      expect(last.Buffer).toBeLessThanOrEqual((first.Buffer ?? 0) + 4);
    },
  );
});
