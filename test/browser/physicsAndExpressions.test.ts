import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BridgeServer } from '../../bridge/src/server.ts';
import { BridgeStore } from '../../bridge/src/store.ts';
import { encodeGif } from '../support/gif';
import { PluginClient, expectEnvelope, type Message } from '../support/pluginClient';
import { encodePng } from '../support/syntheticModel';
import { openSection, startHarness, syntheticPhysicsModelZip, type Harness } from './harness';

/**
 * Physics strength, wind and groups, for the person
 * and for plugins; the expression editor; item scenes; a GIF's own frame
 * delays; and `justLoaded` in expression toggle events.
 *
 * The synthetic model comes with a physics file written by Mochi2D's
 * `writePhysics`: two settings, "Hair" (which overwrites
 * ParamAngleX from ParamCustom) and an unnamed one, so the tests read
 * Mochi2D's own physics state.
 */
let H: Harness;
let bridge: BridgeServer;
let page: Page;
let out: Page;
let url: string;
let p1: PluginClient;
const home = mkdtempSync(join(tmpdir(), 'mochi-physics-'));
const pluginPort = 22_000 + Math.floor(Math.random() * 800);
const errors: string[] = [];
const ev = (name: string) => (m: Message) => m.messageType === name;

async function connectPlugin(name: string): Promise<PluginClient> {
  const c = await PluginClient.connect(url);
  const id = c.send('AuthenticationTokenRequest', { pluginName: name, pluginDeveloper: 'Tester' });
  await page.locator('#plugin-approval').waitFor({ state: 'visible' });
  await page.locator('#plugin-allow').click();
  const t = await c.next((m) => m.requestID === id, 10_000);
  const a = await c.request('AuthenticationRequest', {
    pluginName: name,
    pluginDeveloper: 'Tester',
    authenticationToken: t.data.authenticationToken,
  });
  expect(a.data.authenticated).toBe(true);
  return c;
}

async function loadModel(p: Page): Promise<void> {
  await p.locator('#model-zip').setInputFiles({
    name: 'Test.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(syntheticPhysicsModelZip()),
  });
  await p.waitForFunction(() => (window as any).mochiStudio.settings !== undefined);
}

/** The physics values Mochi2D has now: strength, the groups' multipliers (those not 1), the wind's peak. */
const lastPhysics = (p: Page) =>
  p.evaluate(() => (window as any).mochiStudio.runtime.physicsValues());

