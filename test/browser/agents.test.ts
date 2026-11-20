import { mkdtempSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { BridgeClient, BridgeError } from '../../bridge/src/client.ts';
import { staticCatalog } from '../../bridge/src/mcp.ts';
import { BridgeServer } from '../../bridge/src/server.ts';
import { BridgeStore } from '../../bridge/src/store.ts';
import {
  startHarness,
  syntheticItemZip,
  syntheticModelZip,
  type Harness,
  openSection,
} from './harness';

/**
 * Milestone 2 end to end: a real bridge, the Mochi Studio page as its host
 * (paired with the code), a WebSocket client and the MCP server over stdio.
 */
let H: Harness;
let bridge: BridgeServer;
let page: Page;
const home = mkdtempSync(join(tmpdir(), 'mochi-bridge-'));
let api: string;

beforeAll(async () => {
  H = await startHarness();
  bridge = new BridgeServer({
    port: 0,
    store: new BridgeStore(home),
    catalog: staticCatalog(),
    log: () => undefined,
  });
  api = `ws://127.0.0.1:${await bridge.listen()}/api`;
  page = await H.context.newPage();
  await page.goto(H.url);
  await page.waitForFunction(() => 'mochiStudio' in window);
  await page.locator('#model-zip').setInputFiles({
    name: 'Test.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(syntheticModelZip()),
  });
  await page.waitForFunction(() => (window as any).mochiStudio.settings !== undefined);
});
afterAll(async () => {
  await bridge?.close();
  await H?.close();
});

describe('the agent API in Chromium', () => {
  it('is off until turned on, then pairs with the bridge’s code', async () => {
    const port = new URL(api).port;
    expect(await page.evaluate(() => (window as any).mochiAgentLink.state)).toBe('off');
    expect(bridge.studioConnected).toBe(false);
    // Turn agent access on and pair with the bridge's code.
    await openSection(page, 'Agents');
    await page.locator('#bridge-url').fill(`ws://127.0.0.1:${port}`);
    await page.locator('#agent-access').check();
    await expect
      .poll(() => page.locator('#bridge-status').getAttribute('data-state'))
      .toBe('pairing');
    await page.locator('#pair-code').fill(bridge.store.pairingCode());
    await page.getByRole('button', { name: 'Pair' }).click();
    await expect
      .poll(() => page.locator('#bridge-status').getAttribute('data-state'))
      .toBe('connected');
    expect(bridge.studioConnected).toBe(true);
  });

  it('refuses wrong pairing codes', async () => {
    // A separate browser profile: a page that was never paired.
    const ctx = await H.browser.newContext();
    const p = await ctx.newPage();
    await p.goto(H.url);
    await p.waitForFunction(() => 'mochiAgentLink' in window);
    expect(await p.evaluate(() => (window as any).mochiAgentLink.state)).toBe('off');
    await p.evaluate((u) => (window as any).mochiAgentLink.enable(u), api.replace('/api', ''));
    await expect.poll(() => p.evaluate(() => (window as any).mochiAgentLink.state)).toBe('pairing');
    await p.evaluate(() => (window as any).mochiAgentLink.pair('000000'));
    await expect
      .poll(() => p.evaluate(() => (window as any).mochiAgentLink.message))
      .toContain('Wrong or expired');
    await p.evaluate(() => (window as any).mochiAgentLink.disable());
    await ctx.close();
    // The first page is still the host.
    expect(bridge.studioConnected).toBe(true);
  });

  it('creates a token in the page and runs commands from a client, with events', async () => {
    await page.locator('#token-name').fill('Test bot');
    await page.locator('#token-create').click();
    const token = await page.locator('#new-token').inputValue();
    expect(token).toMatch(/^mst_/);
    expect(await page.locator('pre.setup').textContent()).toContain('MOCHI_STUDIO_TOKEN');

    const c = await BridgeClient.connect(api, token, 'test');
    expect(c.welcome.scopes).toEqual(['read', 'control', 'screenshot']);
    expect(c.welcome.studio.connected).toBe(true);
    expect(c.welcome.commands.some((x) => x.name === 'screenshot')).toBe(true);
    // The page shows that an agent is connected.
    await expect
      .poll(() => page.locator('#agent-indicator').textContent())
      .toBe('● Agent: Test bot');

    const events: string[] = [];
    c.onEvent((name) => events.push(name));
    c.subscribe(['expression_*', 'command_executed']);
    const state = (await c.command('get_state')) as { model: { name: string } };
    expect(state.model.name).toBe('test.model3.json');
    await c.command('set_expression', { expression: 'Blush' });
    expect(await page.evaluate(() => [...(window as any).mochiStudio.activeExpressions])).toEqual([
      'Blush',
    ]);
    await expect.poll(() => events).toContain('expression_changed');
    expect(events).toContain('command_executed');
    // The page lists the agent's commands.
    await expect
      .poll(() => page.locator('#agent-log').textContent())
      .toContain('Test bot: set_expression');
    // Undo from the agent.
    await c.command('undo');
    expect(await page.evaluate(() => [...(window as any).mochiStudio.activeExpressions])).toEqual(
      [],
    );
    // Errors carry a code and a message that says what to do.
    await expect(c.command('set_expression', { expression: 'Nope' })).rejects.toMatchObject({
      code: 'unknown_expression',
    });
    await expect(c.command('set_frame_cap', { fps: 'fast' })).rejects.toMatchObject({
      code: 'invalid_arguments',
    });
    // A screenshot is a PNG.
    const shot = (await c.command('screenshot')) as { mimeType: string; data: string };
    expect(shot.mimeType).toBe('image/png');
    expect(Buffer.from(shot.data, 'base64').subarray(1, 4).toString()).toBe('PNG');
    c.close();
    await expect.poll(() => page.locator('#agent-indicator').isHidden()).toBe(true);
  });

  it('enforces scopes, tokens and origins', async () => {
    const { token } = bridge.store.createToken('reader', ['read']);
    const c = await BridgeClient.connect(api, token, 'reader');
    await c.command('get_state');
    await expect(c.command('set_expression', { expression: 'Blush' })).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(c.command('screenshot')).rejects.toMatchObject({ code: 'forbidden' });
    c.close();
    await expect(BridgeClient.connect(api, 'mst_wrong', 'x')).rejects.toBeInstanceOf(BridgeError);
    // A web page from another origin may not connect.
    const status = await new Promise<number>((resolve) => {
      const u = new URL(api.replace('ws:', 'http:'));
      const req = request({
        host: u.hostname,
        port: u.port,
        path: '/api',
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          Origin: 'https://evil.example',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        },
      });
      req.on('response', (r) => resolve(r.statusCode ?? 0));
      req.on('upgrade', () => resolve(101));
      req.end();
    });
    expect(status).toBe(403);
  });

  it('serves MCP over stdio, with screenshots as images', async () => {
    const { token } = bridge.store.createToken('mcp test', ['read', 'control', 'screenshot']);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['bridge/bin.mjs', 'mcp', '--port', new URL(api).port],
      env: { ...process.env, MOCHI_STUDIO_TOKEN: token, MOCHI_STUDIO_BRIDGE_HOME: home } as Record<
        string,
        string
      >,
      stderr: 'ignore',
    });
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(transport);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(['get_state', 'play_motion', 'screenshot', 'speak']),
    );
    expect(tools.find((t) => t.name === 'get_state')!.annotations?.readOnlyHint).toBe(true);
    const state = await client.callTool({ name: 'get_state', arguments: {} });
    expect((state.structuredContent as any).model.loaded).toBe(true);
    const shot = await client.callTool({ name: 'screenshot', arguments: {} });
    const img = (shot.content as any[]).find((x) => x.type === 'image');
    expect(img.mimeType).toBe('image/png');
    const bad = await client.callTool({ name: 'play_motion', arguments: { name: 'nope' } });
    expect(bad.isError).toBe(true);
    expect((bad.content as any[])[0].text).toContain('describe_model lists the motions');
    await client.close();
  });

  it('drives an output view in another browser profile (OBS) through the bridge', async () => {
    await openSection(page, 'Output');
    await page.locator('#bridge-views').check();
    await expect.poll(() => page.locator('#obs-url').inputValue()).toContain('view=msv_');
    const obs = await page.locator('#obs-url').inputValue();
    expect(obs).toContain('bridge=');

    // A separate browser profile, like OBS's browser source.
    const ctx = await H.browser.newContext();
    const out = await ctx.newPage();
    const errors: string[] = [];
    out.on('pageerror', (e) => errors.push(e.message));
    await out.goto(obs);
    await out.waitForFunction(
      () => document.body.dataset.model?.startsWith('test.model3.json'),
      null,
      {
        timeout: 20_000,
      },
    );
    // The control window counts it.
    await expect.poll(() => page.locator('#views-indicator').textContent()).toBe('Output views: 1');
    // Parameters arrive every frame.
    await page.evaluate(() => ((window as any).mochiStudio.overrides = { ParamCustom: 0.42 }));
    await out.waitForFunction(() => (window as any).mochiOutput.params.ParamCustom === 0.42);
    // Items: their files come on demand too.
    await openSection(page, 'Items');
    await page.locator('#item-zip').setInputFiles({
      name: 'Hat.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(syntheticItemZip()),
    });
    await out.waitForFunction(() => document.body.dataset.items === '1', null, { timeout: 20_000 });
    // The view draws the model.
    const drawn = await out.evaluate(async () => {
      const blob: Blob = await (window as any).mochiOutput.runtime.screenshot();
      return blob.size;
    });
    expect(drawn).toBeGreaterThan(1000);
    expect(errors).toEqual([]);

    // A wrong view key gets nothing.
    const bad = await ctx.newPage();
    await bad.goto(obs.replace(/view=msv_[^&]+/, 'view=msv_wrong'));
    await bad.waitForFunction(() => document.body.dataset.bridge?.includes('not valid'));
    expect(await bad.evaluate(() => document.body.dataset.model)).toBeUndefined();
    // And the view key is not an agent token.
    const key = decodeURIComponent(/view=([^&]+)/.exec(obs)![1]!);
    await expect(BridgeClient.connect(api, key, 'x')).rejects.toMatchObject({
      code: 'unauthorized',
    });

    await ctx.close();
    await expect.poll(() => page.locator('#views-indicator').textContent()).toBe('No output view');
  });

  it('lets a newer window take over, and the older one says so', async () => {
    // Same profile: the new window has the pairing and agent access on.
    const page2 = await H.context.newPage();
    await page2.goto(H.url);
    await page2.waitForFunction(() => (window as any).mochiAgentLink?.state === 'connected', null, {
      timeout: 20_000,
    });
    await expect
      .poll(() => page.locator('#bridge-status').getAttribute('data-state'))
      .toBe('replaced');
    expect(await page.locator('#bridge-status').textContent()).toContain(
      'Another Mochi Studio window',
    );
    expect(await page.locator('#agent-indicator').isHidden()).toBe(true);
    await page2.close();
  });
});
