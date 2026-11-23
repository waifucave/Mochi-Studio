import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import type { BrowserContext, Page } from 'playwright-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { staticCatalog } from '../../bridge/src/mcp.ts';
import { BridgeServer } from '../../bridge/src/server.ts';
import { BridgeStore } from '../../bridge/src/store.ts';
import { syntheticModelFiles } from '../support/syntheticModel';
import { startHarness, syntheticItemZip, syntheticModelZip, type Harness } from './harness';

/**
 * An output view that misses a file once (a slow bridge, a busy computer)
 * tries again, a few times with a pause between, and says so in the
 * control window's log; then gives up until it is opened again. Each test
 * makes the load fail itself (Mochi2D's load throws, or the bridge's file
 * is answered with an error), so no runner's timing decides it. `?retry=`
 * makes the pauses short.
 */
let H: Harness;
let control: Page;
let bridge: BridgeServer;
let obsCtx: BrowserContext | undefined;
const errors: string[] = [];
/** The pause between tries in these views: over a second, as the bridge passes a view's log once a second. */
const RETRY_MS = 1100;

const addItem = async () => {
  const n = await control.evaluate(() => (window as any).mochiStudio.items.length as number);
  await control.locator('#item-zip').setInputFiles({
    name: 'Hat1.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(syntheticItemZip()),
  });
  await control.waitForFunction((n) => (window as any).mochiStudio.items.length === n + 1, n);
  return control.evaluate(() => (window as any).mochiStudio.items.at(-1).id as string);
};

/** The window's log since `since` entries: [kind, text]. */
const logSince = (since: number) =>
  control.evaluate(
    (since) =>
      ((window as any).mochiLog.entries as Array<{ kind: string; text: string }>)
        .slice(since)
        .map((e) => [e.kind, e.text] as [string, string]),
    since,
  );
const logLength = () => control.evaluate(() => (window as any).mochiLog.entries.length as number);

const viewItems = (v: Page) =>
  v.evaluate(() => [...(window as any).mochiOutput.runtime.itemMap.keys()] as string[]);

/**
 * Makes a view's next `n` item loads (Mochi2D's `addItem`) throw; counts
 * every load asked for in `window.loads`.
 */
const failItemLoads = (v: Page, n: number) =>
  v.evaluate((n) => {
    const view = (window as any).mochiOutput.runtime.view;
    const orig = view.__origAddItem ?? view.addItem;
    view.__origAddItem = orig;
    (window as any).loads = 0;
    let left = n;
    view.addItem = function (this: unknown, ...args: unknown[]) {
      (window as any).loads++;
      if (left-- > 0) return Promise.reject(new Error('made to fail by the test'));
      return orig.apply(this, args);
    };
  }, n);

const openLocalView = async () => {
  const v = await H.context.newPage();
  v.on('pageerror', (e) => errors.push(`view: ${e.message}`));
  await v.goto(new URL(`output.html?retry=${RETRY_MS}`, H.url).href, { timeout: 60_000 });
  await v.waitForFunction(() => (window as any).mochiOutput.modelReady, null, { timeout: 30_000 });
  return v;
};

beforeAll(async () => {
  H = await startHarness();
  bridge = new BridgeServer({
    port: 0,
    store: new BridgeStore(mkdtempSync(join(tmpdir(), 'mochi-bridge-retry-'))),
    catalog: staticCatalog(),
    log: () => undefined,
  });
  await bridge.listen();
  control = await H.context.newPage();
  control.on('pageerror', (e) => errors.push(`control: ${e.message}`));
  await control.goto(H.url);
  await control.waitForFunction(() => 'mochiStudio' in window);
  await control.locator('#model-zip').setInputFiles({
    name: 'Test.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(syntheticModelZip()),
  });
  await control.waitForFunction(() => (window as any).mochiStudio.settings !== undefined);
}, 60_000);
afterAll(async () => {
  await obsCtx?.close();
  await bridge?.close();
  await H?.close();
});

