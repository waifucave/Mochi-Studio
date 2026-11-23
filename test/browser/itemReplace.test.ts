import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext, Page } from 'playwright-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { staticCatalog } from '../../bridge/src/mcp.ts';
import { BridgeServer } from '../../bridge/src/server.ts';
import { BridgeStore } from '../../bridge/src/store.ts';
import { syntheticModelFiles } from '../support/syntheticModel';
import { startHarness, syntheticItemZip, syntheticModelZip, type Harness } from './harness';

/**
 * An item whose files are replaced (a plugin's brightness redraws a still
 * picture; a collaborator shares another model) stays on the stage as it
 * was until the new files have loaded, in the window and in output views,
 * and views get the new files. Each test holds the new files' load open
 * itself (Mochi2D's `addItem` waits for the test), so no runner's timing
 * decides what a frame shows.
 */
let H: Harness;
let control: Page;
let bridge: BridgeServer;
let obsCtx: BrowserContext;
const errors: string[] = [];

/** Other files for an item: another settings file name, so a view's item tells which it has. */
const CAP = Object.entries(syntheticModelFiles({ name: 'cap', color: [60, 60, 220] })).map(
  ([p, d]) => [`Cap/${p}`, [...d]] as [string, number[]],
);
const STUDIO = '(window).mochiStudio.runtime';
const VIEW = '(window).mochiOutput.runtime';

const addItem = async (n: number) => {
  await control.locator('#item-zip').setInputFiles({
    name: `Hat${n}.zip`,
    mimeType: 'application/zip',
    buffer: Buffer.from(syntheticItemZip()),
  });
  await control.waitForFunction((n) => (window as any).mochiStudio.items.length === n, n);
  return control.evaluate(() => (window as any).mochiStudio.items.at(-1).id as string);
};

/** Replaces item `id`'s files with `CAP` in the window. */
const replaceWithCap = (id: string) =>
  control.evaluate(
    ({ id, files }) =>
      (window as any).mochiStudio.replaceItemFiles(
        id,
        files.map(([p, d]) => [p, new Uint8Array(d)]),
      ) as Promise<void>,
    { id, files: CAP },
  );

/**
 * Makes the next `addItem` of a page's view wait until `release()` (in the
 * page); `window.held` resolves once it has been asked for.
 */
const holdNextLoad = (p: Page, runtime: string) =>
  p.evaluate((runtime) => {
    const view = (0, eval)(runtime).view;
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
  }, runtime);

/** Whether the page's held load was asked for within 15 s. */
const loadAsked = (p: Page) =>
  p.evaluate(() =>
    Promise.race([
      (window as any).held.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 15_000)),
    ]),
  );

/** What each of the next `n` frames of a page shows of item `id`. */
const watchFrames = (p: Page, runtime: string, id: string, n: number) =>
  p.evaluate(
    async ({ runtime, id, n }) => {
      const rt = (0, eval)(runtime);
      const seen = [];
      for (let i = 0; i < n; i++) {
        await new Promise((r) => requestAnimationFrame(r));
        const item = rt.itemMap.get(id);
        seen.push({
          drawn: !!item && rt.view.items.includes(item),
          opacity: item?.opacity as number | undefined,
          mirror: item?.mirror as boolean | undefined,
          order: rt.itemOrder() as string[],
        });
      }
      return seen;
    },
    { runtime, id, n },
  );