/** Sets a range input the way dragging it does. */
async function slide(p: Page, selector: string, value: number): Promise<void> {
  await p.locator(selector).evaluate((el, v) => {
    (el as HTMLInputElement).value = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
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
  out = await H.context.newPage();
  out.on('pageerror', (e) => errors.push(`output: ${e.message}`));
  await out.goto(new URL('output.html', H.url).href);
  await out.waitForFunction(() => document.body.dataset.model?.startsWith('test.model3.json'));
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
  p1 = await connectPlugin('Physics Plugin');
}, 60_000);
afterAll(async () => {
  p1?.close();
  await bridge?.close();
  await H?.close();
});

describe('physics', () => {
  it('sets the strength, wind and group multipliers in the Model tab, for every window', async () => {
    // The Model tab shows the physics section once it re-renders (an expression chip does that).
    await openSection(page, 'Model');
    const blush = page.locator('.quick .chipbtn', { hasText: 'Blush' });
    await blush.click();
    await blush.click();
    await expect.poll(() => page.locator('#physics-strength').count()).toBe(1);
    expect(await page.locator('#physics-strength').inputValue()).toBe('50');
    const groups = page.locator('.physics-group');
    expect(await groups.count()).toBe(2);
    // Named from the physics file's dictionary; a group without a name shows its ID.
    expect(await page.locator('.physics-group-row').allTextContents()).toEqual([
      expect.stringContaining('Hair'),
      expect.stringContaining('PhysicsSetting2'),
    ]);
    await slide(page, '#physics-strength', 25);
    await slide(page, '#physics-wind', 40);
    await slide(page, '.physics-group[data-group=PhysicsSetting1]', 1.5);
    expect(await page.evaluate(() => (window as any).mochiStudio.settings.physicsTuning)).toEqual({
      strength: 25,
      wind: 40,
      groups: { PhysicsSetting1: 1.5 },
    });
    // Mochi2D's values: strength 25/50, the group's multiplier, the wind's peak 40/100.
    expect(await lastPhysics(page)).toEqual({
      strength: 0.5,
      settings: { PhysicsSetting1: 1.5 },
      wind: [0.4, 0],
    });
    // The wind blows in gusts, from either side: at most its peak.
    const now = await page.evaluate(() => (window as any).mochiStudio.runtime.physicsWindNow());
    expect(Math.abs(now[0])).toBeLessThanOrEqual(0.4 + 1e-9);
    // Output views get the same values.
    await expect
      .poll(() =>
        out.evaluate(() => {
          const v = (window as any).mochiOutput.runtime.physicsValues();
          return [v.strength, v.wind];
        }),
      )
      .toEqual([0.5, [0.4, 0]]);
  });

  it('keeps the physics settings with the model', async () => {
    // Read back from the settings store (a second studio page would take over the bridge).
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const s = (window as any).mochiStudio;
          return (await s.store.get(s.model.key))?.physicsTuning;
        }),
      )
      .toEqual({ strength: 25, wind: 40, groups: { PhysicsSetting1: 1.5 } });
  });

  it('answers GetCurrentModelPhysicsRequest with the real groups and the person’s values', async () => {
    const r = await p1.request('GetCurrentModelPhysicsRequest');
    expectEnvelope(r, 'GetCurrentModelPhysicsResponse');
    expect(r.data).toMatchObject({
      modelLoaded: true,
      modelHasPhysics: true,
      physicsSwitchedOn: true,
      usingLegacyPhysics: false,
      physicsFPSSetting: 30, // the physics file's own rate
      baseStrength: 25,
      baseWind: 40,
      apiPhysicsOverrideActive: false,
      apiPhysicsOverridePluginName: '',
      physicsGroups: [
        {
          groupID: 'PhysicsSetting1',
          groupName: 'Hair',
          strengthMultiplier: 1.5,
          windMultiplier: 1,
        },
        // Without a name in the file: empty, as the plugin API allows (Mochi2D 0.12.0's `named`).
        {
          groupID: 'PhysicsSetting2',
          groupName: '',
          strengthMultiplier: 1,
          windMultiplier: 1,
        },
      ],
    });
  });

  it('sets the physics rate in the Model tab, for every window, and reports it', async () => {
    const rateNow = (p: Page, global: string) =>
      p.evaluate((g) => (window as any)[g].runtime.physicsRate().inUse as number, global);
    const fps = async () =>
      (await p1.request('GetCurrentModelPhysicsRequest')).data.physicsFPSSetting;
    await openSection(page, 'Model');
    const rate = page.locator('#physics-rate');
    await expect.poll(() => rate.count()).toBe(1);
    // The default: the physics file's own rate, 30 steps a second here.
    expect(await rate.inputValue()).toBe('file');
    expect(await page.locator('#physics-rate option').first().textContent()).toContain('30');
    expect(
      await page.evaluate(() => (window as any).mochiStudio.runtime.physicsRate()),
    ).toMatchObject({
      file: 30,
      inUse: 30,
    });
    expect(await fps()).toBe(30);
    // A fixed rate: this window, the output view and plugins.
    await rate.selectOption('120');
    await expect.poll(() => rateNow(page, 'mochiStudio')).toBe(120);
    await expect.poll(() => rateNow(out, 'mochiOutput')).toBe(120);
    expect(await page.evaluate(() => (window as any).mochiStudio.settings.physicsTuning.rate)).toBe(
      120,
    );
    expect(await fps()).toBe(120);
    // Same as the app: one step a frame, which the protocol calls −1.
    await rate.selectOption('0');
    await expect.poll(() => rateNow(page, 'mochiStudio')).toBe(0);
    await expect.poll(() => rateNow(out, 'mochiOutput')).toBe(0);
    expect(await fps()).toBe(-1);
    // Back to the file's own.
    await rate.selectOption('file');
    await expect.poll(() => rateNow(page, 'mochiStudio')).toBe(30);
    await expect.poll(() => rateNow(out, 'mochiOutput')).toBe(30);
    expect(
      'rate' in (await page.evaluate(() => (window as any).mochiStudio.settings.physicsTuning)),
    ).toBe(false);
    expect(await fps()).toBe(30);
    await page.keyboard.press('Escape');
  });

  it('gives each group its share of the wind, the person’s and a plugin’s (Mochi2D 0.13.0)', async () => {
    await openSection(page, 'Model');
    await expect.poll(() => page.locator('.physics-group-wind').count()).toBe(2);
    await slide(page, '.physics-group-wind[data-group=PhysicsSetting2]', 0);
    expect(
      await page.evaluate(() => (window as any).mochiStudio.settings.physicsTuning.windGroups),
    ).toEqual({ PhysicsSetting2: 0 });
    await expect
      .poll(async () => (await lastPhysics(page)).windSettings)
      .toEqual({
        PhysicsSetting2: 0,
      });
    const report = (await p1.request('GetCurrentModelPhysicsRequest')).data;
    expect(report.physicsGroups.map((g: any) => [g.groupID, g.windMultiplier])).toEqual([
      ['PhysicsSetting1', 1],
      ['PhysicsSetting2', 0],
    ]);
    // A plugin's group wind override takes effect for its time (it was kept, not applied, before).
    const r = await p1.request('SetCurrentModelPhysicsRequest', {
      windOverrides: [{ id: 'PhysicsSetting1', value: 2, overrideSeconds: 1 }],
    });
    expect(r.data).toEqual({});
    await expect
      .poll(async () => (await lastPhysics(page)).windSettings)
      .toEqual({
        PhysicsSetting1: 2,
        PhysicsSetting2: 0,
      });
    // Output views get it too.
    await expect
      .poll(() =>
        out.evaluate(() => (window as any).mochiOutput.runtime.physicsValues().windSettings),
      )
      .toEqual({ PhysicsSetting1: 2, PhysicsSetting2: 0 });
    await expect
      .poll(async () => (await lastPhysics(page)).windSettings, { timeout: 4000 })
      .toEqual({ PhysicsSetting2: 0 });
    await slide(page, '.physics-group-wind[data-group=PhysicsSetting2]', 1);
    await expect.poll(async () => (await lastPhysics(page)).windSettings).toBeUndefined();
    await page.keyboard.press('Escape');
  });

  it('fades an expression a plugin switches over its fadeTime (Mochi2D 0.13.0)', async () => {
    const custom = () =>
      page.evaluate(
        () => (window as any).mochiStudio.runtime.parameterValue('ParamCustom') as number,
      );
    const activate = (active: boolean, fadeTime?: number) =>
      p1.request('ExpressionActivationRequest', {
        expressionFile: 'blush.exp3.json',
        active,
        ...(fadeTime === undefined ? {} : { fadeTime }),
      });
    // Two seconds: still well short of the value half a second later.
    await activate(true, 2);
    await page.waitForTimeout(500);
    const partWay = await custom();
    expect(partWay).toBeGreaterThan(0);
    expect(partWay).toBeLessThan(0.6);
    await expect.poll(custom, { timeout: 5000 }).toBeCloseTo(1, 2);
    // Off again over the same two seconds.
    await activate(false);
    await page.waitForTimeout(500);
    expect(await custom()).toBeGreaterThan(0.4);
    await expect.poll(custom, { timeout: 5000 }).toBeCloseTo(0, 2);
    // Zero: at once.
    await activate(true, 0);
    await expect.poll(custom, { timeout: 500 }).toBeCloseTo(1, 2);
    // Off reuses the fade-in time: at once too.
    await activate(false, 2);
    await expect.poll(custom, { timeout: 500 }).toBeCloseTo(0, 2);
  });

  it('applies a plugin’s overrides for their time, on top of the person’s settings', async () => {
    const set = (c: PluginClient, d: Record<string, unknown>) =>
      c.request('SetCurrentModelPhysicsRequest', d).then((m) => m.data);
    // Timers run out on the control window's frames: it draws in front.
    const p2 = await connectPlugin('Second Plugin');
    await page.bringToFront();
    // The plugin API's errors.
    expect((await set(p1, {})).errorID).toBe(703);
    expect((await set(p1, { strengthOverrides: [{ id: 'PhysicsSetting1' }] })).errorID).toBe(705);
    expect((await set(p1, { strengthOverrides: [{ id: 'Nope', value: 1 }] })).errorID).toBe(704);
    expect(
      (
        await set(p1, {
          windOverrides: [
            { setBaseValue: true, value: 1 },
            { setBaseValue: true, value: 2 },
          ],
        })
      ).errorID,
    ).toBe(706);
    const okay = await p1.request('SetCurrentModelPhysicsRequest', {
      strengthOverrides: [
        { setBaseValue: true, value: 100, overrideSeconds: 2 },
        { id: 'PhysicsSetting2', value: 5, overrideSeconds: 1 },
      ],
    });
    expectEnvelope(okay, 'SetCurrentModelPhysicsResponse');
    expect(okay.data).toEqual({});
    // Base 100 is twice the model's own strength; the multiplier is limited to 2.
    expect(await lastPhysics(page)).toEqual({
      strength: 2,
      settings: { PhysicsSetting1: 1.5, PhysicsSetting2: 2 },
      wind: [0.4, 0],
    });
    // Overrides are not shown, but who overrides is; the person sees it too.
    const r = (await p1.request('GetCurrentModelPhysicsRequest')).data;
    expect(r).toMatchObject({
      baseStrength: 25,
      apiPhysicsOverrideActive: true,
      apiPhysicsOverridePluginName: 'Physics Plugin',
    });
    expect(await page.locator('#physics-override').textContent()).toContain('Physics Plugin');
    // Another plugin waits until all of the first one's timers have run out.
    expect((await set(p2, { windOverrides: [{ setBaseValue: true, value: 0 }] })).errorID).toBe(
      702,
    );
    // Each override has its own timer: the group's ends first.
    await expect
      .poll(() => lastPhysics(page), { timeout: 5000 })
      .toEqual({ strength: 2, settings: { PhysicsSetting1: 1.5 }, wind: [0.4, 0] });
    await expect
      .poll(() => lastPhysics(page), { timeout: 5000 })
      .toEqual({ strength: 0.5, settings: { PhysicsSetting1: 1.5 }, wind: [0.4, 0] });
    expect(await page.locator('#physics-override').isHidden()).toBe(true);
    const t0 = Date.now();
    expect(
      (await set(p2, { windOverrides: [{ setBaseValue: true, value: 0, overrideSeconds: 0.1 }] }))
        .errorID,
    ).toBeUndefined();
    expect(await lastPhysics(page)).toMatchObject({ wind: [0, 0] });
    // Half a second at least; the person's wind comes back after it.
    await expect.poll(() => lastPhysics(page), { timeout: 3000 }).toMatchObject({ wind: [0.4, 0] });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(450);
    p2.close();
  });
});

