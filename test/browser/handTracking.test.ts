import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VOWEL_FORMANTS, synthesizeVowel } from 'mochi2d/headless';
import type { Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BridgeServer } from '../../bridge/src/server.ts';
import { BridgeStore } from '../../bridge/src/store.ts';
import type { TrackedHand } from '../../src/core/hands';
import { syntheticHand, type SyntheticHandOptions } from '../support/hands';
import { PluginClient } from '../support/pluginClient';
import { openSection, startHarness, syntheticModelZip, type Harness } from './harness';

/**
 * Hand tracking and gesture hotkeys, fed with
 * synthetic hand landmarks (test/support/hands.ts) as a tracker would send
 * them, 30 times a second; and the basic mouth form shaped by the vowels.
 */
let H: Harness;
let bridge: BridgeServer;
let page: Page;
let url: string;
let p1: PluginClient;
const home = mkdtempSync(join(tmpdir(), 'mochi-hands-'));
const pluginPort = 23_700 + Math.floor(Math.random() * 800);
const errors: string[] = [];
// What the preview serves: the build's copy (build after `npm run fetch:models`).
const HAND_MODEL = existsSync('dist/mediapipe/hand_landmarker.task');
const FACE_MODEL = existsSync('dist/mediapipe/face_landmarker.task');

const curled = { Index: 0, Middle: 0, Ring: 0, Pinky: 0 };
const hand = (o: SyntheticHandOptions): TrackedHand => syntheticHand(o);

/** Feeds these hands (no face), 30 times a second, until changed. */
const feed = (hands: TrackedHand[]) =>
  page.evaluate((hands) => {
    const w = window as any;
    w.hands = hands;
    w.handFeed ??= setInterval(
      () =>
        w.mochiStudio.feedFrame({
          t: performance.now(),
          face: false,
          blendshapes: {},
          hands: w.hands,
        }),
      33,
    );
  }, hands);
const stopFeed = () =>
  page.evaluate(() => {
    const w = window as any;
    clearInterval(w.handFeed);
    w.handFeed = undefined;
  });
const inputs = () =>
  page.evaluate(() =>
    Object.fromEntries(
      Object.entries((window as any).mochiStudio.lastInputs as Record<string, number>).filter(
        ([k]) => k.startsWith('Hand') || k === 'BothHandsFound',
      ),
    ),
  );

beforeAll(async () => {
  H = await startHarness();
  const store = new BridgeStore(home);
  bridge = new BridgeServer({
    port: 0,
    store,
    log: () => undefined,
    plugins: { port: pluginPort, broadcastAddress: '127.0.0.1', broadcastPort: 9 },
  });
  const port = await bridge.listen();
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
  await openSection(page, 'Agents');
  await page.locator('#bridge-url').fill(`ws://127.0.0.1:${port}`);
  await page.locator('#plugins-toggle').check();
  await page.locator('#plugins-pair-code').waitFor({ state: 'visible' });
  await page.locator('#plugins-pair-code').fill(store.pairingCode());
  await page.locator('#plugins-pair-code ~ button').click();
  await page.waitForFunction(
    (p) => document.querySelector('#plugins-status')?.textContent?.includes(p),
    `ws://localhost:${pluginPort}`,
  );
  await page.keyboard.press('Escape');
  url = `ws://localhost:${pluginPort}`;
  p1 = await PluginClient.connect(url);
  const id = p1.send('AuthenticationTokenRequest', {
    pluginName: 'Hand Reader',
    pluginDeveloper: 'Tester',
  });
  await page.locator('#plugin-approval').waitFor({ state: 'visible' });
  await page.locator('#plugin-allow').click();
  const t = await p1.next((m) => m.requestID === id, 10_000);
  await p1.request('AuthenticationRequest', {
    pluginName: 'Hand Reader',
    pluginDeveloper: 'Tester',
    authenticationToken: t.data.authenticationToken,
  });
  await page.bringToFront();
}, 60_000);
afterAll(async () => {
  p1?.close();
  await bridge?.close();
  await H?.close();
});