describe('an output view that misses a file', () => {
  beforeEach(async () => {
    await control.evaluate(() => {
      const s = (window as any).mochiStudio;
      for (const i of [...s.items]) s.removeItem(i.id);
    });
  });

  it('loads an item on a later try, and the window says so', async () => {
    const view = await openLocalView();
    await failItemLoads(view, 2);
    const since = await logLength();
    const a = await addItem();
    await expect.poll(() => viewItems(view), { timeout: 30_000 }).toEqual([a]);
    expect(await view.evaluate(() => (window as any).loads)).toBe(3);
    const log = await logSince(since);
    // Twice the same line: the log shows it once, counted.
    expect(log.filter(([, t]) => t.startsWith('An output view could not load “Hat1”'))).toEqual([
      [
        'error',
        'An output view could not load “Hat1” (made to fail by the test); it tries again in 1.1 s.',
      ],
    ]);
    expect(
      await control.evaluate(
        () =>
          (window as any).mochiLog.entries.find((e: any) =>
            e.text.startsWith('An output view could not load “Hat1”'),
          ).count,
      ),
    ).toBe(2);
    expect(log).toContainEqual(['info', 'An output view has loaded “Hat1” (try 3) now.']);
    await view.close();
  });

  it('gives up after five tries, until the item has other files', async () => {
    const view = await openLocalView();
    await failItemLoads(view, Infinity);
    const since = await logLength();
    const a = await addItem();
    await expect
      .poll(() => logSince(since), { timeout: 30_000 })
      .toContainEqual(['error', expect.stringMatching(/gave up loading “Hat1”.*after 5 tries/)]);
    expect(await view.evaluate(() => (window as any).loads)).toBe(5);
    // No more tries: the window's next messages (here, it hides and shows the item) leave it.
    await control.evaluate((a) => (window as any).mochiStudio.setItemVisible(a, false), a);
    await control.evaluate((a) => (window as any).mochiStudio.setItemVisible(a, true), a);
    await view.waitForTimeout(3 * RETRY_MS);
    expect(await view.evaluate(() => (window as any).loads)).toBe(5);
    expect(await viewItems(view)).toEqual([]);
    // Other files (a new version) are tried again; this time they load.
    await failItemLoads(view, 0);
    await control.evaluate(async (a) => {
      const s = (window as any).mochiStudio;
      await s.replaceItemFiles(a, [...(await s.itemFilesOf(a))]);
    }, a);
    await expect.poll(() => viewItems(view), { timeout: 30_000 }).toEqual([a]);
    await view.close();
  });

  it('loads the model on a later try, then its items', async () => {
    const view = await openLocalView();
    const a = await addItem();
    await expect.poll(() => viewItems(view), { timeout: 30_000 }).toEqual([a]);
    // (Items are kept with their model: this one would come back with it in the next test.)
    await control.evaluate((a) => (window as any).mochiStudio.removeItem(a), a);
    // Another model: the view's first load of it fails.
    await view.evaluate(() => {
      const rt = (window as any).mochiOutput.runtime;
      const orig = rt.load;
      (window as any).modelLoads = 0;
      rt.load = function (this: unknown, ...args: unknown[]) {
        if ((window as any).modelLoads++ === 0)
          return Promise.reject(new Error('made to fail by the test'));
        return orig.apply(this, args);
      };
    });
    const since = await logLength();
    const other = Object.fromEntries(
      Object.entries(syntheticModelFiles({ name: 'other', color: [90, 200, 90] })).map(([p, d]) => [
        `Other/${p}`,
        d,
      ]),
    );
    await control.locator('#model-zip').setInputFiles({
      name: 'Other.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(zipSync(other)),
    });
    await control.waitForFunction(() =>
      (window as any).mochiStudio.model?.key.startsWith('other.model3.json'),
    );
    const b = await addItem();
    await expect
      .poll(() => view.evaluate(() => document.body.dataset.model), { timeout: 30_000 })
      .toMatch(/^other\.model3\.json/);
    await expect.poll(() => viewItems(view), { timeout: 30_000 }).toEqual([b]);
    expect(await view.evaluate(() => (window as any).modelLoads)).toBe(2);
    const log = await logSince(since);
    expect(log).toContainEqual([
      'error',
      expect.stringMatching(
        /^An output view could not load the model \(made to fail by the test\)\. It tries again in 1\.1 s \(try 2 of 5\)\.$/,
      ),
    ]);
    expect(log).toContainEqual(['info', 'An output view has loaded the model now (try 2).']);
    await view.close();
    // Back to the first model for the next test.
    await control.locator('#model-zip').setInputFiles({
      name: 'Test.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(syntheticModelZip()),
    });
    await control.waitForFunction(() =>
      (window as any).mochiStudio.model?.key.startsWith('test.model3.json'),
    );
  });

  it('through the bridge: loads the model and an item whose files failed once', async () => {
    await control.evaluate(
      (u) => (window as any).mochiAgentLink.enableViews(u),
      `ws://127.0.0.1:${bridge.port}`,
    );
    await control.waitForFunction(() => (window as any).mochiAgentLink.state === 'pairing', null, {
      timeout: 20_000,
    });
    await control.evaluate(
      (c) => (window as any).mochiAgentLink.pair(c),
      bridge.store.pairingCode(),
    );
    await control.waitForFunction(
      () => (window as any).mochiAgentLink.state === 'connected',
      null,
      { timeout: 20_000 },
    );
    const a = await addItem();
    const url = await control.evaluate(() => (window as any).mochiAgentLink.viewUrl(location.href));
    obsCtx = await H.browser.newContext();
    const view = await obsCtx.newPage();
    view.on('pageerror', (e) => errors.push(`bridge view: ${e.message}`));
    // The first fetch of the model's settings file and of the item's fail (a busy bridge).
    const failed: string[] = [];
    const failOnce = async (pattern: string) =>
      view.route(pattern, (route) => {
        if (failed.includes(pattern)) return route.continue();
        failed.push(pattern);
        return route.fulfill({ status: 503, body: 'Busy.' });
      });
    await failOnce('**/files/model/**/test.model3.json*');
    await failOnce('**/files/item/**/hat.model3.json*');
    const since = await logLength();
    await view.goto(`${url}&retry=${RETRY_MS}`, { timeout: 60_000 });
    await expect.poll(() => viewItems(view), { timeout: 60_000 }).toEqual([a]);
    const log = await logSince(since);
    const said = `failed: ${JSON.stringify(failed)}\nlog: ${JSON.stringify(log, null, 1)}`;
    expect(failed, said).toHaveLength(2);
    expect(log, said).toContainEqual([
      'error',
      expect.stringMatching(/^An output view could not load the model .*\(try 2 of 5\)\.$/),
    ]);
    expect(log, said).toContainEqual([
      'error',
      expect.stringMatching(/^An output view could not load “Hat1” .*tries again in 1\.1 s\.$/),
    ]);
    expect(log, said).toContainEqual(['info', 'An output view has loaded “Hat1” (try 2) now.']);
    expect(errors).toEqual([]);
  }, 120_000);

  it('through the bridge: connects again when its hello came too late, and is not told its key is wrong', async () => {
    // (After the test above: the window is paired with the bridge.)
    const a = await addItem();
    const url = await control.evaluate(() => (window as any).mochiAgentLink.viewUrl(location.href));
    const view = await obsCtx!.newPage();
    view.on('pageerror', (e) => errors.push(`bridge view: ${e.message}`));
    // The view's first view_hello is never sent (on a busy computer it can come after the
    // bridge's limit), and the codes its connections close with are noted.
    await view.addInitScript(() => {
      const w = window as any;
      w.closes = [];
      const send = WebSocket.prototype.send;
      let dropped = false;
      WebSocket.prototype.send = function (this: WebSocket, d: any) {
        if (!dropped && typeof d === 'string' && d.includes('"view_hello"')) {
          dropped = true;
          return;
        }
        return send.call(this, d);
      };
      const Orig = WebSocket;
      w.WebSocket = class extends Orig {
        constructor(u: string | URL, p?: string | string[]) {
          super(u, p);
          this.addEventListener('close', (e) => w.closes.push(e.code));
        }
      };
    });
    const opts = (bridge as any).opts as { helloTimeoutMs: number };
    const limit = opts.helloTimeoutMs;
    opts.helloTimeoutMs = 500;
    try {
      await view.goto(url, { timeout: 60_000 });
      await expect
        .poll(() => view.evaluate(() => (window as any).closes.length), { timeout: 20_000 })
        .toBeGreaterThan(0);
    } finally {
      opts.helloTimeoutMs = limit;
    }
    const state = () =>
      view.evaluate(() => ({
        closes: (window as any).closes as number[],
        bridge: document.body.dataset.bridge,
        items: [...(window as any).mochiOutput.runtime.itemMap.keys()] as string[],
      }));
    const first = await state();
    expect(first.closes[0], JSON.stringify(first)).toBe(4408);
    await expect
      .poll(state, { timeout: 60_000 })
      .toMatchObject({ bridge: 'connected', items: [a] });
    await view.close();
    expect(errors).toEqual([]);
  }, 120_000);
});

