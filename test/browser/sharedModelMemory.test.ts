import { randomFillSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { chromium, type Browser, type BrowserServer, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startSignalingServer } from '../../collab/server';
import { syntheticModelFiles } from '../support/syntheticModel';
import { processMemory } from '../support/processMemory';
import { startHarness, type Harness } from './harness';

/**
 * The receiver's memory in a collaboration of three (docs/collaboration.md,
 * the limits): two participants share models at the caps, or announce more
 * than the caps. The receiver runs in a browser of its own, so its renderer
 * process can be found and its peak memory read (VmHWM, Linux).
 *
 * A measurement, not part of the suite: MOCHI_MEASURE_SHARED=1 runs it,
 * MOCHI_MEASURE_OUT=file.json keeps the numbers.
 */
const on = process.env.MOCHI_MEASURE_SHARED === '1';
const MB = 2 ** 20;
let H: Harness;
let server: Awaited<ReturnType<typeof startSignalingServer>>;
let dir: string;
/** The synthetic model alone (well under 1 MB): the receiver's own, and the crafted senders'. */
let small: string;
const results: Record<string, unknown> = {};

/** A model at the shared caps: the synthetic model and five 31 MB files beside it (< 160 MB). */
function modelAtCaps(name: string): string {
  const files: Record<string, Uint8Array> = {};
  for (const [p, d] of Object.entries(syntheticModelFiles())) files[`${name}/${p}`] = d;
  for (let i = 0; i < 5; i++)
    files[`${name}/extra/pad${i}.bin`] = randomFillSync(new Uint8Array(31 * MB));
  const path = join(dir, `${name}.zip`);
  writeFileSync(path, zipSync(files, { level: 0 }));
  return path;
}

async function app(browser: Browser, name: string, zip: string): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 600 } });
  const p = await ctx.newPage();
  await p.goto(H.url);
  await p.waitForFunction(() => 'mochiStudio' in window && 'mochiCollab' in window);
  await p.locator('#model-zip').setInputFiles(zip);
  await p.waitForFunction(() => (window as any).mochiStudio.settings !== undefined, undefined, {
    timeout: 60_000,
  });
  await p.evaluate(
    ({ server, name }) => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      });
      const s = (window as any).mochiStudio;
      s.setCollabSettings({ server, nickname: name, hideAddress: false });
      s.updateSettings({ collabSharing: 'shared' });
    },
    { server: server.wsUrl, name },
  );
  return p;
}

/** Samples the receiver while `work` runs: its page's JS heap and backing stores, and its processes. */
async function measure(
  receiver: Page,
  pid: number,
  work: () => Promise<void>,
): Promise<Record<string, number>> {
  const cdp = await receiver.context().newCDPSession(receiver);
  const peak = { heapAndBuffers: 0, rendererRss: 0, allRss: 0 };
  let running = true;
  const sample = async () => {
    const h = (await cdp.send('Runtime.getHeapUsage')) as {
      usedSize: number;
      backingStorageSize?: number;
      embedderHeapUsedSize?: number;
    };
    peak.heapAndBuffers = Math.max(
      peak.heapAndBuffers,
      h.usedSize + (h.backingStorageSize ?? 0) + (h.embedderHeapUsedSize ?? 0),
    );
    const m = processMemory(pid);
    peak.rendererRss = Math.max(peak.rendererRss, m.rendererRss);
    peak.allRss = Math.max(peak.allRss, m.allRss);
  };
  await sample();
  const before = { ...peak };
  const loop = (async () => {
    while (running) {
      await sample().catch(() => undefined);
      await new Promise((r) => setTimeout(r, 200));
    }
  })();
  const t0 = Date.now();
  await work();
  // A little longer, for what loading the avatars takes after the files.
  await new Promise((r) => setTimeout(r, 3000));
  running = false;
  await loop;
  const m = processMemory(pid);
  return {
    seconds: (Date.now() - t0) / 1000,
    baselineHeapAndBuffersMB: before.heapAndBuffers / MB,
    peakHeapAndBuffersMB: peak.heapAndBuffers / MB,
    baselineRendererRssMB: before.rendererRss / MB,
    peakRendererRssMB: peak.rendererRss / MB,
    rendererPeakVmHWMMB: m.rendererPeak / MB,
    peakAllProcessesRssMB: peak.allRss / MB,
  };
}