describe('hand tracking', () => {
  it('turns hand landmarks into the hand inputs, and the mapping into parameters', async () => {
    // Mirrored (the default): the subject's left hand drives the avatar's right.
    await feed([hand({ side: 'left', at: [0.75, 0.6] })]);
    await expect.poll(async () => (await inputs()).HandRightFound).toBe(1);
    let i = await inputs();
    expect(i).toMatchObject({ HandLeftFound: 0, BothHandsFound: 0 });
    expect(i.HandRightOpen).toBeCloseTo(1, 1);
    // Out to its own side (X is mirror-symmetric: positive outwards for both hands).
    expect(i.HandRightPositionX).toBeGreaterThan(2);
    // Both hands, one a fist.
    await feed([
      hand({ side: 'left', at: [0.75, 0.6] }),
      hand({ side: 'right', at: [0.25, 0.6], fingers: { ...curled, Thumb: 0.2 } }),
    ]);
    await expect.poll(async () => (await inputs()).BothHandsFound).toBe(1);
    i = await inputs();
    expect(i.HandLeftOpen).toBeLessThan(0.3);
    expect(i.HandLeftFinger_2_Index).toBeLessThan(0.2);
    expect(i.HandDistance).toBeGreaterThan(5);
    // A rule from a hand input moves a parameter.
    await page.evaluate(() => {
      const s = (window as any).mochiStudio;
      s.updateSettings({
        mapping: [
          ...s.settings.mapping,
          {
            id: 'hand',
            enabled: true,
            input: 'HandLeftOpen',
            output: 'ParamCustom',
            inMin: 0,
            inMax: 1,
            outMin: 0,
            outMax: 1,
            invert: false,
            clamp: true,
            smoothing: 0,
          },
        ],
      });
    });
    const custom = () =>
      page.evaluate(() => (window as any).mochiStudio.runtime.parameterValue('ParamCustom'));
    await expect.poll(custom).toBeLessThan(0.3);
    await feed([hand({ side: 'right', at: [0.25, 0.6] })]);
    await expect.poll(custom).toBeGreaterThan(0.8);
    // The mapping editor offers the hand inputs.
    expect(
      await page.evaluate(
        () =>
          (window as any).mochiStudio.settings !== undefined &&
          [...document.querySelectorAll('option')].some(
            (o) => o.value === 'HandLeftFinger_1_Thumb',
          ),
      ),
    ).toBe(true);
  });

  it('chooses what the camera tracks, and shows the hands’ points only, when asked', async () => {
    await openSection(page, 'Tracking');
    expect(await page.locator('#tracking-mode').inputValue()).toBe('face');
    expect(await page.locator('#hand-preview-toggle').count()).toBe(0);
    await page.locator('#tracking-mode').selectOption('both');
    expect(await page.evaluate(() => (window as any).mochiStudio.app.trackingMode)).toBe('both');
    // Off by default; on, it draws points (a canvas), never the camera picture.
    expect(await page.locator('#hand-preview-toggle').isChecked()).toBe(false);
    expect(await page.locator('#hand-preview').isVisible()).toBe(false);
    await feed([hand({ side: 'right', fingers: { ...curled, Index: 1, Thumb: 0.2 } })]);
    await page.locator('#hand-preview-toggle').check();
    await expect.poll(() => page.locator('#hand-preview').isVisible()).toBe(true);
    await expect
      .poll(() => page.locator('#hand-readouts [data-side=right]').textContent())
      .toContain('Point');
    expect(await page.locator('.hands video, .hand-preview video').count()).toBe(0);
    // Kept app-wide.
    await expect
      .poll(() =>
        page.evaluate(async () => (await (window as any).mochiStudio.store.getApp()).handPreview),
      )
      .toBe(true);
    // Without the hand model (npm run fetch:models), starting the camera for the hands says so.
    if (!HAND_MODEL) {
      await page.locator('#tracking-mode').selectOption('hands');
      await page.locator('#camera-toggle').click();
      await expect
        .poll(() =>
          page
            .locator('.toast, #log, [role=status]')
            .allTextContents()
            .then((t) => t.join(' ')),
        )
        .toContain('hand model is missing');
    }
    await page.locator('#tracking-mode').selectOption('face');
    await stopFeed();
    await page.keyboard.press('Escape');
  });

  it.skipIf(!HAND_MODEL)(
    'runs MediaPipe’s hand landmarker on the fake camera, hands only and with the face',
    async () => {
      await openSection(page, 'Tracking');
      await page.locator('#tracking-mode').selectOption('hands');
      await page.locator('#camera-toggle').click();
      await expect
        .poll(() => page.locator('#cam-indicator').getAttribute('data-on'), { timeout: 30_000 })
        .toBe('true');
      // The fake camera shows no hands; the tracker still runs.
      await expect
        .poll(() => page.evaluate(() => (window as any).mochiStudio.trackerRate), {
          timeout: 30_000,
        })
        .toBeGreaterThan(0);
      // Without a graphics card MediaPipe runs on the CPU: a read can wait for a detection.
      const tracking = { timeout: 10_000 };
      await expect
        .poll(
          () => page.evaluate(() => (window as any).mochiStudio.lastInputs.HandLeftFound),
          tracking,
        )
        .toBe(0);
      expect(await page.evaluate(() => (window as any).mochiStudio.handsFound)).toEqual({
        left: false,
        right: false,
      });
      // Switching while the camera runs (the face model too, where it is present).
      if (FACE_MODEL) {
        await page.locator('#tracking-mode').selectOption('both');
        await expect
          .poll(() => page.evaluate(() => (window as any).mochiStudio.app.trackingMode), {
            timeout: 30_000,
          })
          .toBe('both');
      }
      await page.locator('#camera-toggle').click();
      await expect
        .poll(() => page.locator('#cam-indicator').getAttribute('data-on'), tracking)
        .toBe('false');
      await page.locator('#tracking-mode').selectOption('face');
      await page.keyboard.press('Escape');
    },
    90_000,
  );

  it('gives plugins the hand inputs only with tracking-data access, and the status event', async () => {
    // Your left hand is the avatar's right (mirror on): seen first, then subscribed, then gone.
    await feed([hand({ side: 'left' })]);
    await expect.poll(async () => (await inputs()).HandRightFound).toBe(1);
    await p1.request('EventSubscriptionRequest', {
      eventName: 'TrackingStatusChangedEvent',
      subscribe: true,
      config: {},
    });
    await feed([]);
    const lost = await p1.next(
      (m) => m.messageType === 'TrackingStatusChangedEvent' && m.data.rightHandFound === false,
      5000,
    );
    expect(lost.data).toMatchObject({ leftHandFound: false, rightHandFound: false });
    await feed([hand({ side: 'left' })]);
    const found = await p1.next(
      (m) => m.messageType === 'TrackingStatusChangedEvent' && m.data.rightHandFound === true,
      5000,
    );
    expect(found.data).toMatchObject({ leftHandFound: false });
    const value = async (name: string) =>
      (await p1.request('ParameterValueRequest', { name })).data;
    expect(await value('HandRightFound')).toMatchObject({ value: 0, min: 0, max: 1 });
    await openSection(page, 'Agents');
    await page.locator('#plugins-list .plugin-tracking').first().check();
    await expect.poll(async () => (await value('HandRightFound')).value).toBe(1);
    expect((await value('HandRightOpen')).value).toBeGreaterThan(0.8);
    await page.locator('#plugins-list .plugin-tracking').first().uncheck();
    await page.keyboard.press('Escape');
    await p1.request('EventSubscriptionRequest', { subscribe: false });
  });
});

