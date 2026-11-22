import { writeFileSync } from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startSignalingServer } from '../../collab/server';
import { cpuSeconds } from '../support/processMemory';
import { startHarness, syntheticModelZip, type Harness } from './harness';

/**
 * Hosting alone while sharing as video: the CPU the host's browser uses,
 * and whether the video avatar's page draws; then, when someone joins, how
 * long until they see the host's avatar. The host runs in a browser of its
 * own, so its processes can be read (Linux).
 *
 * A measurement, not part of the suite: MOCHI_MEASURE_VIDEO=1 runs it,
 * MOCHI_MEASURE_OUT=file.json keeps the numbers.
 */
const on = process.env.MOCHI_MEASURE_VIDEO === '1';
let H: Harness;
let server: Awaited<ReturnType<typeof startSignalingServer>>;
const results: Record<string, unknown> = {};

async function app(browser: Browser, name: string): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 600 } });
  const p = await ctx.newPage();
  await p.goto(H.url);
  await p.waitForFunction(() => 'mochiStudio' in window && 'mochiCollab' in window);
  await p.locator('#model-zip').setInputFiles({
    name: 'Test.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(syntheticModelZip()),
  });
  await p.waitForFunction(() => (window as any).mochiStudio.settings !== undefined);
  await p.evaluate(
    ({ server, name }) => {
      const s = (window as any).mochiStudio;
      s.setCollabSettings({ server, nickname: name, hideAddress: false });
      s.updateSettings({ collabSharing: 'video' });
    },
    { server: server.wsUrl, name },
  );
  return p;
}

describe.skipIf(!on)('the video avatar’s page, hosting alone and when someone joins', () => {
  beforeAll(async () => {
    H = await startHarness();
    server = await startSignalingServer({ log: () => {} });
  }, 120_000);
  afterAll(async () => {
    if (process.env.MOCHI_MEASURE_OUT)
      writeFileSync(process.env.MOCHI_MEASURE_OUT, JSON.stringify(results, null, 2));
    console.log(JSON.stringify(results, null, 2));
    await server?.close();
    await H?.close();
  });

  it('measures', { timeout: 300_000 }, async () => {
    const srv = await chromium.launchServer({
      ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    });
    const own = await chromium.connect(srv.wsEndpoint());
    const host = await app(own, 'Host');
    const pid = srv.process().pid!;
    await host.evaluate(() => (window as any).mochiCollab.host());
    await host.waitForFunction(() => (window as any).mochiCollab.session?.link);
    /** 10 s alone: the CPU used, and the avatar page's frames. */
    const alone = async () => {
      await host.waitForTimeout(3000);
      const frames0 = await host.evaluate(() => (window as any).mochiCollab.sender?.frames ?? 0);
      const cpu0 = cpuSeconds(pid);
      await host.waitForTimeout(10_000);
      return {
        cpuSecondsIn10s: Math.round((cpuSeconds(pid) - cpu0) * 100) / 100,
        avatarPageRunning: await host.evaluate(() => !!(window as any).mochiCollab.sender),
        avatarFramesIn10s:
          (await host.evaluate(() => (window as any).mochiCollab.sender?.frames ?? 0)) - frames0,
      };
    };
    results.aloneAtStart = await alone();
    // The model loaded again while alone (the session announces it).
    await host.locator('#model-zip').setInputFiles({
      name: 'Test.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(syntheticModelZip()),
    });
    await host.waitForFunction(() => (window as any).mochiStudio.settings !== undefined);
    results.aloneAfterLoading = await alone();
    // Someone joins: from their admission to the first frame of the host's avatar on their screen.
    const guest = await app(H.browser, 'Guest');
    const link = await host.evaluate(() => (window as any).mochiCollab.session.link as string);
    await guest.evaluate((l) => (window as any).mochiCollab.join(l), link);
    await host.waitForFunction(() => (window as any).mochiCollab.session.knocks.size > 0);
    const hostId = await host.evaluate(() => (window as any).mochiCollab.session.you as string);
    const t0 = Date.now();
    await host.evaluate(() => {
      const s = (window as any).mochiCollab.session;
      s.admit([...s.knocks.keys()][0]);
    });
    await guest.waitForFunction(
      (id) => (window as any).mochiCollab.session?.participants.get(id)?.connection === 'connected',
      hostId,
      { timeout: 30_000, polling: 20 },
    );
    const connected = Date.now() - t0;
    await guest.waitForFunction(
      (id) => (window as any).mochiCollab.avatars.get(id)?.receiver !== undefined,
      hostId,
      { timeout: 30_000, polling: 20 },
    );
    const placeholder = Date.now() - t0;
    await guest.waitForFunction(
      (id) => ((window as any).mochiCollab.avatars.get(id)?.receiver?.frames ?? 0) > 0,
      hostId,
      { timeout: 30_000, polling: 20 },
    );
    results.joining = {
      msToConnected: connected,
      msToAvatarItem: placeholder,
      msToFirstFrame: Date.now() - t0,
    };
    expect(results.joining).toBeDefined();
    // The guest leaves: alone again.
    await guest.evaluate(() => (window as any).mochiCollab.leave());
    await guest.context().close();
    await host.waitForFunction(
      () => [...(window as any).mochiCollab.session.participants.values()].every((p: any) => p.me),
      undefined,
      { timeout: 60_000 },
    );
    results.aloneAfterTheGuestLeft = await alone();
    await own.close();
    await srv.close();
  });
});
