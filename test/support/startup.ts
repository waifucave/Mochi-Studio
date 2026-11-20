/**
 * Startup time: from launch to the model on screen.
 *
 * - **Browser:** the page opened with `?model=` (a model served from memory
 *   over HTTP), timed from the navigation's start: the page's script, its
 *   settings read, the UI ready, the model opened, read, loaded, and drawn
 *   (Studio's `startup` marks).
 * - **Desktop app:** launched with a recent model to reopen (the last one,
 *   as a person who streams every day has), timed from the launch.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { _electron, type Page } from 'playwright-core';
import { startHarness } from '../browser/harness';
import { KEEP_NAMES } from './soak';

export type Marks = Record<string, number>;

const MARKS = [
  'script',
  'settingsRead',
  'uiReady',
  'modelStart',
  'modelOpened',
  'modelRead',
  'modelLoaded',
  'modelDrawn',
];

/** Studio's marks, as milliseconds since `zero` (an epoch time). */
async function marks(page: Page, zero: number): Promise<Marks> {
  const r = await page.evaluate(() => ({
    origin: performance.timeOrigin,
    startup: { ...(window as any).mochiStudio.startup } as Record<string, number>,
    nav: (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)
      ?.domContentLoadedEventEnd,
  }));
  const out: Marks = {};
  if (r.nav) out.domContentLoaded = Math.round(r.origin + r.nav - zero);
  for (const k of MARKS)
    if (r.startup[k] !== undefined) out[k] = Math.round(r.origin + r.startup[k]! - zero);
  return out;
}

export async function browserStartup(
  files: Record<string, Uint8Array>,
  modelFile: string,
  runs = 3,
): Promise<Marks[]> {
  const H = await startHarness();
  const out: Marks[] = [];
  try {
    for (let i = 0; i < runs; i++) {
      // A fresh profile each time: nothing cached but what a first visit has.
      const ctx = await H.browser.newContext();
      await ctx.addInitScript({ content: KEEP_NAMES });
      const page = await ctx.newPage();
      await page.route('**/startup-model/**', (route) => {
        const path = decodeURIComponent(new URL(route.request().url()).pathname).replace(
          /^.*\/startup-model\//,
          '',
        );
        const body = files[path];
        return body
          ? route.fulfill({ status: 200, body: Buffer.from(body) })
          : route.fulfill({ status: 404 });
      });
      const t0 = Date.now();
      await page.goto(`${H.url}?model=${encodeURIComponent(`startup-model/${modelFile}`)}`);
      await page.waitForFunction(() => (window as any).mochiStudio?.startup?.modelDrawn, null, {
        timeout: 180_000,
      });
      const m = await marks(page, t0);
      out.push(m);
      await ctx.close();
    }
  } finally {
    await H.close();
  }
  return out;
}

/**
 * The desktop app, launched with `folder` as the last model (reopened at
 * start). Needs `npm run desktop:build`, and a display (xvfb-run on Linux).
 */
export async function desktopStartup(
  files: Record<string, Uint8Array>,
  runs = 3,
): Promise<Marks[]> {
  const home = mkdtempSync(join(tmpdir(), 'mochi-startup-'));
  const folder = join(home, 'Startup Model');
  for (const [p, d] of Object.entries(files)) {
    mkdirSync(dirname(join(folder, p)), { recursive: true });
    writeFileSync(join(folder, p), d);
  }
  const userData = join(home, 'app-data');
  mkdirSync(userData, { recursive: true });
  writeFileSync(
    join(userData, 'recent-models.json'),
    JSON.stringify([{ path: folder, label: 'Startup Model', openedAt: Date.now() }]),
  );
  const electron = (await import('electron')).default as unknown as string;
  const out: Marks[] = [];
  for (let i = 0; i < runs; i++) {
    const port = 47_900 + Math.floor(Math.random() * 90);
    const t0 = Date.now();
    const app = await _electron.launch({
      executablePath: electron,
      args: [
        '--no-sandbox',
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        'desktop/dist/app',
      ],
      env: {
        ...process.env,
        MOCHI_STUDIO_PORT: String(port),
        MOCHI_STUDIO_BRIDGE_HOME: home,
        MOCHI_STUDIO_USER_DATA: userData,
      } as Record<string, string>,
    });
    try {
      const win = await app.firstWindow();
      const windowAt = Date.now() - t0;
      await win.waitForFunction(() => (window as any).mochiStudio?.startup?.modelDrawn, null, {
        timeout: 180_000,
      });
      out.push({ window: windowAt, ...(await marks(win, t0)) });
    } finally {
      await app.close();
    }
  }
  return out;
}

/** The median of each mark over the runs. */
export function medians(runs: Marks[]): Marks {
  const keys = [...new Set(runs.flatMap((r) => Object.keys(r)))];
  const out: Marks = {};
  for (const k of keys) {
    const v = runs
      .map((r) => r[k])
      .filter((x): x is number => x !== undefined)
      .sort((a, b) => a - b);
    out[k] = v[Math.floor(v.length / 2)]!;
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => a[1] - b[1]));
}
