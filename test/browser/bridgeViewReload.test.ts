import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import type { BrowserContext, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { staticCatalog } from '../../bridge/src/mcp.ts';
import { BridgeServer } from '../../bridge/src/server.ts';
import { BridgeStore } from '../../bridge/src/store.ts';
import { syntheticModelFiles } from '../support/syntheticModel';
import { startHarness, syntheticItemZip, syntheticModelZip, type Harness } from './harness';

/**
 * A view through the bridge (OBS, in a browser profile of its own) stays
 * open while its control window reloads, and the window then opens the same
 * model again, or another. The view shows the model, is counted, gets the
 * parameters every frame and the items added after.
 */
let H: Harness;
let bridge: BridgeServer;
let page: Page;
let obsCtx: BrowserContext;
let out: Page;
const errors: string[] = [];
const MODEL = syntheticModelZip();
const OTHER = (() => {
  const files = syntheticModelFiles({ name: 'other', color: [90, 200, 120] });
  return zipSync(Object.fromEntries(Object.entries(files).map(([p, d]) => [`Other/${p}`, d])));
})();

const open = async (zip: Uint8Array, name: string) => {
  await page.locator('#model-zip').setInputFiles({
    name,
    mimeType: 'application/zip',
    buffer: Buffer.from(zip),
  });
  await page.waitForFunction((n) => (window as any).mochiStudio.model?.files.label === n, name, {
    timeout: 20_000,
  });
};
const linkState = () => page.evaluate(() => (window as any).mochiAgentLink.state as string);
const viewsShown = () => page.locator('#views-indicator').textContent();
const viewModel = () => out.evaluate(() => document.body.dataset.model);

/** The view follows the control window: a value set now arrives. */
async function followsParameters(value: number): Promise<void> {
  await page.evaluate((v) => ((window as any).mochiStudio.overrides = { ParamCustom: v }), value);
  await out.waitForFunction((v) => (window as any).mochiOutput.params.ParamCustom === v, value, {
    timeout: 15_000,
  });
}

beforeAll(async () => {
  H = await startHarness();
  bridge = new BridgeServer({
    port: 0,
    store: new BridgeStore(mkdtempSync(join(tmpdir(), 'mochi-bridge-reload-'))),
    catalog: staticCatalog(),
    log: () => undefined,
  });
  await bridge.listen();
  page = await H.context.newPage();
  page.on('pageerror', (e) => errors.push(`control: ${e.message}`));
  await page.goto(H.url);
  await page.waitForFunction(() => 'mochiStudio' in window);
  await page.evaluate(
    (u) => (window as any).mochiAgentLink.enableViews(u),
    `ws://127.0.0.1:${bridge.port}`,
  );
  await page.waitForFunction(() => (window as any).mochiAgentLink.state === 'pairing', null, {
    timeout: 20_000,
  });
  await page.evaluate((c) => (window as any).mochiAgentLink.pair(c), bridge.store.pairingCode());
  await page.waitForFunction(() => (window as any).mochiAgentLink.state === 'connected', null, {
    timeout: 20_000,
  });
  await open(MODEL, 'Test.zip');

  // OBS: a browser profile of its own, the view's address from the window.
  const url = await page.evaluate(() => (window as any).mochiAgentLink.viewUrl(location.href));
  obsCtx = await H.browser.newContext();
  out = await obsCtx.newPage();
  out.on('pageerror', (e) => errors.push(`view: ${e.message}`));
  await out.goto(url);
  await out.waitForFunction(
    () => document.body.dataset.model?.startsWith('test.model3.json'),
    null,
    {
      timeout: 30_000,
    },
  );
  await page.waitForFunction(
    () => document.querySelector('#views-indicator')?.textContent === 'Output views: 1',
    null,
    { timeout: 15_000 },
  );
}, 120_000);
afterAll(async () => {
  await obsCtx?.close();
  await bridge?.close();
  await H?.close();
});

describe('a view through the bridge while its control window reloads', () => {
  it('gets the same model again: counted, its parameters and a new item', async () => {
    await followsParameters(0.25);
    const loadsBefore = await out.evaluate(() => (window as any).mochiOutput.loadStats);
    await page.reload();
    await page.waitForFunction(() => 'mochiStudio' in window);
    // The window connects to the bridge again by itself (views and pairing are kept).
    await expect.poll(linkState, { timeout: 20_000 }).toBe('connected');
    // Meanwhile the view keeps showing the model it has.
    expect(await viewModel()).toMatch(/^test\.model3\.json/);
    await open(MODEL, 'Test.zip');
    await expect.poll(viewsShown, { timeout: 15_000 }).toBe('Output views: 1');
    await followsParameters(0.5);
    expect(await viewModel()).toMatch(/^test\.model3\.json/);
    // The same model: the view didn't load it again.
    expect(await out.evaluate(() => (window as any).mochiOutput.loadStats)).toEqual(loadsBefore);
    // An item added now reaches it, its files through the bridge.
    await page.locator('#item-zip').setInputFiles({
      name: 'Hat.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(syntheticItemZip()),
    });
    await out.waitForFunction(() => document.body.dataset.items === '1', null, { timeout: 30_000 });
    expect(errors).toEqual([]);
  });

  it('gets another model: shown, counted, its parameters', async () => {
    await page.reload();
    await page.waitForFunction(() => 'mochiStudio' in window);
    await expect.poll(linkState, { timeout: 20_000 }).toBe('connected');
    await open(OTHER, 'Other.zip');
    await out.waitForFunction(
      () => document.body.dataset.model?.startsWith('other.model3.json'),
      null,
      {
        timeout: 30_000,
      },
    );
    await expect.poll(viewsShown, { timeout: 15_000 }).toBe('Output views: 1');
    await followsParameters(0.75);
    // The view draws it.
    const drawn = await out.evaluate(async () => {
      const blob: Blob = await (window as any).mochiOutput.runtime.screenshot();
      return blob.size;
    });
    expect(drawn).toBeGreaterThan(1000);
    expect(errors).toEqual([]);
  });
});