describe('a GIF’s own frame delays', () => {
  it('keeps them, and makes the frame rate a speed factor', async () => {
    const palette: Array<[number, number, number]> = [
      [230, 40, 40],
      [40, 200, 70],
      [40, 90, 230],
    ];
    const gif = encodeGif(
      32,
      32,
      palette,
      [10, 30, 20].map((delay, i) => ({ indices: new Uint8Array(32 * 32).fill(i), delay })),
    );
    await page.evaluate(async (b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], 'uneven.gif', { type: 'image/gif' }));
      document
        .querySelector('.stage-wrap')!
        .dispatchEvent(
          new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }),
        );
    }, Buffer.from(gif).toString('base64'));
    await page.waitForFunction(() => (window as any).mochiStudio.items.length === 1, null, {
      timeout: 15_000,
    });
    const id = await page.evaluate(() => (window as any).mochiStudio.items[0].id as string);
    // 100, 300 and 200 ms: 5 frames a second on average.
    expect(
      await page.evaluate((id) => (window as any).mochiStudio.itemAnimation(id), id),
    ).toMatchObject({ frames: 3, fps: 5, baseFps: 5, ownTiming: true });
    await openSection(page, 'Items');
    expect(await page.locator(`[data-item="${id}"] .item-animation`).textContent()).toContain(
      'the GIF’s own timing',
    );
    await page.keyboard.press('Escape');
    await page.evaluate((id) => (window as any).mochiStudio.removeItem(id), id);
  });
});