describe('gesture hotkeys', () => {
  it('fires a hotkey once a gesture is held, and releases it when the gesture ends', async () => {
    await page.evaluate(() => {
      const s = (window as any).mochiStudio;
      s.updateSettings({
        hotkeys: [
          {
            id: 'fist',
            label: 'Blush on a fist',
            keys: '',
            button: false,
            action: { type: 'expression', expression: 'Blush' },
            release: 'hold',
            gesture: { left: 'fist', combine: 'and', mirrored: false, hold: 0.4 },
          },
        ],
      });
    });
    const on = () =>
      page.evaluate(() => (window as any).mochiStudio.activeExpressions.has('Blush'));
    await feed([hand({ side: 'left', fingers: { ...curled, Thumb: 0.2 } })]);
    // Not before the hold time…
    await page.waitForTimeout(150);
    expect(await on()).toBe(false);
    await expect.poll(on, { timeout: 3000 }).toBe(true);
    // …and off when the hand opens ("while held").
    await feed([hand({ side: 'left' })]);
    await expect.poll(on, { timeout: 3000 }).toBe(false);
    // A gesture on the other hand matches only when mirrored.
    await feed([hand({ side: 'right', fingers: { ...curled, Thumb: 0.2 } })]);
    await page.waitForTimeout(700);
    expect(await on()).toBe(false);
    await page.evaluate(() => {
      const s = (window as any).mochiStudio;
      const [h] = s.settings.hotkeys;
      s.updateSettings({ hotkeys: [{ ...h, gesture: { ...h.gesture, mirrored: true } }] });
    });
    await expect.poll(on, { timeout: 3000 }).toBe(true);
    // Hand tracking stops (the camera off): the gesture ends with it.
    await stopFeed();
    await page.evaluate(() => (window as any).mochiStudio.stopCamera());
    await expect.poll(on, { timeout: 3000 }).toBe(false);
  });

  it('sets up a gesture in the Hotkeys tab: per hand, AND or OR, mirrored, a hold time, or a pose', async () => {
    await openSection(page, 'Hotkeys');
    const row = page.locator('.hotkey[data-hotkey=fist]');
    await row.locator('.hotkey-gesture summary').click();
    await row.locator('select[aria-label="Right hand"]').selectOption('peace');
    const gesture = () =>
      page.evaluate(() => (window as any).mochiStudio.settings.hotkeys[0].gesture);
    await expect.poll(gesture).toMatchObject({ left: 'fist', right: 'peace', combine: 'and' });
    const again = page.locator('.hotkey[data-hotkey=fist]');
    await again.locator('.hotkey-gesture summary').click();
    await again.locator('select[aria-label="Combine"]').selectOption('or');
    await expect.poll(gesture).toMatchObject({ combine: 'or' });
    await page.locator('.hotkey[data-hotkey=fist] .hotkey-gesture summary').click();
    await page.locator('.hotkey[data-hotkey=fist] .gesture-hold').fill('1.5');
    await page.locator('.hotkey[data-hotkey=fist] .gesture-hold').dispatchEvent('change');
    await expect.poll(gesture).toMatchObject({ hold: 1.5 });
    await page.locator('.hotkey[data-hotkey=fist] .hotkey-gesture summary').click();
    await page
      .locator('.hotkey[data-hotkey=fist] select[aria-label="Two-hand pose"]')
      .selectOption('together');
    await expect
      .poll(gesture)
      .toEqual({ pose: 'together', combine: 'or', mirrored: true, hold: 1.5 });
    // Hands together: the pose fires it.
    await feed([hand({ side: 'left', at: [0.53, 0.6] }), hand({ side: 'right', at: [0.47, 0.6] })]);
    await expect
      .poll(() => page.evaluate(() => (window as any).mochiStudio.activeExpressions.has('Blush')), {
        timeout: 4000,
      })
      .toBe(true);
    // Hands gone: the pose ends, and so does the hotkey ("while held").
    await feed([]);
    await expect
      .poll(() => page.evaluate(() => (window as any).mochiStudio.activeExpressions.has('Blush')), {
        timeout: 3000,
      })
      .toBe(false);
    await stopFeed();
    await page.evaluate(() => (window as any).mochiStudio.updateSettings({ hotkeys: [] }));
    await page.keyboard.press('Escape');
  });
});

