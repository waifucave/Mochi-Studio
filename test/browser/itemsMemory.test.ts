import { randomFillSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { chromium, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { heapOf, processMemory } from '../support/processMemory';
import { syntheticModelFiles } from '../support/syntheticModel';
import { startHarness, syntheticModelZip, type Harness } from './harness';

/**
 * The control window's memory while items are added, with no output view
 * open and with one (an output view in the same browser, over its
 * BroadcastChannel). The control window runs in a browser of its own, so
 * its processes can be read (Linux).
 *
 * A measurement, not part of the suite: MOCHI_MEASURE_ITEMS=1 runs it,
 * MOCHI_MEASURE_OUT=file.json keeps the numbers.
 */
const on = process.env.MOCHI_MEASURE_ITEMS === '1';
const MB = 2 ** 20;
const ITEMS = 6;
const PAD = 20 * MB;
let H: Harness;
let dir: string;
const results: Record<string, unknown> = {};

/** An item model with a 20 MB file beside it, as a zip on disk. */
function itemZip(i: number): string {
  const files: Record<string, Uint8Array> = {};
  const item = syntheticModelFiles({
    name: `prop${i}`,
    color: [200, 40 * i, 60],
    withItemExtras: true,
  });
  for (const [p, d] of Object.entries(item)) files[`Prop${i}/${p}`] = d;
  files[`Prop${i}/extra/pad.bin`] = randomFillSync(new Uint8Array(PAD));
  const path = join(dir, `prop${i}.zip`);
  writeFileSync(path, zipSync(files, { level: 0 }));
  return path;
}

async function run(withView: boolean): Promise<Record<string, number>> {
  const srv = await chromium.launchServer({
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  });
  const browser = await chromium.connect(srv.wsEndpoint());
  const ctx = await browser.newContext({ viewport: { width: 900, height: 600 } });
  const control = await ctx.newPage();
  await control.goto(H.url);
  await control.waitForFunction(() => 'mochiStudio' in window);
  await control.locator('#model-zip').setInputFiles({
    name: 'Test.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(syntheticModelZip()),
  });
  await control.waitForFunction(() => (window as any).mochiStudio.settings !== undefined);
  let view: Page | undefined;
  if (withView) {
    view = await ctx.newPage();
    await view.goto(new URL('output.html', H.url).href);
    await view.waitForFunction(() => document.body.dataset.model !== undefined, undefined, {
      timeout: 30_000,
    });
  }
  const pid = srv.process().pid!;
  const controlHeap = await heapOf(control);
  const viewHeap = view ? await heapOf(view) : undefined;
  const peak = { control: 0, view: 0, allRss: 0 };
  const sample = async () => {
    peak.control = Math.max(peak.control, await controlHeap());
    if (viewHeap) peak.view = Math.max(peak.view, await viewHeap());
    peak.allRss = Math.max(peak.allRss, processMemory(pid).allRss);
  };
  await sample();
  const base = { ...peak };
  let running = true;
  const loop = (async () => {
    while (running) {
      await sample().catch(() => undefined);
      await new Promise((r) => setTimeout(r, 100));
    }
  })();
  const t0 = Date.now();
  for (let i = 0; i < ITEMS; i++) {
    await control.locator('#item-zip').setInputFiles(itemZip(i));
    await control.waitForFunction((n) => (window as any).mochiStudio.items.length === n, i + 1, {
      timeout: 60_000,
    });
  }
  if (view)
    await view.waitForFunction((n) => document.body.dataset.items === String(n), ITEMS, {
      timeout: 120_000,
    });
  await new Promise((r) => setTimeout(r, 2000));
  running = false;
  await loop;
  const after = { control: await controlHeap(), view: viewHeap ? await viewHeap() : 0 };
  const m = processMemory(pid);
  await browser.close();
  await srv.close();
  return {
    seconds: (Date.now() - t0) / 1000,
    itemsMB: (ITEMS * PAD) / MB,
    controlHeapBaselineMB: base.control / MB,
    controlHeapPeakMB: peak.control / MB,
    controlHeapAfterMB: after.control / MB,
    ...(view
      ? {
          viewHeapBaselineMB: base.view / MB,
          viewHeapPeakMB: peak.view / MB,
          viewHeapAfterMB: after.view / MB,
        }
      : {}),
    rendererPeakVmHWMMB: m.rendererPeak / MB,
    allProcessesBaselineRssMB: base.allRss / MB,
    allProcessesPeakRssMB: peak.allRss / MB,
  };
}

/** Loading a model of about 150 MB (the synthetic model and five files of 30 MB) with no view open. */
async function loadModelAlone(): Promise<Record<string, number>> {
  const files: Record<string, Uint8Array> = {};
  for (const [p, d] of Object.entries(syntheticModelFiles())) files[`Big/${p}`] = d;
  for (let i = 0; i < 5; i++)
    files[`Big/extra/pad${i}.bin`] = randomFillSync(new Uint8Array(30 * MB));
  const zip = join(dir, 'big.zip');
  writeFileSync(zip, zipSync(files, { level: 0 }));
  const srv = await chromium.launchServer({
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  });
  const browser = await chromium.connect(srv.wsEndpoint());
  const ctx = await browser.newContext({ viewport: { width: 900, height: 600 } });
  const control = await ctx.newPage();
  await control.goto(H.url);
  await control.waitForFunction(() => 'mochiStudio' in window);
  const pid = srv.process().pid!;
  const base = processMemory(pid);
  let peak = { rendererRss: 0, allRss: 0 };
  let running = true;
  const loop = (async () => {
    while (running) {
      const m = processMemory(pid);
      peak = {
        rendererRss: Math.max(peak.rendererRss, m.rendererRss),
        allRss: Math.max(peak.allRss, m.allRss),
      };
      await new Promise((r) => setTimeout(r, 100));
    }
  })();
  await control.locator('#model-zip').setInputFiles(zip);
  await control.waitForFunction(
    () => (window as any).mochiStudio.settings !== undefined,
    undefined,
    {
      timeout: 120_000,
    },
  );
  await new Promise((r) => setTimeout(r, 2000));
  running = false;
  await loop;
  const m = processMemory(pid);
  await browser.close();
  await srv.close();
  return {
    modelMB: (5 * 30 * MB) / MB,
    rendererBaselineRssMB: base.rendererRss / MB,
    rendererPeakRssMB: peak.rendererRss / MB,
    rendererPeakVmHWMMB: m.rendererPeak / MB,
    allProcessesBaselineRssMB: base.allRss / MB,
    allProcessesPeakRssMB: peak.allRss / MB,
  };
}

describe.skipIf(!on)('the control window’s memory as items are added, measured', () => {
  beforeAll(async () => {
    H = await startHarness();
    dir = mkdtempSync(join(tmpdir(), 'mochi-items-'));
  }, 120_000);
  afterAll(async () => {
    if (process.env.MOCHI_MEASURE_OUT)
      writeFileSync(process.env.MOCHI_MEASURE_OUT, JSON.stringify(results, null, 2));
    console.log(JSON.stringify(results, null, 2));
    await H?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('with no output view open', { timeout: 600_000 }, async () => {
    results.noView = await run(false);
    expect(results.noView).toBeDefined();
  });

  it('a model of 150 MB loaded with no view open', { timeout: 600_000 }, async () => {
    results.modelAlone = await loadModelAlone();
    expect(results.modelAlone).toBeDefined();
  });

  it('with one output view open', { timeout: 600_000 }, async () => {
    results.oneView = await run(true);
    expect(results.oneView).toBeDefined();
  });
});