/**
 * Makes the next item load (Mochi2D's `addItem`) of a page's view wait
 * until `release()` (in the page); `window.held` resolves once it has been
 * asked for.
 */
const holdNextLoad = (v: Page) =>
  v.evaluate(() => {
    const view = (window as any).mochiOutput.runtime.view;
    const orig = view.addItem;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let asked!: () => void;
    (window as any).held = new Promise<void>((r) => (asked = r));
    (window as any).release = release;
    view.addItem = async function (this: unknown, ...args: unknown[]) {
      view.addItem = orig;
      asked();
      await gate;
      return orig.apply(this, args);
    };
  });

describe("an output view keeps to the window's latest list", () => {
  // Messages from the window pile up while a view loads an item: it ends with what the window
  // lists last, whatever came between (no older list wins, no id is kept that the window
  // no longer has).
  it('while one of its loads is held, in a view on the channel and one through the bridge', async () => {
    for (const i of await control.evaluate(() => (window as any).mochiStudio.items))
      await control.evaluate((id) => (window as any).mochiStudio.removeItem(id), i.id);
    const local = await openLocalView();
    const url = await control.evaluate(() => (window as any).mochiAgentLink.viewUrl(location.href));
    const remote = await obsCtx!.newPage();
    await remote.goto(`${url}&retry=${RETRY_MS}`, { timeout: 60_000 });
    await remote.waitForFunction(() => (window as any).mochiOutput.modelReady, null, {
      timeout: 30_000,
    });
    for (const v of [local, remote]) await holdNextLoad(v);
    const a = await addItem();
    for (const v of [local, remote]) await v.evaluate(() => (window as any).held);
    // While both views wait on a's files: b comes, a goes, b's files change twice.
    const b = await addItem();
    await control.evaluate((a) => (window as any).mochiStudio.removeItem(a), a);
    for (let n = 0; n < 2; n++)
      await control.evaluate(async (b) => {
        const s = (window as any).mochiStudio;
        await s.replaceItemFiles(b, [...(await s.itemFilesOf(b))]);
      }, b);
    for (const v of [local, remote]) await v.evaluate(() => (window as any).release());
    for (const v of [local, remote]) {
      await expect.poll(() => viewItems(v), { timeout: 30_000 }).toEqual([b]);
      // Its newest files: the window's version 2, and one item drawn.
      expect(await v.evaluate(() => (window as any).mochiOutput.runtime.view.items.length)).toBe(1);
    }
    expect(
      await control.evaluate(() => (window as any).mochiStudio.items.map((i: any) => i.id)),
    ).toEqual([b]);
    await local.close();
    await remote.close();
    expect(errors).toEqual([]);
  }, 120_000);
});
