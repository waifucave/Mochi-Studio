import type { Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openSection, startHarness, syntheticModelZip, type Harness } from './harness';

/**
 * Output views get the parameters whatever the
 * control window is doing. A hidden, minimized or covered window gets no
 * animation frames; the frame clock (src/web/frameClock.ts) then runs the
 * frames on a worker's ticks, so OBS keeps moving.
 */
let H: Harness;
let page: Page;
let out: Page;
const errors: string[] = [];

const outParam = (id: string) =>
  out.evaluate((id) => (window as any).mochiOutput.runtime.parameterValue(id), id);

beforeAll(async () => {
  H = await startHarness();
  page = await H.context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(H.url);
  await page.waitForFunction(() => 'mochiStudio' in window);
  await page.locator('#model-zip').setInputFiles({
    name: 'Test.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(syntheticModelZip()),
  });
  await page.waitForFunction(() => (window as any).mochiStudio.settings !== undefined);
}, 60_000);
afterAll(async () => {
  await H?.close();
});

describe('output views while the control window is out of sight', () => {
  it('keeps sending the parameters with no animation frames in the control window', async () => {
    // As a hidden or minimized window: animation frames stop altogether.
    await page.evaluate(() => {
      const s = (window as any).mochiStudio;
      s.stop();
      window.requestAnimationFrame = () => 0;
      s.start();
      s.setOverrides({ ParamMouthOpenY: 1 });
    });
    // An output view opens meanwhile (the control window behind it).
    out = await H.context.newPage();
    out.on('pageerror', (e) => errors.push(`output: ${e.message}`));
    await out.goto(new URL('output.html', H.url).href);
    await out.waitForFunction(() => document.body.dataset.model?.startsWith('test.model3.json'));
    await expect.poll(() => outParam('ParamMouthOpenY'), { timeout: 10_000 }).toBeCloseTo(1, 2);
    // Changes keep coming, from the worker's ticks.
    await page.evaluate(() => (window as any).mochiStudio.setOverrides({ ParamMouthOpenY: 0.3 }));
    await expect.poll(() => outParam('ParamMouthOpenY'), { timeout: 10_000 }).toBeCloseTo(0.3, 2);
    // The frames run on the worker's ticks (they no longer draw, so the view can be ready
    // after fewer of them).
    await expect
      .poll(() => page.evaluate(() => (window as any).mochiStudio.backgroundFrames))
      .toBeGreaterThan(10);
    // About 30 frames a second, not the once a second a background page's own timers get.
    const t0 = await page.evaluate(() => (window as any).mochiStudio.backgroundFrames);
    await page.waitForTimeout(1000);
    const t1 = await page.evaluate(() => (window as any).mochiStudio.backgroundFrames);
    expect(t1 - t0).toBeGreaterThan(15);
    expect(errors).toEqual([]);
  });

  it('runs on animation frames alone while the control window is drawn', async () => {
    const fresh = await H.context.newPage();
    await fresh.goto(H.url);
    await fresh.waitForFunction(() => 'mochiStudio' in window);
    await fresh.bringToFront();
    // Before it came to the front it was out of sight: count from now.
    await fresh.waitForTimeout(300);
    const before = await fresh.evaluate(() => (window as any).mochiStudio.backgroundFrames);
    await fresh.waitForTimeout(1500);
    // Drawn: the worker's ticks run no frames.
    expect(await fresh.evaluate(() => (window as any).mochiStudio.backgroundFrames)).toBe(before);
    await fresh.close();
  });
});

