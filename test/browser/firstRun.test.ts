import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BrowserContext, Page } from 'playwright-core';
import { startHarness, syntheticModelZip, type Harness, openSection } from './harness';

/**
 * The first run: a fresh browser profile, the getting-started guide, the
 * empty stage, and messages that say what to do when something fails.
 */
let H: Harness;
let ctx: BrowserContext;
beforeAll(async () => {
  H = await startHarness();
  // Nothing stored yet, as on a first visit.
  ctx = await H.browser.newContext({
    permissions: ['camera', 'microphone'],
    viewport: { width: 1280, height: 800 },
  });
});
afterAll(async () => {
  await ctx?.close();
  await H?.close();
});

const steps = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('#guide .guide-step')].map(
      (e) => `${e.dataset.step}:${e.dataset.status}`,
    ),
  );

describe('the first run', () => {
  it('guides from an empty stage to the output, and explains failures', async () => {
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(H.url);
    await page.waitForFunction(() => 'mochiStudio' in window);

    // The guide and the empty stage say what to do first.
    await expect.poll(() => page.locator('#guide').isVisible()).toBe(true);
    expect(await steps(page)).toEqual([
      'model:current',
      'camera:todo',
      'calibrate:todo',
      'obs:todo',
    ]);
    expect(await page.locator('#stage-empty').isVisible()).toBe(true);
    expect(await page.locator('#stage-empty').textContent()).toContain('.model3.json');

    // A zip that is not a model: the message says what to choose instead.
    await page.locator('#model-zip').setInputFiles({
      name: 'Photos.zip',
      mimeType: 'application/zip',
      // An empty zip archive (an end-of-central-directory record only).
      buffer: Buffer.from([0x50, 0x4b, 0x05, 0x06, ...new Array<number>(18).fill(0)]),
    });
    await expect.poll(() => page.locator('.toast').textContent()).toMatch(/model3\.json|zip/i);

    // Load a model: the next step is the camera.
    await page.locator('#model-zip').setInputFiles({
      name: 'Test.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(syntheticModelZip()),
    });
    await page.waitForFunction(() => (window as any).mochiStudio.settings !== undefined);
    await expect
      .poll(() => steps(page))
      .toEqual(['model:done', 'camera:current', 'calibrate:todo', 'obs:todo']);
    expect(await page.locator('#stage-empty').isVisible()).toBe(false);
    expect(await page.locator('#guide [data-step=camera]').getByRole('button').textContent()).toBe(
      'Start camera',
    );

    // A blocked microphone: the message says where to allow it.
    await page.evaluate(() => {
      navigator.mediaDevices.getUserMedia = () =>
        Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
    });
    await openSection(page, 'Audio');
    await page.locator('#mic-toggle').click();
    await expect.poll(() => page.locator('.toast').textContent()).toMatch(/Allow it|Privacy/);
    expect(await page.locator('#mic-indicator').getAttribute('data-on')).toBe('false');

    // The camera step, as if the camera had found a face (no camera here).
    await page.evaluate(() => {
      const s = (window as any).mochiStudio;
      Object.defineProperty(s, 'cameraOn', { get: () => true, configurable: true });
      s.events.emit('cameraChanged', { on: true });
      s.events.emit('trackingFound', undefined);
    });
    await expect
      .poll(() => steps(page))
      .toEqual(['model:done', 'camera:done', 'calibrate:current', 'obs:todo']);
    // A failed calibration says why.
    await page.evaluate(() =>
      (window as any).mochiStudio.events.emit('calibration', { state: 'failed' }),
    );
    expect(await page.locator('#guide .guide-error').textContent()).toContain('No face');

    // The output step: in a browser, it turns on bridge views and says to start the bridge.
    await page.evaluate(() => {
      const s = (window as any).mochiStudio;
      s.updateSettings({ calibration: { headYaw: 0 } });
      s.events.emit('calibration', { state: 'done' });
    });
    await expect.poll(() => steps(page)).toContain('obs:current');
    // A view in this browser does not count: the step is about OBS (through the bridge).
    await page.evaluate(() =>
      (window as any).mochiStudio.onSync({ type: 'hello', viewId: 'same-browser' }),
    );
    expect(await page.evaluate(() => (window as any).mochiStudio.outputViewCount)).toBe(1);
    expect(await steps(page)).toContain('obs:current');
    expect(await page.locator('#guide [data-step=obs]').textContent()).toContain('npm run bridge');
    await page.locator('#guide [data-step=obs]').getByRole('button').click();
    expect(await page.locator('[role=tab][aria-selected=true]').textContent()).toBe('Camera');
    expect(await page.evaluate(() => (window as any).mochiAgentLink.viewsOn)).toBe(true);
    await expect
      .poll(() => page.locator('#views-status').textContent(), { timeout: 10_000 })
      .toMatch(/npm run bridge|Connecting/);
    await page.evaluate(() => (window as any).mochiAgentLink.disableViews());

    // Hidden, the guide stays hidden after a reload; the Guide button brings it back.
    await page.locator('#guide-hide').click();
    expect(await page.locator('#guide').isVisible()).toBe(false);
    await page.reload();
    await page.waitForFunction(() => 'mochiStudio' in window);
    expect(await page.locator('#guide').isVisible()).toBe(false);
    await page.locator('#guide-toggle').click();
    expect(await page.locator('#guide').isVisible()).toBe(true);
    expect(errors).toEqual([]);
    await page.close();
  });
  it('loads the sample model in one step, from the empty stage or the guide', async () => {
    const fresh = await H.browser.newContext({ viewport: { width: 1280, height: 800 } });
    const errors: string[] = [];
    const open = async (url = H.url) => {
      const page = await fresh.newPage();
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(url);
      await page.waitForFunction(() => 'mochiStudio' in window);
      return page;
    };
    const loaded = (page: Page) =>
      page.waitForFunction(() => (window as any).mochiStudio.settings !== undefined);
    const params = (page: Page) =>
      page.evaluate(() => (window as any).mochiStudio.info.parameters.map((p: any) => p.id));

    // The empty stage's button.
    const page = await open();
    await page.locator('#try-sample').click();
    await loaded(page);
    expect(await params(page)).toEqual(
      expect.arrayContaining([
        'ParamAngleZ',
        'ParamEyeLOpen',
        'ParamEyeROpen',
        'ParamMouthOpenY',
        'ParamHairFront',
      ]),
    );
    expect(await page.locator('#stage-empty').isVisible()).toBe(false);
    expect(await page.evaluate(() => (window as any).mochiStudio.model.files.label)).toBe(
      'Mochi (sample)',
    );
    expect(await steps(page)).toContain('model:done');
    // Its Idle group plays by itself, as an idle animation: a found face's tilt wins over it.
    await page.evaluate(() => {
      const s = (window as any).mochiStudio;
      const a = (20 * Math.PI) / 180;
      const [c, n] = [Math.cos(a), Math.sin(a)];
      (window as any).tilt = setInterval(
        () =>
          s.feedFrame({
            t: performance.now(),
            face: true,
            blendshapes: {},
            matrix: [c, n, 0, 0, -n, c, 0, 0, 0, 0, 1, 0, 0, 0, -40, 1],
          }),
        33,
      );
    });
    await openSection(page, 'Mapping');
    await expect
      .poll(() => page.locator('.rule[data-output="ParamAngleZ"] .source').textContent())
      .toBe('Driven by tracking (HeadRoll); it overrides the idle animation idle.motion3.json.');
    await expect
      .poll(() =>
        page.evaluate(() => (window as any).mochiStudio.runtime.idleWeight('ParamAngleZ')),
      )
      .toBe(0);
    await page.evaluate(() => clearInterval((window as any).tilt));
    await page.keyboard.press('Escape');
    // Output views get it like any model.
    const view = await fresh.newPage();
    await view.goto(new URL('output.html', H.url).href);
    await view.waitForFunction(() => document.body.dataset.model?.startsWith('mochi.model3.json'));
    await view.close();
    await page.close();

    // The guide's button, in a profile with nothing stored.
    const again = await H.browser.newContext({ viewport: { width: 1280, height: 800 } });
    const g = await again.newPage();
    await g.goto(H.url);
    await g.waitForFunction(() => 'mochiStudio' in window);
    await g
      .locator('#guide [data-step=model]')
      .getByRole('button', { name: 'Try the sample model' })
      .click();
    await loaded(g);
    expect(await params(g)).toContain('ParamHairFront');
    await again.close();

    // And by address, as any model.
    const byUrl = await open(`${H.url}?model=samples/mochi/mochi.model3.json`);
    await loaded(byUrl);
    expect(await params(byUrl)).toContain('ParamAngleZ');
    expect(errors).toEqual([]);
    await fresh.close();
  });
});
