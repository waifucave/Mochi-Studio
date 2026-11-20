import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openSection, startHarness, type Harness } from './harness';

/**
 * The README's screenshots, generated: the sample model «Mochi» and what the
 * app draws itself, with the recorded synthetic tracking session as the
 * face (no camera picture, no person). Every run takes them and checks them;
 * `npm run screenshots` (or `MOCHI_SCREENSHOTS=update`) also rewrites
 * docs/screenshots/, which the README shows.
 */
const UPDATE =
  process.env.MOCHI_SCREENSHOTS === 'update' || process.env.npm_lifecycle_event === 'screenshots';
const DIR = UPDATE ? 'docs/screenshots' : mkdtempSync(join(tmpdir(), 'mochi-shots-'));
/** The files, in the README's order. */
const SHOTS = ['main-window.png', 'mapping-editor.png', 'output-view.png', 'hotkeys.png'];

let H: Harness;
let ctx: BrowserContext;
beforeAll(async () => {
  H = await startHarness();
  ctx = await H.browser.newContext({
    viewport: { width: 1200, height: 720 },
    deviceScaleFactor: 1,
    permissions: ['camera', 'microphone'],
  });
  // The guide has its own place in the README's text; the pictures show the app in use.
  await ctx.addInitScript(() => localStorage.setItem('mochi-studio.guide', 'hidden'));
});
afterAll(async () => {
  await ctx?.close();
  await H?.close();
});

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/synthetic-session.json', import.meta.url), 'utf8'),
) as { frames: unknown[] };

/** Plays the synthetic session as the face, in a loop, at its own rate (30 a second). */
async function feedTracking(page: Page): Promise<void> {
  await page.evaluate((frames) => {
    const s = (window as any).mochiStudio;
    let i = 0;
    (window as any).shotFeed = setInterval(() => {
      const f = frames[i++ % frames.length] as Record<string, unknown>;
      // The face stays found: the session's lost face would show the idle animation.
      s.feedFrame({ ...f, t: performance.now(), face: true });
    }, 33);
  }, fixture.frames);
}

/** Waits for the toasts to go and the model to settle, then takes the picture. */
async function shoot(page: Page, file: string): Promise<void> {
  await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
  await page.waitForTimeout(600);
  const path = join(DIR, file);
  await page.screenshot({ path, type: 'png' });
  // Small enough for the README, and not an empty page.
  const size = statSync(path).size;
  expect(size, file).toBeGreaterThan(20_000);
  expect(size, file).toBeLessThan(400_000);
}

async function openWithSample(): Promise<Page> {
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  (page as any).errors = errors;
  await page.goto(H.url);
  await page.waitForFunction(() => 'mochiStudio' in window);
  await page.locator('#try-sample').click();
  await page.waitForFunction(() => (window as any).mochiStudio.settings !== undefined);
  return page;
}

describe('the README screenshots', () => {
  it('takes them with the sample model', { timeout: 120_000 }, async () => {
    if (UPDATE) mkdirSync(DIR, { recursive: true });
    const page = await openWithSample();
    await feedTracking(page);
    await expect
      .poll(() => page.evaluate(() => (window as any).mochiStudio.lastInputs.HeadRoll))
      .not.toBeUndefined();

    // Beside the settings sheet (on the right), and whole.
    const place = (transform: Record<string, number>) =>
      page.evaluate((t) => (window as any).mochiStudio.updateSettings({ transform: t }), transform);
    await place({ x: -0.36, y: 0.04, zoom: 0.8, rotation: 0 });
    // A plain background, in the window and the output view alike.
    await page.evaluate(() =>
      (window as any).mochiStudio.setStage({ background: { kind: 'color', color: '#e4e8f0' } }),
    );

    // 1. The main window: Mochi on the stage, the Camera tab with the tracked inputs.
    await openSection(page, 'Tracking');
    await page.evaluate(() =>
      [...document.querySelectorAll('h3')]
        .find((e) => e.textContent === 'Live inputs')!
        .scrollIntoView({ block: 'start' }),
    );
    await shoot(page, 'main-window.png');

    // 2. The mapping editor.
    await openSection(page, 'Mapping');
    await page.locator('.rule').first().scrollIntoViewIfNeeded();
    await shoot(page, 'mapping-editor.png');
    await page.keyboard.press('Escape');

    // 3. Hotkeys, with on-screen buttons on the stage.
    await page.evaluate(() => {
      const s = (window as any).mochiStudio;
      s.updateSettings({
        hotkeys: [
          {
            id: 'sway',
            label: 'Sway',
            keys: 'KeyQ',
            button: true,
            action: { type: 'motion', motion: { group: 'Idle', index: 0 }, mode: 'once' },
          },
          {
            id: 'calibrate',
            label: 'Calibrate',
            keys: 'ControlLeft+KeyK',
            button: true,
            action: { type: 'calibrate' },
          },
        ],
      });
    });
    await openSection(page, 'Hotkeys');
    await shoot(page, 'hotkeys.png');
    await page.keyboard.press('Escape');

    // 4. The output view as OBS captures it: the model alone.
    await place({ x: 0, y: 0.04, zoom: 0.8, rotation: 0 });
    const view = await ctx.newPage();
    await view.goto(new URL('output.html', H.url).href);
    await view.waitForFunction(() => document.body.dataset.model?.startsWith('mochi.model3.json'));
    await shoot(view, 'output-view.png');
    await view.close();

    expect((page as any).errors).toEqual([]);
    await page.close();
  });

  it('are the ones the README shows', () => {
    const readme = readFileSync('README.md', 'utf8');
    for (const f of SHOTS) {
      expect(readme).toContain(`docs/screenshots/${f}`);
      expect(existsSync(join('docs/screenshots', f)), f).toBe(true);
    }
  });
});