describe('the mouse, the controller and the other known inputs', () => {
  let p: Page;
  const input = (id: string) =>
    p.evaluate((id) => (window as any).mochiStudio.lastInputs[id] as number | undefined, id);
  const param = (id: string) =>
    p.evaluate((id) => (window as any).mochiStudio.runtime.parameterValue(id) as number, id);
  const blush = () =>
    p.evaluate(() => (window as any).mochiStudio.activeExpressions.has('Blush') as boolean);
  const press = (i: number, v = 1) => p.evaluate(([i, v]) => (window as any).press(i, v), [i, v]);
  const stick = (axes: number[]) => p.evaluate((a) => ((window as any).testPad.axes = a), axes);

  beforeAll(async () => {
    p = await H.context.newPage();
    p.on('pageerror', (e) => errors.push(`inputs page: ${e.message}`));
    // A stand-in for the browser's Gamepad API: one standard controller the test moves.
    await p.addInitScript(() => {
      const w = window as any;
      const buttons = Array.from({ length: 17 }, () => ({ pressed: false, value: 0 }));
      w.testPad = {
        id: 'Test Pad (STANDARD GAMEPAD)',
        index: 0,
        connected: true,
        mapping: 'standard',
        axes: [0, 0, 0, 0],
        buttons,
      };
      w.testPads = [w.testPad];
      Object.defineProperty(navigator, 'getGamepads', {
        value: () => w.testPads,
        configurable: true,
      });
      w.press = (i: number, v: number) => (buttons[i] = { pressed: v >= 0.5, value: v });
    });
    await p.goto(H.url);
    await p.waitForFunction(() => 'mochiStudio' in window);
    await p.locator('#model-zip').setInputFiles({
      name: 'Test.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(syntheticModelZip()),
    });
    await p.waitForFunction(() => (window as any).mochiStudio.settings !== undefined);
  }, 60_000);
  afterAll(async () => {
    await p?.close();
  });

  it('offers the documented inputs in the mapping editor, with their ranges', async () => {
    await openSection(p, 'Mapping');
    const offered = await p
      .locator('#dl-inputs option')
      .evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
    for (const id of [
      'HandLeftFinger_1_Thumb',
      'ControllerStickLeftX',
      'ControllerOrientationZ',
      'MousePositionY',
      'MocopiLowerLegRightAngleZ',
      'VoiceFrequency',
      'VoiceVolumePlusMouthOpen',
    ])
      expect(offered, id).toContain(id);
    // Choosing one gives the mapping its documented range.
    const first = p.locator('.mapping .rule .in-id').first();
    await first.fill('MocopiUpperArmLeftAngleY');
    await first.dispatchEvent('change');
    await expect
      .poll(() =>
        p.evaluate(() => {
          const r = (window as any).mochiStudio.settings.mapping[0];
          return [r.input, r.inMin, r.inMax];
        }),
      )
      .toEqual(['MocopiUpperArmLeftAngleY', -90, 90]);
    // No mocopi in Mochi Studio: no value, like an absent plugin's input.
    expect(await input('MocopiUpperArmLeftAngleY')).toBeUndefined();
    await p.keyboard.press('Escape');
  });

  it('follows the mouse pointer over the page, within the ranges set', async () => {
    await p.evaluate(() =>
      (window as any).mochiStudio.updateSettings({
        mapping: [
          {
            id: 'mx',
            enabled: true,
            input: 'MousePositionX',
            output: 'ParamAngleX',
            inMin: -1,
            inMax: 1,
            outMin: -30,
            outMax: 30,
            invert: false,
            clamp: true,
            smoothing: 0,
          },
        ],
      }),
    );
    const { width, height } = p.viewportSize()!;
    await p.mouse.move(width * 0.75, height * 0.25);
    await expect.poll(() => input('MousePositionX')).toBeCloseTo(0.5, 2);
    expect(await input('MousePositionY')).toBeCloseTo(0.5, 2);
    // Half-way right turns the head about half-way (other movements may add a little).
    await expect
      .poll(async () => Math.abs((await param('ParamAngleX')) - 15) < 4, { timeout: 8_000 })
      .toBe(true);
    await p.mouse.move(width * 0.5, height - 1);
    await expect.poll(() => input('MousePositionY')).toBeCloseTo(-1, 2);
    // A range of half the page's width: a quarter of the way out is the edge already.
    await openSection(p, 'Tracking');
    await p.locator('#mouse-range-x').fill(String(Math.round(width / 2)));
    await p.locator('#mouse-range-x').dispatchEvent('change');
    await p.mouse.move(width * 0.75, height * 0.5);
    await expect.poll(() => input('MousePositionX')).toBeCloseTo(1, 2);
    await p.mouse.move(width * 0.625, height * 0.5);
    await expect.poll(() => input('MousePositionX')).toBeCloseTo(0.5, 2);
    expect(await p.locator('#mouse-range-hint').textContent()).toContain('middle of the page');
    await expect
      .poll(() =>
        p.evaluate(async () => (await (window as any).mochiStudio.store.getApp()).mouseRange),
      )
      .toEqual({ width: Math.round(width / 2), height: 0 });
    await p.keyboard.press('Escape');
  });

  it('reads a controller: sticks, buttons and triggers, and the choice of controllers', async () => {
    await stick([0, -1, 0.5, 0]);
    await press(0);
    await press(7, 0.6);
    await expect.poll(() => input('ControllerStickLeftY')).toBeCloseTo(1, 2);
    expect(await input('ControllerCross')).toBe(1);
    expect(await input('ControllerTriggerRight')).toBeCloseTo(0.6, 5);
    expect(await input('ControllerButtonCountRight')).toBe(2);
    expect(await input('ControllerStickRightX')).toBeCloseTo((0.5 - 0.1) / 0.9, 3);
    // No touchpad or orientation from this browser: those inputs are absent.
    expect(await input('ControllerTouchPadTouchCount')).toBeUndefined();
    expect(await input('ControllerOrientationX')).toBeUndefined();
    // The Camera tab lists it; "No controller" turns the inputs off, the name back on.
    await openSection(p, 'Tracking');
    await expect
      .poll(() => p.locator('#controller-status').textContent())
      .toContain('One controller');
    expect(
      await p
        .locator('#controller-choice option')
        .evaluateAll((os) => os.map((o) => o.textContent)),
    ).toEqual(['No controller', 'All controllers', 'Test Pad (STANDARD GAMEPAD)']);
    await p.locator('#controller-choice').selectOption('none');
    await expect.poll(() => input('ControllerCross')).toBeUndefined();
    await p.locator('#controller-choice').selectOption('Test Pad (STANDARD GAMEPAD)');
    await expect.poll(() => input('ControllerCross')).toBe(1);
    await expect
      .poll(() =>
        p.evaluate(async () => (await (window as any).mochiStudio.store.getApp()).controller),
      )
      .toBe('Test Pad (STANDARD GAMEPAD)');
    await p.keyboard.press('Escape');
    await press(0, 0);
    await press(7, 0);
    await stick([0, 0, 0, 0]);
    // The frames see the controller let go (they read it about 30 or 60 times a second).
    await expect.poll(() => input('ControllerButtonCountRight')).toBe(0);
    await expect.poll(() => input('ControllerStickLeftY')).toBe(0);
  });

  it('makes controller buttons and stick directions hotkey keys, alone or with a key', async () => {
    await p.evaluate(() =>
      (window as any).mochiStudio.updateSettings({
        hotkeys: [
          {
            id: 'pad',
            label: 'Blush on Cross',
            keys: 'PadCross',
            button: false,
            action: { type: 'expression', expression: 'Blush' },
            release: 'hold',
          },
          {
            id: 'chord',
            label: 'Blush on Q and the stick up',
            keys: 'KeyQ+PadLeftStickUp',
            button: false,
            action: { type: 'expression', expression: 'Blush' },
          },
          {
            id: 'set',
            label: 'Set by pressing',
            keys: '',
            button: false,
            action: { type: 'calibrate' },
          },
        ],
      }),
    );
    expect(await blush()).toBe(false);
    await press(0);
    await expect.poll(blush).toBe(true);
    await press(0, 0);
    await expect.poll(blush).toBe(false);
    // With a keyboard key held.
    await p.keyboard.down('KeyQ');
    await stick([0, -0.9, 0, 0]);
    await expect.poll(blush).toBe(true);
    await stick([0, 0, 0, 0]);
    await expect.poll(() => input('ControllerStickLeftY')).toBe(0);
    await p.keyboard.up('KeyQ');
    // Recording a hotkey's keys: press a controller button.
    await openSection(p, 'Hotkeys');
    const keycap = p.locator('[data-hotkey="set"] .keycap');
    await keycap.click();
    await press(3);
    await p.waitForTimeout(100);
    await press(3, 0);
    await expect
      .poll(() =>
        p.evaluate(
          () => (window as any).mochiStudio.settings.hotkeys.find((h: any) => h.id === 'set').keys,
        ),
      )
      .toBe('PadTriangle');
    await expect.poll(() => keycap.textContent()).toBe('Controller Triangle (Y)');
    await p.keyboard.press('Escape');
    expect(errors).toEqual([]);
  });

  it('gives the combined voice inputs: the tracked mouth without a microphone', async () => {
    await p.evaluate(() => {
      const w = window as any;
      w.faceFeed = setInterval(
        () =>
          w.mochiStudio.feedFrame({
            t: performance.now(),
            face: true,
            blendshapes: { jawOpen: 0.6, mouthSmileLeft: 1, mouthSmileRight: 1 },
          }),
        33,
      );
    });
    await expect.poll(() => input('VoiceVolumePlusMouthOpen')).toBeCloseTo(0.6, 1);
    expect(await input('VoiceFrequencyPlusMouthSmile')).toBeGreaterThan(0.9);
    // No vowel analysis: no VoiceFrequency.
    expect(await input('VoiceFrequency')).toBeUndefined();
    await p.evaluate(() => clearInterval((window as any).faceFeed));
    // The weights live in the model's lipsync settings.
    await p.evaluate(() =>
      (window as any).mochiStudio.run('set_lip_sync', { frequencyWeights: { A: -0.9, O: 0.9 } }),
    );
    expect(
      await p.evaluate(() => (window as any).mochiStudio.settings.lipSync.frequencyWeights),
    ).toEqual({ A: -0.9, I: 0.5, U: -0.4, E: 0.3, O: 0.9 });
    expect(errors).toEqual([]);
  });
});