beforeAll(async () => {
  H = await startHarness();
  bridge = new BridgeServer({
    port: 0,
    store: new BridgeStore(mkdtempSync(join(tmpdir(), 'mochi-bridge-replace-'))),
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

describe('an item whose files are replaced', () => {
  // Each test starts with no items, and no load held by one before.
  beforeEach(async () => {
    await control.evaluate(() => {
      (window as any).release?.();
      const s = (window as any).mochiStudio;
      for (const i of [...s.items]) s.removeItem(i.id);
    });
    await control.waitForFunction(() => (window as any).mochiStudio.runtime.items().length === 0);
  });

  it('stays drawn as it was until its new files have loaded, then is swapped in one step', async () => {
    const a = await addItem(1);
    const b = await addItem(2);
    const set = await control.evaluate(
      ({ a, b }) => {
        const rt = (window as any).mochiStudio.runtime;
        rt.setItemOpacity(a, 0.5);
        rt.placeItem(a, { mirror: true, scale: 0.7, x: 0.1 });
        const mesh = rt.artMeshIds()[0] as string;
        rt.setItemSort(a, { below: mesh }, null);
        rt.stackItems([a, b]); // a below b
        return {
          mesh,
          order: rt.itemOrder() as string[],
          placement: rt.items().find((i: any) => i.id === a).placement,
        };
      },
      { a, b },
    );
    expect(set.order).toEqual([a, b]);
    await holdNextLoad(control, STUDIO);
    const done = replaceWithCap(a);
    await control.evaluate(() => (window as any).held);
    // Every frame while the new files load shows the item as it was.
    for (const f of await watchFrames(control, STUDIO, a, 6))
      expect(f).toEqual({ drawn: true, opacity: 0.5, mirror: true, order: [a, b] });
    expect(
      await control.evaluate((a) => (window as any).mochiStudio.runtime.itemOpacity(a), a),
    ).toBe(0.5);
    await control.evaluate(() => (window as any).release());
    await done;
    // The new item has all the old one had, and the old one is gone.
    const after = await control.evaluate((a) => {
      const rt = (window as any).mochiStudio.runtime;
      return {
        name: rt.itemMap.get(a).name as string,
        drawn: rt.view.items.length as number,
        order: rt.itemOrder() as string[],
        opacity: rt.itemOpacity(a) as number,
        placement: rt.items().find((i: any) => i.id === a).placement,
        sort: rt.itemSort(a),
        layoutIds: rt.exportItemLayout().items.map((e: any) => e.id) as string[],
      };
    }, a);
    expect(after).toMatchObject({
      name: expect.stringMatching(/cap\.model3\.json$/),
      drawn: 2,
      order: [a, b],
      opacity: 0.5,
      placement: set.placement,
      sort: { layer: { below: set.mesh }, split: null },
      layoutIds: [a, b],
    });
    for (const f of await watchFrames(control, STUDIO, a, 2))
      expect(f).toEqual({ drawn: true, opacity: 0.5, mirror: true, order: [a, b] });
    // Its layout, saved and applied again, finds it by Mochi Studio's id.
    expect(
      await control.evaluate((a) => {
        const rt = (window as any).mochiStudio.runtime;
        const layout = rt.exportItemLayout();
        rt.setItemOpacity(a, 1);
        rt.applyItemLayout(layout);
        return rt.itemOpacity(a) as number;
      }, a),
    ).toBe(0.5);
  });

  it('stays removed when it is removed while its new files load', async () => {
    const a = await addItem(1);
    await holdNextLoad(control, STUDIO);
    const done = replaceWithCap(a);
    await control.evaluate(() => (window as any).held);
    await control.evaluate((a) => (window as any).mochiStudio.removeItem(a), a);
    await control.evaluate(() => (window as any).release());
    await done;
    expect(
      await control.evaluate(() => {
        const rt = (window as any).mochiStudio.runtime;
        return { items: rt.items().length, drawn: rt.view.items.length };
      }),
    ).toEqual({ items: 0, drawn: 0 });
    // Nor are its new files kept, for views or in the browser's storage.
    expect(
      await control.evaluate(
        (a) => (window as any).mochiStudio.itemFilesOf(a).then((f: unknown) => f ?? null),
        a,
      ),
    ).toBeNull();
  });

  it("reaches output views, which keep it drawn until they've loaded the new files", async () => {
    const a = await addItem(1);
    await control.evaluate((a) => (window as any).mochiStudio.runtime.setItemOpacity(a, 0.5), a);
    // A view on the browser's channel, and one through the bridge.
    const local = await H.context.newPage();
    local.on('pageerror', (e) => errors.push(`view: ${e.message}`));
    // What each view logs as an error, to tell why it lacks an item.
    const logged = { local: [] as string[], remote: [] as string[] };
    local.on('console', (m) => m.type() === 'error' && logged.local.push(m.text()));
    await local.goto(new URL('output.html', H.url).href, { timeout: 60_000 });
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
    const url = await control.evaluate(() => (window as any).mochiAgentLink.viewUrl(location.href));
    obsCtx = await H.browser.newContext();
    const remote = await obsCtx.newPage();
    remote.on('pageerror', (e) => errors.push(`bridge view: ${e.message}`));
    remote.on('console', (m) => m.type() === 'error' && logged.remote.push(m.text()));
    await remote.goto(url, { timeout: 60_000 });
    const viewItemName = (v: Page) =>
      v.evaluate(
        (a) => (window as any).mochiOutput.runtime.itemMap.get(a)?.name as string | undefined,
        a,
      );
    /** A view's items, and (for a failure) its model, link, load state and errors. */
    const viewState = async (n: 'local' | 'remote', v: Page) => ({
      view: n,
      items: await v.evaluate(() => [...(window as any).mochiOutput.runtime.itemMap.keys()]),
      ...(await v.evaluate(() => ({
        model: document.body.dataset.model,
        bridge: document.body.dataset.bridge,
      }))),
      status: await control.evaluate(() =>
        [...(window as any).mochiStudio.viewStatus.values()].map((s: any) => s.state),
      ),
      logged: logged[n],
    });
    for (const [n, v] of [
      ['local', local],
      ['remote', remote],
    ] as const) {
      // Each view has this item, and no other.
      await expect.poll(() => viewState(n, v), { timeout: 60_000 }).toMatchObject({ items: [a] });
      expect(await viewItemName(v)).toMatch(/hat\.model3\.json$/);
      await expect
        .poll(() => v.evaluate((a) => (window as any).mochiOutput.runtime.itemOpacity(a), a), {
          timeout: 15_000,
        })
        .toBe(0.5);
      await holdNextLoad(v, VIEW);
    }
    await replaceWithCap(a);
    for (const v of [local, remote]) {
      expect(await loadAsked(v), 'the view loads the new files').toBe(true);
      for (const f of await watchFrames(v, VIEW, a, 4))
        expect(f).toMatchObject({ drawn: true, opacity: 0.5 });
      await v.evaluate(() => (window as any).release());
      await expect.poll(() => viewItemName(v), { timeout: 30_000 }).toMatch(/cap\.model3\.json$/);
      for (const f of await watchFrames(v, VIEW, a, 2))
        expect(f).toMatchObject({ drawn: true, opacity: 0.5 });
      expect(await v.evaluate(() => (window as any).mochiOutput.runtime.view.items.length)).toBe(1);
    }
    // Replaced again: the bridge keeps only the files views can still ask for.
    await control.evaluate(async (a) => {
      const s = (window as any).mochiStudio;
      await s.replaceItemFiles(a, [...(await s.itemFilesOf(a))]);
    }, a);
    const owners = () =>
      [...((bridge as any).cache as Map<string, unknown>).keys()]
        .filter((k) => k.startsWith('item/'))
        .map((k) => decodeURIComponent(k.split('/')[1]!));
    await expect
      .poll(() => owners().length > 0 && owners().every((o) => o === `${a}@2`), {
        timeout: 15_000,
      })
      .toBe(true);
    expect(errors).toEqual([]);
  }, 180_000);
});