/** A session: the receiver hosts in its own browser; the two senders join and are let in. */
async function session(zipA: string, zipB: string, own0: string) {
  const srv: BrowserServer = await chromium.launchServer({
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  });
  const own = await chromium.connect(srv.wsEndpoint());
  const receiver = await app(own, 'Receiver', own0);
  const a = await app(H.browser, 'Aki', zipA);
  const b = await app(H.browser, 'Bo', zipB);
  await receiver.evaluate(() => (window as any).mochiCollab.host());
  await receiver.waitForFunction(() => (window as any).mochiCollab.session?.link);
  const link = await receiver.evaluate(() => (window as any).mochiCollab.session.link as string);
  // The receiver shares nothing itself, so only what it receives counts.
  await receiver.evaluate(() =>
    (window as any).mochiStudio.updateSettings({ collabSharing: 'video' }),
  );
  const close = async () => {
    for (const p of [a, b]) await p.context().close();
    await own.close();
    await srv.close();
  };
  const join = async (p: Page) => {
    await p.evaluate((l) => (window as any).mochiCollab.join(l), link);
    await receiver.waitForFunction(
      () => (window as any).mochiCollab.session.knocks.size > 0,
      undefined,
      {
        timeout: 20_000,
      },
    );
    await receiver.evaluate(() => {
      const s = (window as any).mochiCollab.session;
      s.admit([...s.knocks.keys()][0]);
    });
    await p.waitForFunction(
      () => (window as any).mochiCollab.session.status === 'member',
      undefined,
      {
        timeout: 20_000,
      },
    );
  };
  return { receiver, a, b, pid: srv.process().pid!, join, close };
}

/** The receiver's participants, as numbers. */
const people = (p: Page) =>
  p.evaluate(() =>
    [...(window as any).mochiCollab.session.participants.values()]
      .filter((x: any) => !x.me)
      .map((x: any) => ({
        name: x.name as string,
        files: x.files ? (x.files.size as number) : 0,
        received: x.received as number,
        error: x.error as string | undefined,
      })),
  );

describe.skipIf(!on)('a shared model’s memory, measured', () => {
  beforeAll(async () => {
    H = await startHarness();
    server = await startSignalingServer({ log: () => {} });
    dir = mkdtempSync(join(tmpdir(), 'mochi-shared-'));
    small = join(dir, 'small.zip');
    writeFileSync(
      small,
      zipSync(
        Object.fromEntries(Object.entries(syntheticModelFiles()).map(([p, d]) => [`S/${p}`, d])),
      ),
    );
  }, 120_000);
  afterAll(async () => {
    if (process.env.MOCHI_MEASURE_OUT)
      writeFileSync(process.env.MOCHI_MEASURE_OUT, JSON.stringify(results, null, 2));
    console.log(JSON.stringify(results, null, 2));
    await server?.close();
    await H?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('two participants share models at the caps', { timeout: 600_000 }, async () => {
    const s = await session(modelAtCaps('Aki'), modelAtCaps('Bo'), small);
    results.atTheCaps = await measure(s.receiver, s.pid, async () => {
      await s.join(s.a);
      await s.join(s.b);
      await s.receiver.waitForFunction(
        () =>
          [...(window as any).mochiCollab.session.participants.values()].filter(
            (x: any) => !x.me && x.files,
          ).length === 2,
        undefined,
        { timeout: 400_000, polling: 500 },
      );
    });
    const held = await s.receiver.evaluate(() => (window as any).mochiCollab.session.heldBytes());
    (results.atTheCaps as Record<string, unknown>).heldMB = held / MB;
    expect((await people(s.receiver)).every((p) => p.files > 0 && !p.error)).toBe(true);
    expect(held).toBeGreaterThan(2 * 155 * MB);
    await s.close();
  });

  it('each announces more than the caps', { timeout: 600_000 }, async () => {
    const s = await session(small, small, small);
    results.overTheCaps = await measure(s.receiver, s.pid, async () => {
      await s.join(s.a);
      await s.join(s.b);
      await s.receiver.waitForFunction(
        () =>
          [...(window as any).mochiCollab.session.participants.values()].filter(
            (x: any) => !x.me && x.files,
          ).length === 2,
        undefined,
        { timeout: 60_000 },
      );
      // Over the real channel, from each sender's app: a model of 1 GB, and one that declares
      // a total of 1 byte over a file of 4 GB (refused for the file, before any buffer is made).
      const crafted = [
        {
          files: Array.from({ length: 32 }, (_, i) => ({ path: `f${i}`, size: 32 * 2 ** 20 })),
          bytes: 2 ** 30,
        },
        { files: [{ path: 'huge.bin', size: 2 ** 32 }], bytes: 1 },
      ];
      for (const [i, p] of [s.a, s.b].entries())
        await p.evaluate((c) => {
          const s = (window as any).mochiCollab.session;
          for (const [id, l] of s.links) {
            void id;
            l.send(
              l.ctl,
              JSON.stringify({ ...s.announced, serial: s.announced.serial + 100, ...c }),
            );
          }
        }, crafted[i]!);
      await s.receiver.waitForFunction(
        () =>
          [...(window as any).mochiCollab.session.participants.values()].filter(
            (x: any) => !x.me && x.error,
          ).length === 2,
        undefined,
        { timeout: 30_000 },
      );
    });
    const ps = await people(s.receiver);
    (results.overTheCaps as Record<string, unknown>).errors = ps.map((p) => p.error);
    (results.overTheCaps as Record<string, unknown>).heldMB =
      (await s.receiver.evaluate(() => (window as any).mochiCollab.session.heldBytes())) / MB;
    expect(ps.every((p) => p.error && p.files === 0)).toBe(true);
    await s.close();
  });
});
