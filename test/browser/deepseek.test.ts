import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { openSection, startHarness, type Harness } from './harness';

/**
 * Head tracking on DeepSeek-chan in the running app, where look-at routes
 * through physics: the file-only unit test cannot see that.
 * Runs against the locally supplied model in assets/models/DeepSeek/
 * (gitignored, never committed); skipped without it.
 *
 * The folder is served over HTTP from disk (`page.route`), not through the
 * file input: Playwright's file input crashed the page with this 61 MB
 * folder and its non-ASCII file names.
 */
const DIR = new URL('../../assets/models/DeepSeek', import.meta.url).pathname;
const present = existsSync(DIR);
let H: Harness;
beforeAll(async () => {
  if (present) H = await startHarness();
});
afterAll(async () => {
  await H?.close();
});
function walk(d: string): string[] {
  return readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const PREFIX = '/__deepseek/';

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/synthetic-session.json', import.meta.url), 'utf8'),
);

/** The app with DeepSeek-chan loaded, its files served from disk. */
async function openDeepSeek(): Promise<{ page: Page; errors: string[] }> {
  const page = await H.context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const paths = walk(DIR).map((p) => relative(DIR, p).split('\\').join('/'));
  await page.route(`**${PREFIX}**`, (route) => {
    const rel = new URL(route.request().url()).pathname
      .slice(PREFIX.length)
      .split('/')
      .map(decodeURIComponent)
      .join('/');
    if (!paths.includes(rel)) return route.fulfill({ status: 404 });
    return route.fulfill({ status: 200, body: readFileSync(join(DIR, rel)) });
  });
  await page.goto(H.url);
  await page.waitForFunction(() => 'mochiStudio' in window);
  // A file set that reads each file from the route, as a folder would give them.
  await page.evaluate(
    ([paths, prefix]) => {
      const set = new Set(paths);
      return (window as any).mochiStudio.loadModel({
        label: 'DeepSeek',
        paths: () => [...paths],
        has: (p: string) => set.has(p),
        read: async (p: string) => {
          const r = await fetch(prefix + p.split('/').map(encodeURIComponent).join('/'));
          if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`);
          return new Uint8Array(await r.arrayBuffer());
        },
      });
    },
    [paths, PREFIX] as const,
  );
  await page.waitForFunction(() => (window as any).mochiStudio.settings !== undefined, null, {
    timeout: 120_000,
  });
  return { page, errors };
}

describe.skipIf(!present)('DeepSeek-chan in the running app', () => {
  it('turns the head with tracking: AngleX follows, ParamAngleX moves through physics', async () => {
    const { page, errors } = await openDeepSeek();
    // The drivers come from Mochi2D: look-at's routing for the head.
    const drivers = await page.evaluate(() => (window as any).mochiStudio.physicsDrivers);
    expect(drivers.ParamAngleX).toEqual({ from: 'AngleX', reflect: false });
    expect(drivers.ParamBodyAngleZ).toEqual({ from: 'PositionZ', reflect: true });
    // The recorded session's head turn (±25° yaw from 2 s to 4 s), frame by frame.
    const peak = await page.evaluate(async (frames) => {
      const s = (window as any).mochiStudio;
      const m = s.runtime.model;
      s.stop();
      const out = { AngleX: 0, ParamAngleX: 0 };
      for (const f of frames) {
        if (f.t > 4500) break;
        s.feedFrame(f);
        s.frame(f.t + 100_000);
        if (f.t >= 2000) {
          out.AngleX = Math.max(out.AngleX, Math.abs(m.getParameter('AngleX')));
          out.ParamAngleX = Math.max(out.ParamAngleX, Math.abs(m.getParameter('ParamAngleX')));
        }
      }
      return out;
    }, fixture.frames);
    expect(peak.AngleX).toBeGreaterThan(5);
    expect(peak.ParamAngleX).toBeGreaterThan(5);
    expect(errors).toEqual([]);
    await page.close();
  }, 180_000);

  it('sets the physics strength, wind and group multipliers on the real model', async () => {
    const { page, errors } = await openDeepSeek();
    const r = await page.evaluate(() => {
      const s = (window as any).mochiStudio;
      const m = s.runtime.model;
      s.stop();
      // Nothing but physics moves the outputs: no idle motion, breath or blinking.
      s.updateSettings({ idleMotion: undefined });
      for (const e of ['breath', 'eyeBlink', 'idle']) s.runtime.setEffect(e, false);
      const groups = s.physicsGroups();
      const outputs = [...s.runtime.physicsFacts().physicsInputs.keys()];
      // Strength 0 is the same as physics off: every output keeps its base value.
      s.updateSettings({ physicsTuning: { strength: 0, wind: 0, groups: {} } });
      for (let i = 0; i < 10; i++) s.frame(200_000 + i * 50);
      const moved = outputs.filter(
        (id: string) => Math.abs(m.getParameter(id) - m.getParameterBase(id)) > 1e-4,
      );
      s.updateSettings({
        physicsTuning: { strength: 75, wind: 30, groups: { [groups[0].id]: 0.5 } },
      });
      return {
        groups,
        outputs: outputs.length,
        moved,
        strength: m.physicsStrength,
        first: m.getPhysicsSettingStrength(groups[0].id),
        wind: s.runtime.physicsValues().wind,
      };
    });
    expect(r.groups.length).toBeGreaterThan(0);
    expect(r.groups.every((g: { id: string }) => typeof g.id === 'string' && g.id)).toBe(true);
    expect(r.outputs).toBeGreaterThan(0);
    expect(r.moved).toEqual([]);
    expect(r.strength).toBe(1.5);
    expect(r.first).toBe(0.5);
    expect(r.wind).toEqual([0.3, 0]);
    // The Model tab names the groups from the physics file.
    await openSection(page, 'Model');
    expect(await page.locator('.physics-group').count()).toBe(r.groups.length);
    expect(errors).toEqual([]);
    await page.close();
  }, 180_000);
});
