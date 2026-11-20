import { existsSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { startHarness, syntheticModelZip, type Harness, openSection } from './harness';

let H: Harness;
beforeAll(async () => {
  H = await startHarness();
});
afterAll(async () => {
  await H?.close();
});

const zip = {
  name: 'Test.zip',
  mimeType: 'application/zip',
  buffer: Buffer.from(syntheticModelZip()),
};
const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/synthetic-session.json', import.meta.url), 'utf8'),
);

async function openStudio(): Promise<Page> {
  const page = await H.context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(H.url);
  await page.waitForFunction(() => 'mochiStudio' in window);
  (page as unknown as { errors: string[] }).errors = errors;
  return page;
}

async function loadZip(page: Page): Promise<void> {
  await page.locator('#model-zip').setInputFiles(zip);
  await page.waitForFunction(() => (window as any).mochiStudio.settings !== undefined);
}

describe('Mochi Studio in Chromium', () => {
  it('loads a zip model and shows its info and default mapping', async () => {
    const page = await openStudio();
    await loadZip(page);
    await expect
      .poll(() => page.locator('.model-info dd').first().textContent())
      .toBe('test.model3.json');
    await openSection(page, 'Mapping');
    // 8 of the standard parameters exist in the synthetic model.
    expect(await page.locator('.rule').count()).toBe(8);
    expect((page as any).errors).toEqual([]);
    await page.close();
  });

  it('drives parameters from recorded tracking data', async () => {
    const page = await openStudio();
    await loadZip(page);
    const result = await page.evaluate((frames) => {
      const s = (window as any).mochiStudio;
      s.stop();
      const out: Array<Record<string, number>> = [];
      for (const f of frames) {
        s.feedFrame(f);
        s.frame(f.t + 100_000);
        out.push({ ...s.lastParams });
      }
      return { at2_5: out[75], at3_5: out[105], blink: out[124], lost: s.faceVisible };
    }, fixture.frames);
    expect(result.at2_5!.ParamAngleX).toBeLessThan(-15);
    expect(result.at3_5!.ParamAngleX).toBeGreaterThan(15);
    expect(result.blink!.ParamEyeLOpen).toBeLessThan(0.3);
    await page.close();
  });

  it('keeps the output view in sync: model, parameters, background', async () => {
    const page = await openStudio();
    await loadZip(page);
    const out = await H.context.newPage();
    await out.goto(new URL('output.html', H.url).href);
    await out.waitForFunction(() => document.body.dataset.model?.startsWith('test.model3.json'));
    await expect.poll(() => page.locator('#views-indicator').textContent()).toBe('Output views: 1');
    // Choose a chroma-key background in the control window.
    await openSection(page, 'Output');
    await page.locator('#panel-output select').first().selectOption('chroma');
    await out.waitForFunction(() => document.body.dataset.background === 'chroma');
    expect(
      await out.evaluate(() => getComputedStyle(document.getElementById('bg')!).backgroundColor),
    ).toBe('rgb(0, 255, 0)');
    // Parameters arrive.
    await page.evaluate(() => ((window as any).mochiStudio.overrides = { ParamCustom: 0.42 }));
    await out.waitForFunction(() => (window as any).mochiOutput.params.ParamCustom === 0.42);
    // The output page is transparent by default and shows no UI.
    expect(await out.locator('button, input, select').count()).toBe(0);
    await out.close();
    await expect.poll(() => page.locator('#views-indicator').textContent()).toBe('No output view');
    await page.close();
  });

  it('fires hotkeys from the keyboard and on-screen buttons, and saves them per model', async () => {
    const page = await openStudio();
    await loadZip(page);
    await page.evaluate(() => {
      const s = (window as any).mochiStudio;
      s.updateSettings({
        hotkeys: [
          {
            id: 'h1',
            label: 'Blush',
            keys: 'Ctrl+KeyB',
            button: true,
            action: { type: 'expression', expression: 'Blush' },
          },
          {
            id: 'h2',
            label: 'Wave',
            keys: 'KeyW',
            button: true,
            action: { type: 'motion', motion: { group: 'Wave', index: 0 }, mode: 'once' },
          },
        ],
      });
      return s.flushSave();
    });
    await page.locator('#stage').click();
    await page.keyboard.press('Control+KeyB');
    expect(await page.evaluate(() => [...(window as any).mochiStudio.activeExpressions])).toEqual([
      'Blush',
    ]);
    await expect
      .poll(() => page.locator('.hotkey-buttons [data-hotkey=h1]').getAttribute('aria-pressed'))
      .toBe('true');
    await page.locator('.hotkey-buttons [data-hotkey=h1]').click();
    expect(await page.evaluate(() => [...(window as any).mochiStudio.activeExpressions])).toEqual(
      [],
    );
    // Motion: finished event after its 0.5 s duration.
    const finished = page.evaluate(
      () =>
        new Promise((r) =>
          (window as any).mochiStudio.events.on('motionFinished', (p: unknown) => r(p)),
        ),
    );
    await page.keyboard.press('KeyW');
    expect(await finished).toEqual({ motion: { group: 'Wave', index: 0 } });

    // Saved in IndexedDB: a fresh page that loads the same model gets them back.
    await page.reload();
    await page.waitForFunction(() => 'mochiStudio' in window);
    await loadZip(page);
    expect(await page.locator('.hotkey-buttons .hk').count()).toBe(2);
    await page.close();
  });

  it('exports settings as a JSON file', async () => {
    const page = await openStudio();
    await loadZip(page);
    await openSection(page, 'Model');
    const [d] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export…' }).click(),
    ]);
    const path = await d.path();
    const json = JSON.parse(readFileSync(path!, 'utf8'));
    expect(json.format).toBe('mochi-studio/model-settings');
    expect(json.mapping.length).toBe(8);
    await page.close();
  });

  it('shows clearly when the microphone is on', async () => {
    const page = await openStudio();
    await openSection(page, 'Audio');
    await page.locator('#mic-toggle').click();
    await expect.poll(() => page.locator('#mic-indicator').getAttribute('data-on')).toBe('true');
    expect(await page.locator('#mic-indicator').textContent()).toContain('Microphone on');
    await page.locator('#mic-toggle').click();
    await expect.poll(() => page.locator('#mic-indicator').getAttribute('data-on')).toBe('false');
    await page.close();
  });

  // What the preview serves: the build's copy (build after `npm run fetch:models`).
  it.skipIf(!existsSync('dist/mediapipe/face_landmarker.task'))(
    'runs MediaPipe on the fake camera and shows when the camera is on',
    async () => {
      const page = await openStudio();
      await openSection(page, 'Tracking');
      await page.locator('#camera-toggle').click();
      await expect
        .poll(() => page.locator('#cam-indicator').getAttribute('data-on'), { timeout: 30_000 })
        .toBe('true');
      // The fake camera shows no face; the tracker still runs.
      await expect
        .poll(() => page.evaluate(() => (window as any).mochiStudio.trackerRate), {
          timeout: 30_000,
        })
        .toBeGreaterThan(0);
      expect(await page.locator('#face-indicator').textContent()).toBe('No face');
      await page.locator('#camera-toggle').click();
      // Without a graphics card MediaPipe runs on the CPU: a read can wait for a detection.
      await expect
        .poll(() => page.locator('#cam-indicator').getAttribute('data-on'), { timeout: 10_000 })
        .toBe('false');
      await page.close();
    },
  );

  it('draws at a lower frame rate while an output view loads a model', async () => {
    const page = await openStudio();
    const fps = () => page.evaluate(() => (window as any).mochiStudio.limiter.fps);
    const normal = await fps();
    const status = (state: string) =>
      page.evaluate(
        (state) =>
          (window as any).mochiStudio.onSync({
            type: 'viewStatus',
            viewId: 'v1',
            state,
            loaded: 0,
            total: 1,
            ms: 0,
          }),
        state,
      );
    await status('loading');
    expect(await fps()).toBe(2);
    await status('ready');
    expect(await fps()).toBe(normal);
    // A view that leaves while loading lifts it too.
    await status('loading');
    await page.evaluate(() => (window as any).mochiStudio.onSync({ type: 'bye', viewId: 'v1' }));
    expect(await fps()).toBe(normal);
    await page.close();
  });
});