describe('the expression editor', () => {
  const editorParam = (id: string) => page.locator(`.expr-param[data-param=${id}]`);

  it('makes an expression: ticked parameters, values and modes, with a physics warning', async () => {
    // The control window draws in front (a page behind another draws seldom).
    await page.bringToFront();
    // Breath moves the head angles a little on its own: off, so the values can be checked.
    for (const [p, w] of [
      [page, 'mochiStudio'],
      [out, 'mochiOutput'],
    ] as const)
      await p.evaluate((w) => (window as any)[w].runtime.setEffect('breath', false), w);
    await openSection(page, 'Hotkeys');
    expect(await page.locator('.expr-row').count()).toBe(1);
    await page.locator('#expr-new').click();
    await page.locator('#expr-name').fill('Grin');
    await editorParam('ParamAngleZ').locator('.expr-use').check();
    await editorParam('ParamAngleZ').locator('.expr-value').fill('12');
    await editorParam('ParamAngleZ').locator('.expr-value').dispatchEvent('change');
    await editorParam('ParamMouthForm').locator('.expr-use').check();
    await editorParam('ParamMouthForm').locator('.expr-blend').selectOption('Add');
    await editorParam('ParamMouthForm').locator('.expr-value').fill('0.4');
    await editorParam('ParamMouthForm').locator('.expr-value').dispatchEvent('change');
    // Physics outputs are marked (the file's Hair overwrites ParamAngleX), and ticking one warns.
    expect(await editorParam('ParamAngleX').locator('.expr-physics').count()).toBe(1);
    expect(await editorParam('ParamCustom').locator('.expr-physics').count()).toBe(0);
    expect(await page.locator('#expr-physics-warning').isHidden()).toBe(true);
    await editorParam('ParamAngleX').locator('.expr-use').check();
    expect(await page.locator('#expr-physics-warning').textContent()).toContain('ParamAngleX');
    await editorParam('ParamAngleX').locator('.expr-use').uncheck();
    expect(await page.locator('#expr-physics-warning').isHidden()).toBe(true);
    // The preview shows it on the model at once.
    await page.locator('#expr-preview').check();
    await expect
      .poll(
        () =>
          page.evaluate(() => (window as any).mochiStudio.runtime.parameterValue('ParamAngleZ')),
        { timeout: 5000 },
      )
      .toBeCloseTo(12, 3);
    // Exported as it stands.
    const [d] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('#expr-export-draft').click(),
    ]);
    expect(d.suggestedFilename()).toBe('Grin.exp3.json');
    expect(JSON.parse(readFileSync((await d.path())!, 'utf8'))).toEqual({
      FadeInTime: 0.5,
      FadeOutTime: 0.5,
      Parameters: [
        { Id: 'ParamAngleZ', Value: 12, Blend: 'Overwrite' },
        { Id: 'ParamMouthForm', Value: 0.4, Blend: 'Add' },
      ],
    });
    // Saved with the model's settings, in the browser.
    await page.locator('#expr-save').click();
    await expect.poll(() => page.locator('.expr-row').count()).toBe(2);
    expect(await page.locator('#expression-editor').isHidden()).toBe(true);
    await expect
      .poll(
        () =>
          page.evaluate(() => (window as any).mochiStudio.runtime.parameterValue('ParamAngleZ')),
        { timeout: 5000 },
      )
      .toBeCloseTo(0, 3);
    const own = await page.evaluate(() => (window as any).mochiStudio.settings.ownExpressions);
    expect(own).toEqual([{ file: 'Grin.exp3.json', name: 'Grin', json: expect.any(String) }]);
    expect(await page.locator('.expr-row[data-expression=Grin] .chip').textContent()).toBe(
      'made here',
    );
  });

  it('tries expressions on and off without hotkeys, in every window, and tells plugins', async () => {
    const angleZ = (p: Page, w: string) =>
      p.evaluate((w) => (window as any)[w].runtime.parameterValue('ParamAngleZ'), w);
    await page.locator('.expr-row[data-expression=Grin] .expr-test').click();
    expect(await page.evaluate(() => [...(window as any).mochiStudio.activeExpressions])).toEqual([
      'Grin',
    ]);
    await expect.poll(() => angleZ(page, 'mochiStudio'), { timeout: 5000 }).toBeCloseTo(12, 2);
    await out.bringToFront();
    await expect.poll(() => angleZ(out, 'mochiOutput'), { timeout: 10_000 }).toBeCloseTo(12, 2);
    await page.bringToFront();
    const state = await p1.request('ExpressionStateRequest', { details: true });
    expect(state.data.expressions.map((e: any) => [e.file, e.active])).toEqual([
      ['blush.exp3.json', false],
      ['Grin.exp3.json', true],
    ]);
    // Changed while on: the new values show at once.
    await page.locator('.expr-row[data-expression=Grin] .expr-edit').click();
    expect(await page.locator('#expr-name').inputValue()).toBe('Grin');
    await editorParam('ParamAngleZ').locator('.expr-value').fill('-12');
    await editorParam('ParamAngleZ').locator('.expr-value').dispatchEvent('change');
    await page.locator('#expr-save').click();
    await expect.poll(() => angleZ(page, 'mochiStudio'), { timeout: 5000 }).toBeCloseTo(-12, 2);
    await out.bringToFront();
    await expect.poll(() => angleZ(out, 'mochiOutput'), { timeout: 10_000 }).toBeCloseTo(-12, 2);
    await page.bringToFront();
    await page.locator('.expr-row[data-expression=Grin] .expr-test').click();
    await expect.poll(() => angleZ(page, 'mochiStudio'), { timeout: 5000 }).toBeCloseTo(0, 2);
  });

  it('makes hotkeys for the expressions that lack one', async () => {
    const button = page.locator('#expr-create-hotkeys');
    expect(await button.textContent()).toBe('Create hotkeys for 2 expressions without one');
    await button.click();
    expect(
      await page.evaluate(() =>
        (window as any).mochiStudio.settings.hotkeys.map((h: any) => [
          h.label,
          h.keys,
          h.button,
          h.action,
        ]),
      ),
    ).toEqual([
      ['Blush', '', false, { type: 'expression', expression: 'Blush' }],
      ['Grin', '', false, { type: 'expression', expression: 'Grin' }],
    ]);
    await expect.poll(() => button.textContent()).toBe('Every expression has a hotkey');
    expect(await button.isDisabled()).toBe(true);
  });

  it('changes one of the model’s own expressions, and undoes it', async () => {
    await page.locator('.expr-row[data-expression=Blush] .expr-edit').click();
    // The model's files name it.
    expect(await page.locator('#expr-name').isDisabled()).toBe(true);
    expect(await editorParam('ParamCustom').locator('.expr-use').isChecked()).toBe(true);
    expect(await editorParam('ParamMouthForm').locator('.expr-blend').inputValue()).toBe('Add');
    await editorParam('ParamMouthForm').locator('.expr-use').uncheck();
    await page.locator('#expr-save').click();
    await expect
      .poll(() => page.locator('.expr-row[data-expression=Blush] .chip').textContent())
      .toBe('changed here');
    const own = await page.evaluate(() => (window as any).mochiStudio.settings.ownExpressions);
    expect(own.map((o: any) => o.file)).toEqual(['Grin.exp3.json', 'blush.exp3.json']);
    expect(JSON.parse(own[1].json).Parameters).toEqual([
      { Id: 'ParamCustom', Value: 1, Blend: 'Overwrite' },
    ]);
    await page.locator('.expr-row[data-expression=Blush] .expr-remove').click();
    await expect.poll(() => page.locator('.expr-row[data-expression=Blush] .chip').count()).toBe(0);
    // Removing a new one takes it off the model's list (and plugins').
    await page.locator('.expr-row[data-expression=Grin] .expr-remove').click();
    await expect.poll(() => page.locator('.expr-row').count()).toBe(1);
    const state = await p1.request('ExpressionStateRequest', { details: false });
    expect(state.data.expressions.map((e: any) => e.file)).toEqual(['blush.exp3.json']);
  });
});

