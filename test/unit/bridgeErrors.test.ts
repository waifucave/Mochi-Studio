import { mkdtempSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { BridgeServer } from '../../bridge/src/server.ts';
import { BridgeStore } from '../../bridge/src/store.ts';

/**
 * Errors on one connection never stop the bridge: a
 * malformed WebSocket frame used to throw an uncaught `error` event, which
 * ends the bridge process (and the desktop app's main process).
 */
let bridge: BridgeServer;
let port = 0;
const pluginPort = 26_100 + Math.floor(Math.random() * 500);
const logged: string[] = [];
const uncaught: Error[] = [];
const onUncaught = (e: Error) => uncaught.push(e);

beforeAll(async () => {
  process.on('uncaughtException', onUncaught);
  bridge = new BridgeServer({
    port: 0,
    store: new BridgeStore(mkdtempSync(join(tmpdir(), 'mochi-bridge-errors-'))),
    log: (m) => logged.push(m),
    plugins: { port: pluginPort, broadcastAddress: '127.0.0.1', broadcastPort: 9 },
  });
  port = await bridge.listen();
  await (
    bridge as unknown as { plugins: { setEnabled(on: boolean): Promise<void> } }
  ).plugins.setEnabled(true);
});
afterAll(async () => {
  process.off('uncaughtException', onUncaught);
  await bridge?.close();
});

/** Opens a WebSocket by hand, then sends a frame with RSV1 set (invalid without compression). */
async function badFrame(p: number, path: string): Promise<void> {
  const s = connect(p, '127.0.0.1');
  s.on('error', () => undefined);
  await new Promise((r) => s.once('connect', r));
  s.write(
    `GET ${path} HTTP/1.1\r\nHost: localhost:${p}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
  );
  await new Promise((r) => s.once('data', r));
  s.write(Buffer.from([0xc1, 0x81, 1, 2, 3, 4, 0x41 ^ 1]));
  await new Promise<void>((r) => {
    s.once('close', () => r());
    setTimeout(() => {
      s.destroy();
      r();
    }, 2000);
  });
}

/** A fresh connection still opens. */
function opens(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    ws.once('open', () => {
      ws.close();
      resolve(true);
    });
    ws.once('error', () => resolve(false));
  });
}

describe('the bridge keeps running after a bad connection', () => {
  it('survives a malformed frame from a plugin, and logs it', async () => {
    await badFrame(pluginPort, '/');
    expect(uncaught).toEqual([]);
    expect(logged.some((m) => m.startsWith('A plugin: connection error'))).toBe(true);
    expect(await opens(`ws://127.0.0.1:${pluginPort}`)).toBe(true);
  });

  it('survives a malformed frame from an agent', async () => {
    await badFrame(port, '/api');
    expect(uncaught).toEqual([]);
    expect(logged.some((m) => m.startsWith('An agent: connection error'))).toBe(true);
    expect(await opens(`ws://127.0.0.1:${port}/api`)).toBe(true);
  });

  it('survives a connection reset while it upgrades', async () => {
    const s = connect(port, '127.0.0.1');
    await new Promise((r) => s.once('connect', r));
    s.write(`GET /api HTTP/1.1\r\nHost: localhost:${port}\r\nUpgrade: websocket\r\n`);
    s.resetAndDestroy();
    await new Promise((r) => setTimeout(r, 200));
    expect(uncaught).toEqual([]);
    expect(await opens(`ws://127.0.0.1:${port}/api`)).toBe(true);
  });
});
