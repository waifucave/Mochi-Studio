import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { VOWEL_FORMANTS, synthesizeVowel } from 'mochi2d/headless';
import type { Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BridgeServer } from '../../bridge/src/server.ts';
import { BridgeStore } from '../../bridge/src/store.ts';
import { PluginClient } from '../support/pluginClient';
import { syntheticModelFiles } from '../support/syntheticModel';
import { openSection, startHarness, type Harness } from './harness';

/**
 * The advanced (vowel) lipsync. Synthetic vowels from
 * Mochi2D's test synthesizer play into a MediaStream, which the studio
 * follows instead of a microphone; the voice inputs, the mapped vowel
 * parameters, calibration, plugins' access and a model's motion-sync
 * settings are checked.
 *
 * The test model has ParamA … ParamO and ParamSilence. No motion-sync file
 * is written (its format is not among this project's inputs): the
 * motion-sync test gives the runtime one setting by hand.
 */
let H: Harness;
let bridge: BridgeServer;
let page: Page;
let out: Page;
let url: string;
let p1: PluginClient;
const home = mkdtempSync(join(tmpdir(), 'mochi-lipsync-'));
const pluginPort = 22_900 + Math.floor(Math.random() * 800);
const errors: string[] = [];
const VOWELS = ['A', 'I', 'U', 'E', 'O'] as const;
const RATE = 48_000;

/**
 * A model with the vowel parameters the lipsync's automatic setup maps to,
 * and a motion-sync file written with Mochi2D's writeMotionSync.
 */
function vowelModelZip(): Uint8Array {
  const files = syntheticModelFiles({
    name: 'vowels',
    withMotionSync: true,
    extraParameters: [
      ...VOWELS.map((v) => ({ id: `Param${v}`, min: 0, max: 1, default: 0 })),
      { id: 'ParamSilence', min: 0, max: 1, default: 0 },
    ],
  });
  return zipSync(Object.fromEntries(Object.entries(files).map(([p, d]) => [`Vowels/${p}`, d])));
}

async function loadModel(p: Page): Promise<void> {
  await p.locator('#model-zip').setInputFiles({
    name: 'Vowels.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(vowelModelZip()),
  });
  await p.waitForFunction(() => (window as any).mochiStudio.settings !== undefined);
}

/**
 * Puts a synthetic voice into the page: `window.voice.play(vowel)` loops a
 * vowel into `window.voice.stream`, `window.voice.quiet()` stops it.
 */
async function installVoice(p: Page): Promise<void> {
  const vowels = Object.fromEntries(
    VOWELS.map((v) => [v, Array.from(synthesizeVowel(VOWEL_FORMANTS[v], 2, RATE, { fade: 0 }))]),
  );
  await p.evaluate(
    ({ vowels, rate }) => {
      const ctx = new AudioContext({ sampleRate: rate });
      const dest = ctx.createMediaStreamDestination();
      let src: AudioBufferSourceNode | undefined;
      (window as any).voice = {
        stream: dest.stream,
        play(v: string) {
          src?.stop();
          const data = (vowels as Record<string, number[]>)[v]!;
          const buf = ctx.createBuffer(1, data.length, rate);
          buf.copyToChannel(Float32Array.from(data), 0);
          src = ctx.createBufferSource();
          src.buffer = buf;
          src.loop = true;
          src.connect(dest);
          src.start();
        },
        quiet() {
          src?.stop();
          src = undefined;
        },
        /** The audio context's state and clock, for a test that times out. */
        state: () => ({ state: ctx.state, time: ctx.currentTime, playing: !!src }),
        /** A quiet room: white noise at about −60 dBFS. */
        room() {
          src?.stop();
          const n = rate * 2;
          const buf = ctx.createBuffer(1, n, rate);
          const d = new Float32Array(n);
          for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * 0.0017;
          buf.copyToChannel(d, 0);
          src = ctx.createBufferSource();
          src.buffer = buf;
          src.loop = true;
          src.connect(dest);
          src.start();
        },
      };
      return ctx.resume();
    },
    { vowels, rate: RATE },
  );
}

const voiceInputs = (p: Page) =>
  p.evaluate(() =>
    Object.fromEntries(
      Object.entries((window as any).mochiStudio.lastInputs as Record<string, number>).filter(
        ([k]) => k.startsWith('Voice'),
      ),
    ),
  );
/** The vowel with the largest input, or '' while none is above 0.2. */
const strongest = (inputs: Record<string, number>): string => {
  const v = VOWELS.reduce((a, b) =>
    (inputs[`Voice${a}`] ?? 0) >= (inputs[`Voice${b}`] ?? 0) ? a : b,
  );
  return (inputs[`Voice${v}`] ?? 0) > 0.2 ? v : '';
};
const play = (v: string) => page.evaluate((v) => (window as any).voice.play(v), v);
const quiet = () => page.evaluate(() => (window as any).voice.quiet());

