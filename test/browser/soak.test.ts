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
      // Nothing failed: every plugin request was answered (late, on a busy machine), and
      // neither page threw.
      expect(r.errors).toEqual([]);
      // The counts and the frame rates ask for so many events in 90 seconds. They mean
      // something only if this process (the test, the bridge and the plugin) ran all that
      // time. A machine too busy to run it holds it for seconds at a time: two loaded cores
      // shared with the browser held it for up to 22 s in a run. Then they are not checked,
      // and the test says so; what follows still is.
      const held = r.heldMs / (r.seconds * 1000);
      const summary = `held ${(r.heldMs / 1000).toFixed(1)} s of ${r.seconds} s; slowest answer ${r.slowestAnswer.type} ${r.slowestAnswer.ms} ms; events ${JSON.stringify(r.events)}`;
      if (held > 0.1)
        console.log(`The soak's counts and frame rates are not meaningful here: ${summary}`);
      else {
        expect(r.events.hotkeyKey, summary).toBeGreaterThan(60);
        expect(r.events.pluginItemLoad, summary).toBeGreaterThan(50);
        expect(r.events.viewRefresh, summary).toBeGreaterThanOrEqual(3);
        // The items really came and went.
        expect(r.events.pluginItemLoaded, summary).toBeGreaterThan(50);
        expect(r.events.imageItemAdded, summary).toBeGreaterThan(15);
        // Both pages kept drawing: at least 40% of what they drew on this machine before the
        // events (the view's figure includes its refreshes, when it draws nothing).
        const rates = JSON.stringify({ fps: r.fps, before: r.baseFps });
        for (const p of ['window', 'view'] as const) {
          expect(r.baseFps[p], rates).toBeGreaterThan(0);
          expect(r.fps[p], rates).toBeGreaterThan(r.baseFps[p] * 0.4);
        }
      }
      // The window drew in every sample's interval.
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