describe('the basic mouth', () => {
  it('lets the vowels shape the mouth form of a model without vowel parameters', async () => {
    const vowels = Object.fromEntries(
      (['I', 'O'] as const).map((v) => [
        v,
        Array.from(synthesizeVowel(VOWEL_FORMANTS[v], 2, 48_000, { fade: 0 })),
      ]),
    );
    await page.evaluate((vowels) => {
      const ctx = new AudioContext({ sampleRate: 48_000 });
      const dest = ctx.createMediaStreamDestination();
      let src: AudioBufferSourceNode | undefined;
      (window as any).voice = {
        stream: dest.stream,
        play(v: string) {
          src?.stop();
          const data = (vowels as Record<string, number[]>)[v]!;
          const buf = ctx.createBuffer(1, data.length, 48_000);
          buf.copyToChannel(Float32Array.from(data), 0);
          src = ctx.createBufferSource();
          src.buffer = buf;
          src.loop = true;
          src.connect(dest);
          src.start();
        },
      };
      return ctx.resume();
    }, vowels);
    await openSection(page, 'Audio');
    await page.locator('#lipsync-type').selectOption('advanced');
    // The automatic setup: no vowel parameters, so the vowels shape the mouth form.
    await expect
      .poll(() => page.evaluate(() => (window as any).mochiStudio.settings.lipSync.vowelForm))
      .toBe(true);
    expect(await page.locator('#vowel-form').isChecked()).toBe(true);
    await page.evaluate(() =>
      (window as any).mochiStudio.startMicrophone(undefined, {
        stream: (window as any).voice.stream,
      }),
    );
    const form = () =>
      page.evaluate(() => (window as any).mochiStudio.runtime.parameterValue('ParamMouthForm'));
    await page.evaluate(() => (window as any).voice.play('I'));
    await expect.poll(form, { timeout: 5000 }).toBeGreaterThan(0.4);
    await page.evaluate(() => (window as any).voice.play('O'));
    await expect.poll(form, { timeout: 5000 }).toBeLessThan(-0.4);
    // Off: the mouth form is left alone, and stays off when the type is switched again.
    await page.locator('#vowel-form').uncheck();
    await expect.poll(form, { timeout: 5000 }).toBeCloseTo(0, 1);
    await page.locator('#lipsync-type').selectOption('simple');
    await page.locator('#lipsync-type').selectOption('advanced');
    expect(await page.evaluate(() => (window as any).mochiStudio.settings.lipSync.vowelForm)).toBe(
      false,
    );
    expect(await page.locator('#vowel-form').isChecked()).toBe(false);
    await page.evaluate(() => (window as any).mochiStudio.stopMicrophone());
    await page.keyboard.press('Escape');
    expect(errors).toEqual([]);
  });
});