/**
 * Waits up to 5 s for the vowel to be the strongest voice input (and, with
 * `level`, above it). On a time-out it says what the page heard meanwhile:
 * the readings, how many frames ran, and the audio's state.
 */
async function untilVowel(v: string, level = 0): Promise<void> {
  const seen: string[] = [];
  const frames0 = await page.evaluate(() => (window as any).mochiStudio.framesDrawn as number);
  const t0 = Date.now();
  try {
    await expect
      .poll(
        async () => {
          const i = await voiceInputs(page);
          seen.push(
            `${Date.now() - t0} ms: ${VOWELS.map((x) => `${x} ${(i[`Voice${x}`] ?? 0).toFixed(2)}`).join(', ')}, silence ${(i.VoiceSilence ?? 0).toFixed(2)}`,
          );
          return strongest(i) === v && (i[`Voice${v}`] ?? 0) > level;
        },
        { timeout: 5000 },
      )
      .toBe(true);
  } catch (e) {
    const frames = (await page.evaluate(() => (window as any).mochiStudio.framesDrawn)) - frames0;
    const audio = await page.evaluate(() => (window as any).voice.state());
    console.log(
      `Waiting for ${v}: ${frames} frames in ${Date.now() - t0} ms; audio ${JSON.stringify(audio)}; readings:\n${seen.slice(-12).join('\n')}`,
    );
    throw e;
  }
}

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
  await loadModel(page);
  await installVoice(page);
  out = await H.context.newPage();
  out.on('pageerror', (e) => errors.push(`output: ${e.message}`));
  await out.goto(new URL('output.html', H.url).href);
  await out.waitForFunction(() => document.body.dataset.model?.startsWith('vowels.model3.json'));
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
    pluginName: 'Voice Reader',
    pluginDeveloper: 'Tester',
  });
  await page.locator('#plugin-approval').waitFor({ state: 'visible' });
  await page.locator('#plugin-allow').click();
  const t = await p1.next((m) => m.requestID === id, 10_000);
  await p1.request('AuthenticationRequest', {
    pluginName: 'Voice Reader',
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

describe('the advanced lipsync', () => {
  it('switches to the advanced type, and sets up the vowel mapping by itself', async () => {
    await openSection(page, 'Audio');
    expect(await page.locator('#lipsync-type').inputValue()).toBe('simple');
    expect(await page.locator('#vowel-meter').count()).toBe(0);
    await page.locator('#lipsync-type').selectOption('advanced');
    expect(await page.evaluate(() => (window as any).mochiStudio.settings.lipSync)).toMatchObject({
      type: 'advanced',
      voiceProcessing: false,
    });
    // The guide's fixed IDs: VoiceA … VoiceO to ParamA … ParamO, VoiceSilence to ParamSilence.
    const rules = await page.evaluate(() =>
      (window as any).mochiStudio.settings.mapping
        .filter((r: any) => r.input.startsWith('Voice'))
        .map((r: any) => [r.input, r.output]),
    );
    expect(rules).toEqual([
      ['VoiceA', 'ParamA'],
      ['VoiceI', 'ParamI'],
      ['VoiceU', 'ParamU'],
      ['VoiceE', 'ParamE'],
      ['VoiceO', 'ParamO'],
      ['VoiceSilence', 'ParamSilence'],
    ]);
    await expect.poll(() => page.locator('#vowel-meter').count()).toBe(1);
    // Running it again changes nothing: one rule per output.
    await page.locator('#vowel-setup').click();
    expect(
      await page.evaluate(
        () =>
          (window as any).mochiStudio.settings.mapping.filter((r: any) =>
            r.input.startsWith('Voice'),
          ).length,
      ),
    ).toBe(6);
    await page.keyboard.press('Escape');
  });

  it('hears synthetic vowels from a stream: the voice inputs, the vowel parameters, the mouth', async () => {
    await page.evaluate(() =>
      (window as any).mochiStudio.startMicrophone(undefined, {
        stream: (window as any).voice.stream,
      }),
    );
    for (const v of VOWELS) {
      await play(v);
      // The vowel's input is the strongest, and clearly so (it builds up over a few frames).
      await untilVowel(v, 0.35);
      const inputs = await voiceInputs(page);
      expect(inputs.VoiceVolume).toBeGreaterThan(0.5);
      expect(inputs.VoiceSilence).toBeLessThan(0.3);
      // Through the mapping: the vowel's parameter is the most open, here and in the output view.
      const values = (p: Page, w: string) =>
        p.evaluate(
          (w) =>
            ['A', 'I', 'U', 'E', 'O'].map((x) =>
              (window as any)[w].runtime.parameterValue(`Param${x}`),
            ),
          w,
        );
      const top = async (p: Page, w: string) => {
        const o = await values(p, w);
        return VOWELS[o.indexOf(Math.max(...o))];
      };
      await expect.poll(() => top(page, 'mochiStudio')).toBe(v);
      await out.bringToFront();
      await expect.poll(() => top(out, 'mochiOutput'), { timeout: 10_000 }).toBe(v);
      await page.bringToFront();
    }
    // The volume still opens the mouth (Mochi2D's live lip sync on the same stream).
    expect(await page.evaluate(() => (window as any).mochiStudio.lipSyncValue)).toBeGreaterThan(0);
    // Quiet: silence.
    await quiet();
    await expect
      .poll(async () => (await voiceInputs(page)).VoiceSilence, { timeout: 5000 })
      .toBeGreaterThan(0.95);
    expect((await voiceInputs(page)).VoiceVolume).toBeLessThan(0.05);
  });

  it('gives plugins the voice inputs only with tracking-data access', async () => {
    await play('A');
    await untilVowel('A');
    const value = async (name: string) =>
      (await p1.request('ParameterValueRequest', { name })).data;
    // Without access: the defaults (silence).
    expect(await value('VoiceA')).toMatchObject({ name: 'VoiceA', value: 0, min: 0, max: 1 });
    expect(await value('VoiceSilence')).toMatchObject({ value: 1, defaultValue: 1 });
    await openSection(page, 'Agents');
    await page.locator('#plugins-list .plugin-tracking').first().check();
    // Each read waits for the state it checks: the analysis moves from window to
    // window, and a busy machine reads the requests at different moments.
    await expect.poll(async () => (await value('VoiceA')).value).toBeGreaterThan(0.35);
    await expect.poll(async () => (await value('VoiceVolume')).value).toBeGreaterThan(0.5);
    await expect
      .poll(
        async () =>
          (await p1.request('InputParameterListRequest')).data.defaultParameters.find(
            (p: any) => p.name === 'VoiceA',
          ).value,
      )
      .toBeGreaterThan(0.35);
    await page.locator('#plugins-list .plugin-tracking').first().uncheck();
    await page.keyboard.press('Escape');
    await quiet();
  });

  it('calibrates a voice, vowel by vowel and a moment of silence, and keeps it', async () => {
    await openSection(page, 'Audio');
    await page.locator('#voice-new-name').fill('Test voice');
    await page.locator('#voice-new').click();
    for (const v of VOWELS) {
      await play(v);
      await page.locator(`.calibrate[data-element=${v}]`).click();
      await expect
        .poll(() => page.locator(`.calibrate[data-element=${v}]`).textContent(), {
          timeout: 10_000,
        })
        .toBe(`${v} ✓`);
    }
    await page.evaluate(() => (window as any).voice.room());
    await page.locator('.calibrate[data-element=Silence]').click();
    await expect
      .poll(() => page.locator('.calibrate[data-element=Silence]').textContent(), {
        timeout: 10_000,
      })
      .toBe('Silence ✓');
    const app = await page.evaluate(() => {
      const s = (window as any).mochiStudio;
      return { voice: s.app.voice, voices: s.app.voices };
    });
    expect(app.voice).toBe('Test voice');
    expect(app.voices).toHaveLength(1);
    const p = app.voices[0];
    expect(p).toMatchObject({ format: 'mochi2d-voice-profile', version: 1, name: 'Test voice' });
    expect(Object.keys(p.templates).sort()).toEqual(['A', 'E', 'I', 'O', 'U']);
    expect(p.floorLevel).not.toBeNull();
    expect(await page.locator('#voice-status').textContent()).toContain('knows every vowel');
    // Kept: in the settings store, for the next start.
    await expect
      .poll(() =>
        page.evaluate(async () => (await (window as any).mochiStudio.store.getApp()).voices.length),
      )
      .toBe(1);
    // With the calibrated voice, the vowels are still told apart.
    for (const v of ['A', 'U', 'E'] as const) {
      await play(v);
      await untilVowel(v);
    }
    await quiet();
    // Back to the neutral voice; the calibrated one stays in the list.
    await page.locator('label', { hasText: 'Voice' }).locator('select').first().selectOption('');
    expect(await page.evaluate(() => (window as any).mochiStudio.app.voice)).toBeUndefined();
    await page.keyboard.press('Escape');
  });

  it('opens the microphone without the browser’s voice processing, unless asked', async () => {
    await page.evaluate(() => {
      const s = (window as any).mochiStudio;
      s.stopMicrophone();
      const asked: unknown[] = ((window as any).asked = []);
      const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = (c?: MediaStreamConstraints) => {
        asked.push(JSON.parse(JSON.stringify(c ?? {})));
        return real(c);
      };
    });
    await openSection(page, 'Audio');
    await page.locator('#mic-toggle').click();
    await expect
      .poll(() => page.evaluate(() => (window as any).mochiStudio.microphoneOn))
      .toBe(true);
    const asked = () => page.evaluate(() => (window as any).asked as Array<{ audio: any }>);
    expect((await asked())[0]!.audio).toMatchObject({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    });
    // For noisy rooms: on, and the microphone opens again with it.
    await page.locator('#voice-processing').check();
    await expect.poll(async () => (await asked()).length).toBe(2);
    expect((await asked())[1]!.audio).toMatchObject({
      echoCancellation: true,
      noiseSuppression: true,
    });
    await page.locator('#voice-processing').uncheck();
    await page.evaluate(() => (window as any).mochiStudio.stopMicrophone());
    await page.keyboard.press('Escape');
  });

  it('stays off when turned off while it reopens, and the stream given last is the one heard', async () => {
    // A slow microphone (a busy machine): unticking voice processing reopens it, and it is
    // turned off, then given the synthetic voice, before that reopening finishes.
    await page.evaluate(() => {
      const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      (window as any).realGetUserMedia = real;
      navigator.mediaDevices.getUserMedia = (c?: MediaStreamConstraints) =>
        new Promise((r) => setTimeout(r, 800)).then(() => real(c));
    });
    await page.evaluate(() => (window as any).mochiStudio.startMicrophone());
    await openSection(page, 'Audio');
    await page.locator('#voice-processing').check();
    await page.evaluate(() => (window as any).mochiStudio.stopMicrophone());
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => (window as any).mochiStudio.microphoneOn), 'still off').toBe(
      false,
    );
    await page.locator('#voice-processing').uncheck();
    await page.evaluate(() =>
      (window as any).mochiStudio.startMicrophone(undefined, {
        stream: (window as any).voice.stream,
      }),
    );
    await page.waitForTimeout(1500);
    await play('U');
    await untilVowel('U');
    expect(
      await page.evaluate(
        () => (window as any).mochiStudio.voiceStreamInUse === (window as any).voice.stream,
      ),
      'the synthetic voice, not the microphone',
    ).toBe(true);
    await quiet();
    await page.evaluate(() => {
      navigator.mediaDevices.getUserMedia = (window as any).realGetUserMedia;
      (window as any).mochiStudio.stopMicrophone();
    });
    await page.keyboard.press('Escape');
  });

  it('offers the model’s motion-sync settings, whose shapes then move the mouth', async () => {
    // The model's own motion-sync file (written with Mochi2D's writeMotionSync), one setting.
    expect(
      await page.evaluate(() => (window as any).mochiStudio.runtime.motionSyncSettings()),
    ).toEqual([{ id: 'MotionSync1', name: 'Mouth basic', usable: true }]);
    await page.evaluate(() =>
      (window as any).mochiStudio.startMicrophone(undefined, {
        stream: (window as any).voice.stream,
      }),
    );
    await openSection(page, 'Audio');
    await expect.poll(() => page.locator('label', { hasText: 'Mouth shapes' }).count()).toBe(1);
    await page
      .locator('label', { hasText: 'Mouth shapes' })
      .locator('select')
      .selectOption('Mouth basic');
    expect(await page.evaluate(() => (window as any).mochiStudio.settings.lipSync.motionSync)).toBe(
      'Mouth basic',
    );
    await expect
      .poll(() => page.evaluate(() => (window as any).mochiStudio.motionSyncSetting))
      .toBe('Mouth basic');
    // Mochi2D's motion sync hears the vowel on the same stream: its analysis feeds the voice
    // inputs, and the setting's O shape (open 0.7, rounded) reaches the output view.
    await play('O');
    await untilVowel('O');
    await out.bringToFront();
    await expect
      .poll(
        () =>
          out.evaluate(() => (window as any).mochiOutput.runtime.parameterValue('ParamMouthOpenY')),
        { timeout: 10_000 },
      )
      .toBeCloseTo(0.7, 1);
    expect(
      await out.evaluate(() =>
        (window as any).mochiOutput.runtime.parameterValue('ParamMouthForm'),
      ),
    ).toBeLessThan(-0.6);
    await page.bringToFront();
    // Back to the vowel inputs: motion sync stops, Mochi Studio's analysis runs again.
    await page.locator('label', { hasText: 'Mouth shapes' }).locator('select').selectOption('');
    await expect
      .poll(() => page.evaluate(() => (window as any).mochiStudio.motionSyncSetting))
      .toBeUndefined();
    await play('I');
    await untilVowel('I');
    await quiet();
    await page.evaluate(() => (window as any).mochiStudio.stopMicrophone());
    await page.keyboard.press('Escape');
    expect(errors).toEqual([]);
  });
});