describe('item scenes', () => {
  const studio = (fn: string, ...args: unknown[]) =>
    page.evaluate(
      ([fn, args]) => (window as any).mochiStudio[fn as string](...(args as unknown[])),
      [fn, args] as const,
    );
  const visible = (p: Page, w: string, id: string) =>
    p.evaluate(([w, id]) => (window as any)[w].runtime.isItemVisible(id), [w, id] as const);
  let lamp = '';
  let mug = '';

  it('makes scenes from the current items, picking which ones each holds', async () => {
    await page.bringToFront();
    // Two image items, dropped on the stage.
    const png = (rgb: [number, number, number]) => {
      const px = new Uint8Array(24 * 24 * 4);
      for (let k = 0; k < 24 * 24; k++) px.set([...rgb, 255], k * 4);
      return Buffer.from(encodePng(24, 24, px)).toString('base64');
    };
    await page.evaluate(
      async (files) => {
        const dt = new DataTransfer();
        for (const [name, b64] of files)
          dt.items.add(
            new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], name, {
              type: 'image/png',
            }),
          );
        document
          .querySelector('.stage-wrap')!
          .dispatchEvent(
            new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }),
          );
      },
      [
        ['lamp.png', png([240, 200, 30])],
        ['mug.png', png([40, 90, 230])],
      ] as Array<[string, string]>,
    );
    await page.waitForFunction(() => (window as any).mochiStudio.items.length === 2, null, {
      timeout: 15_000,
    });
    [lamp, mug] = await page.evaluate(() => {
      const s = (window as any).mochiStudio;
      const by = (l: string) => s.items.find((i: any) => i.label.startsWith(l)).id as string;
      return [by('lamp'), by('mug')];
    });
    await studio('placeItem', lamp, { x: -0.3, y: 0.2 });
    await openSection(page, 'Items');
    // A scene of the lamp alone (both items are shown, so both start ticked).
    await page.locator('#scene-new').click();
    await page.locator('#scene-name').fill('Desk');
    await page.locator('#scene-group').fill('room');
    expect(await page.locator('.scene-item input:checked').count()).toBe(2);
    await page.locator(`.scene-item[data-item="${mug}"] input`).uncheck();
    await page.locator('#scene-save').click();
    await page.locator('#scene-new').click();
    await page.locator('#scene-name').fill('Bed');
    await page.locator('#scene-group').fill('room');
    await page.locator(`.scene-item[data-item="${lamp}"] input`).uncheck();
    await page.locator('#scene-save').click();
    expect(
      await page.evaluate(() =>
        (window as any).mochiStudio.settings.itemScenes.map((x: any) => [
          x.id,
          x.name,
          x.group,
          x.items.map((i: any) => i.id),
        ]),
      ),
    ).toEqual([
      ['scene1', 'Desk', 'room', [lamp]],
      ['scene2', 'Bed', 'room', [mug]],
    ]);
    const kept = await page.evaluate(
      () => (window as any).mochiStudio.settings.itemScenes[0].items[0].placement,
    );
    expect(kept).toMatchObject({ x: expect.closeTo(-0.3, 5), y: expect.closeTo(0.2, 5) });
  });

  it('shows a scene’s items where the scene has them, one scene of a group at a time', async () => {
    await studio('setItemVisible', lamp, false);
    await studio('setItemVisible', mug, false);
    // Moved since: turning the scene on puts the lamp back.
    await studio('placeItem', lamp, { x: 0.4, y: -0.1 });
    await page.locator('.scene[data-scene=scene1] .scene-toggle').click();
    expect(await visible(page, 'mochiStudio', lamp)).toBe(true);
    expect(
      await page.evaluate(
        (id) => (window as any).mochiStudio.runtime.items().find((i: any) => i.id === id).placement,
        lamp,
      ),
    ).toMatchObject({ x: expect.closeTo(-0.3, 5), y: expect.closeTo(0.2, 5) });
    await expect.poll(() => visible(out, 'mochiOutput', lamp)).toBe(true);
    // The other scene of the group: the lamp fades out and hides, the mug shows.
    await page.locator('.scene[data-scene=scene2] .scene-toggle').click();
    expect(await page.evaluate(() => (window as any).mochiStudio.isItemSceneOn('scene1'))).toBe(
      false,
    );
    expect(await visible(page, 'mochiStudio', mug)).toBe(true);
    await expect.poll(() => visible(page, 'mochiStudio', lamp), { timeout: 3000 }).toBe(false);
    await expect.poll(() => visible(out, 'mochiOutput', mug)).toBe(true);
    await expect.poll(() => visible(out, 'mochiOutput', lamp)).toBe(false);
    await page.locator('.scene[data-scene=scene2] .scene-toggle').click();
    await expect.poll(() => visible(page, 'mochiStudio', mug), { timeout: 3000 }).toBe(false);
    await page.keyboard.press('Escape');
  });

  it('toggles a scene with a hotkey: a fade, and an automatic switch-off', async () => {
    await page.evaluate(() => {
      const s = (window as any).mochiStudio;
      s.updateSettings({
        hotkeys: [
          ...s.settings.hotkeys,
          {
            id: 'desk',
            label: 'Desk',
            keys: '',
            button: true,
            action: { type: 'itemScene', scene: 'scene1', fade: 1 },
            release: 'timer',
            seconds: 2,
          },
        ],
      });
    });
    // Plugins see it as a «Toggle Item Scene» hotkey, known by the scene's name, and can fire it.
    const list = (await p1.request('HotkeysInCurrentModelRequest')).data.availableHotkeys;
    expect(list.find((x: any) => x.hotkeyID === 'desk')).toMatchObject({
      type: 'ToggleItemScene',
      file: 'Desk',
    });
    await p1.request('HotkeyTriggerRequest', { hotkeyID: 'desk' });
    await expect
      .poll(() => page.evaluate(() => (window as any).mochiStudio.isItemSceneOn('scene1')))
      .toBe(true);
    // Fading in: shown, partly transparent, then fully there.
    expect(await visible(page, 'mochiStudio', lamp)).toBe(true);
    const alpha = () =>
      page.evaluate((id) => (window as any).mochiStudio.runtime.itemTint(id)?.[3] ?? 1, lamp);
    expect(await alpha()).toBeLessThan(1);
    await expect.poll(alpha, { timeout: 3000 }).toBe(1);
    // Two seconds after it went on, it goes off by itself (fading out over a second).
    await expect
      .poll(() => page.evaluate(() => (window as any).mochiStudio.isItemSceneOn('scene1')), {
        timeout: 5000,
      })
      .toBe(false);
    await expect.poll(() => visible(page, 'mochiStudio', lamp), { timeout: 3000 }).toBe(false);
  });

  it('makes a hotkey for a scene from the Items sheet, and removes scenes', async () => {
    await openSection(page, 'Items');
    await page.locator('.scene[data-scene=scene2] .scene-hotkey').click();
    expect(
      await page.evaluate(() =>
        (window as any).mochiStudio.settings.hotkeys
          .filter((h: any) => h.action.type === 'itemScene')
          .map((h: any) => [h.label, h.action]),
      ),
    ).toEqual([
      ['Desk', { type: 'itemScene', scene: 'scene1', fade: 1 }],
      ['Bed', { type: 'itemScene', scene: 'scene2', fade: 0.5 }],
    ]);
    // The on-screen button shows the scene's state.
    await page.keyboard.press('Escape');
    const button = page.locator('.hotkey-buttons [data-hotkey=desk]');
    expect(await button.getAttribute('aria-pressed')).toBe('false');
    await button.click();
    await expect.poll(() => button.getAttribute('aria-pressed')).toBe('true');
    await openSection(page, 'Items');
    await page.locator('.scene[data-scene=scene1] .scene-remove').click();
    expect(await page.locator('.scene').count()).toBe(1);
    // Its items stay.
    expect(await page.evaluate(() => (window as any).mochiStudio.items.length)).toBe(2);
    await page.keyboard.press('Escape');
    for (const id of [lamp, mug]) await studio('removeItem', id);
  });
});

describe('expression toggle events', () => {
  it('says justLoaded only in the snapshot sent because a model loaded', async () => {
    await p1.request('EventSubscriptionRequest', {
      eventName: 'ExpressionToggledEvent',
      subscribe: true,
      config: {},
    });
    await loadModel(page);
    const e = await p1.next(ev('ExpressionToggledEvent'), 15_000);
    expect(e.data).toMatchObject({
      justLoaded: true,
      expressionFile: 'blush.exp3.json',
      active: false,
    });
    await p1.request('EventSubscriptionRequest', { subscribe: false });
    expect(errors).toEqual([]);
  });
});
