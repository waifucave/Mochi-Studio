import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { BridgeServer } from '../../bridge/src/server.ts';
import { BridgeStore } from '../../bridge/src/store.ts';
import { PROTOCOL_VERSION } from '../../src/core/bridgeProtocol';

/**
 * Folders the desktop app registers: the bridge serves them to the page (its
 * host token) and to views (disk_source), and nothing outside them.
 */
const home = mkdtempSync(join(tmpdir(), 'mochi-disk-'));
const folder = join(home, 'Model');
mkdirSync(join(folder, 'sub dir'), { recursive: true });
writeFileSync(join(folder, 'a.model3.json'), '{"x":1}');
writeFileSync(join(folder, 'sub dir', 'b é.txt'), 'hello');
writeFileSync(join(home, 'secret.txt'), 'secret');
symlinkSync(join(home, 'secret.txt'), join(folder, 'link.txt'));

let bridge: BridgeServer;
let http: string;
let host: WebSocket;
let token: string;
let id: string;
let viewKey: string;

beforeAll(async () => {
  const store = new BridgeStore(home);
  bridge = new BridgeServer({ port: 0, store, log: () => undefined });
  const port = await bridge.listen();
  http = `http://127.0.0.1:${port}`;
  token = store.pair(store.pairingCode())!;
  viewKey = store.newViewKey();
  host = new WebSocket(`ws://127.0.0.1:${port}/host`, { origin: http });
  await new Promise<void>((done, fail) => {
    host.on('error', fail);
    host.on('open', () =>
      host.send(
        JSON.stringify({
          type: 'host_hello',
          protocol: PROTOCOL_VERSION,
          app: 'test',
          version: '0',
          hostToken: token,
        }),
      ),
    );
    host.on('message', (raw) => {
      if (JSON.parse(String(raw)).type === 'host_welcome') done();
    });
  });
  id = bridge.registerFolder(folder);
});
afterAll(async () => {
  host?.close();
  await bridge?.close();
});

const get = (path: string, auth = token) =>
  fetch(`${http}/disk/${id}/${path}`, { headers: { authorization: `Bearer ${auth}` } });

describe('disk folders', () => {
  it('serves files of the folder to the page', async () => {
    expect(await (await get('a.model3.json')).text()).toBe('{"x":1}');
    expect(await (await get(`sub%20dir/${encodeURIComponent('b é.txt')}`)).text()).toBe('hello');
  });

  it('needs the host token', async () => {
    expect((await get('a.model3.json', 'wrong')).status).toBe(401);
  });

  it('serves nothing outside the folder', async () => {
    expect((await get('..%2Fsecret.txt')).status).toBe(404);
    expect((await get('sub%20dir/..%2F..%2Fsecret.txt')).status).toBe(404);
    expect((await get('link.txt')).status).toBe(404);
    expect(
      (
        await fetch(`${http}/disk/0000/a.model3.json`, {
          headers: { authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(404);
  });

  it('serves a disk source to views without asking the page', async () => {
    host.send(
      JSON.stringify({
        type: 'disk_source',
        scope: 'model',
        owner: 'k',
        folderId: id,
        prefix: 'sub dir',
      }),
    );
    // The page never answers file requests here; the bridge must read the disk.
    const asked: unknown[] = [];
    host.on('message', (raw, bin) => {
      if (!bin) asked.push(JSON.parse(String(raw)));
    });
    await new Promise((r) => setTimeout(r, 50));
    const files = `${http}/files/model/k`;
    const r = await fetch(`${files}/${encodeURIComponent('b é.txt')}?key=${viewKey}`);
    expect(await r.text()).toBe('hello');
    expect((await fetch(`${files}/..%2F..%2Fsecret.txt?key=${viewKey}`)).status).toBe(404);
    expect((await fetch(`${files}/${encodeURIComponent('b é.txt')}?key=bad`)).status).toBe(401);
    expect(asked.filter((m: any) => m.type === 'file_request')).toEqual([]);
  });

  it('writes expression files into the folder, and nothing else', async () => {
    const put = (path: string, body: string, auth = token) =>
      fetch(`${http}/disk/${id}/${path}`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
        body,
      });
    const exp = '{"FadeInTime":0.5,"FadeOutTime":0.5,"Parameters":[]}';
    expect((await put('Smile.exp3.json', exp)).status).toBe(204);
    expect(readFileSync(join(folder, 'Smile.exp3.json'), 'utf8')).toBe(exp);
    expect((await put(`sub%20dir/${encodeURIComponent('Grin é.exp3.json')}`, exp)).status).toBe(
      204,
    );
    expect(existsSync(join(folder, 'sub dir', 'Grin é.exp3.json'))).toBe(true);
    // Overwriting one is fine; the page reads it back.
    expect((await put('Smile.exp3.json', '{"Parameters":[]}')).status).toBe(204);
    expect(await (await get('Smile.exp3.json')).text()).toBe('{"Parameters":[]}');
    // Not other kinds of files, not outside the folder, not without the token, not broken JSON.
    expect((await put('a.model3.json', exp)).status).toBe(403);
    expect((await put('..%2Fescape.exp3.json', exp)).status).toBe(403);
    expect((await put('missing%2Fdir.exp3.json', exp)).status).toBe(403);
    expect((await put('Smile.exp3.json', exp, 'wrong')).status).toBe(401);
    expect((await put('Bad.exp3.json', 'not json')).status).toBe(400);
    expect((await put('Bad.exp3.json', '[1]')).status).toBe(400);
    expect((await put('Big.exp3.json', `{"x":"${'a'.repeat(300 * 1024)}"}`)).status).toBe(413);
    expect(existsSync(join(home, 'escape.exp3.json'))).toBe(false);
    expect(existsSync(join(folder, 'Bad.exp3.json'))).toBe(false);
  });
});
