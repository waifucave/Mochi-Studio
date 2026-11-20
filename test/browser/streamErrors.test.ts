import { readFileSync } from 'node:fs';
import type { Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, syntheticModelZip, type Harness } from './harness';

/**
 * Errors during a stream. A failing step of a
 * frame never stops the stage or an output view; errors go to the log, once
 * while they repeat; the log saves as a file for a bug report, with nothing
 * personal in it.
 */
let H: Harness;
let page: Page;
const pageErrors: string[] = [];
const frames = (p: Page, g = 'mochiStudio') =>
  p.evaluate((g) => (window as any)[g].framesDrawn as number, g);
const logged = () =>
  page.evaluate(() =>
    (window as any).mochiLog.entries.map((e: any) => ({ text: e.text, count: e.count })),
  ) as Promise<{ text: string; count: number }[]>;

beforeAll(async () => {
  H = await startHarness();
  page = await H.context.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(H.url);
  await page.waitForFunction(() => 'mochiStudio' in window);
  await page.locator('#model-zip').setInputFiles({
    name: 'Test.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(syntheticModelZip()),
  });
  // Loaded and said so (that toast comes a moment after the first frame).
  await page.waitForFunction(() =>
    (window as any).mochiLog.entries.some((e: any) => e.text.startsWith('Loaded')),
  );
});
afterAll(async () => {
  await H?.close();
});

describe('errors never stop the stream', () => {
  it('logs a failing frame step once, and keeps drawing', async () => {
    await page.evaluate(() => {
      const rt = (window as any).mochiStudio.runtime;
      rt.lipSyncLevelSaved = rt.lipSyncLevel;
      rt.lipSyncLevel = () => {
        throw new Error('meter broke reading /home/somebody/mic.cfg');
      };
    });
    const before = await frames(page);
    await expect.poll(() => frames(page), { timeout: 5000 }).toBeGreaterThan(before + 20);
    const entries = (await logged()).filter((e) => e.text.startsWith('The microphone:'));
    expect(entries, JSON.stringify(await logged())).toHaveLength(1);
    expect(entries[0]!.text).toBe('The microphone: meter broke reading /home/…/mic.cfg');
    expect(entries[0]!.count).toBeGreaterThan(10);
    // Shown once as a toast, too.
    expect(await page.locator('.toast').textContent()).toContain('The microphone');
    // The rest of the frame still runs: tracking still reaches the model.
    await page.evaluate(() =>
      (window as any).mochiStudio.feedFrame({
        t: performance.now(),
        face: true,
        blendshapes: { jawOpen: 1 },
      }),
    );
    await expect
      .poll(() => page.evaluate(() => (window as any).mochiStudio.lastParams?.ParamMouthOpenY ?? 0))
      .toBeGreaterThan(0.5);
    await page.evaluate(() => {
      const rt = (window as any).mochiStudio.runtime;
      rt.lipSyncLevel = rt.lipSyncLevelSaved;
    });
  });

  it('keeps an output view drawing through errors, and logs them in the window', async () => {
    const view = await H.context.newPage();
    await view.goto(new URL('output.html', H.url).href);
    await view.waitForFunction(() => !!document.body.dataset.model);
    await view.evaluate(() => {
      const rt = (window as any).mochiOutput.runtime;
      rt.setParameters = () => {
        throw new Error('view parameters broke');
      };
    });
    const before = await frames(view, 'mochiOutput');
    await expect
      .poll(() => frames(view, 'mochiOutput'), { timeout: 5000 })
      .toBeGreaterThan(before + 10);
    await expect
      .poll(async () => (await logged()).map((e) => e.text))
      .toContain('Output view, parameters: view parameters broke');
    // Reported once, not every frame.
    expect(
      (await logged()).filter((e) => e.text.startsWith('Output view, parameters')),
    ).toHaveLength(1);
    await view.close();
    await page.bringToFront();
  });

  it('logs unexpected errors, and saves the log for a bug report without personal data', async () => {
    await page.evaluate(() => {
      setTimeout(() => {
        throw new Error('stray failure for someone@example.org');
      });
      void Promise.reject(new Error('rejected at C:\\Users\\Jane Doe\\Desktop'));
    });
    await expect
      .poll(async () => (await logged()).map((e) => e.text))
      .toEqual(
        expect.arrayContaining([
          'Unexpected error: stray failure for [e-mail]',
          'Unexpected error: rejected at C:\\Users\\…\\Desktop',
        ]),
      );
    await page.locator('#menu-button').click();
    await page.locator('#menu-log').click();
    await expect.poll(() => page.locator('#log-list').textContent()).toContain('(×');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('#log-save').click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^mochi-studio-log-.*\.txt$/);
    const text = readFileSync((await download.path())!, 'utf8');
    expect(text).toContain('Mochi Studio log');
    expect(text).toContain('model: loaded');
    expect(text).toContain('The microphone: meter broke reading /home/…/mic.cfg');
    expect(text).not.toMatch(/somebody|someone@|Jane Doe/);
    // No picture or file data: no long base64 runs.
    expect(text).not.toMatch(/[A-Za-z0-9+/]{120,}/);
    await page.keyboard.press('Escape');
    // The page's own error handler took them: nothing escaped to the browser.
    expect(
      pageErrors.filter((e) => !e.includes('stray failure')),
      JSON.stringify(pageErrors),
    ).toEqual([]);
  });
});
