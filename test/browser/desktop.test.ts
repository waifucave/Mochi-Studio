import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { zipSync } from 'fflate';
import { connect } from 'node:net';
import { _electron, type ElectronApplication } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BridgeClient } from '../../bridge/src/client.ts';
import { BridgeStore } from '../../bridge/src/store.ts';
import { syntheticModelFiles } from '../support/syntheticModel';
import { startHarness, syntheticModelZip, type Harness, openSection } from './harness';

/**
 * The desktop app (Electron, with the bridge inside). Needs the Electron
 * binary (`npm install` without --ignore-scripts), a display (xvfb-run on
 * Linux) and `npm run desktop:build`; run with MOCHI_DESKTOP_TEST=1.
 */
const run = !!process.env.MOCHI_DESKTOP_TEST;
const home = mkdtempSync(join(tmpdir(), 'mochi-desktop-'));
const port = 47900 + Math.floor(Math.random() * 90);
// The folder the app's "Open folder…" opens (instead of a dialog).
const folder = join(home, 'Folder Model');
for (const [p, d] of Object.entries(syntheticModelFiles({ name: 'disk' }))) {
  mkdirSync(dirname(join(folder, p)), { recursive: true });
  writeFileSync(join(folder, p), d);
}
// The zip the app's "Open zip…" opens (instead of a dialog).
const zipPath = join(home, 'Zipped Model.zip');
writeFileSync(
  zipPath,
  zipSync(
    Object.fromEntries(
      Object.entries(syntheticModelFiles({ name: 'zipped' })).map(([p, d]) => [`Zipped/${p}`, d]),
    ),
  ),
);
let H: Harness;
let app: ElectronApplication;
/** The app's own data (browser storage, recent models), kept across restarts. */
const userData = join(home, 'app-data');

async function launch(): Promise<ElectronApplication> {
  const electron = (await import('electron')).default as unknown as string;
  return _electron.launch({
    executablePath: electron,
    // Root in a container needs --no-sandbox, and a display without a GPU
    // software WebGL (SwiftShader); a normal desktop needs neither.
    args: [
      '--no-sandbox',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      'desktop/dist/app',
    ],
    env: {
      ...process.env,
      MOCHI_STUDIO_PORT: String(port),
      MOCHI_STUDIO_BRIDGE_HOME: home,
      MOCHI_STUDIO_TEST_FOLDER: folder,
      MOCHI_STUDIO_TEST_ZIP: zipPath,
      MOCHI_STUDIO_USER_DATA: userData,
    } as Record<string, string>,
  });
}

beforeAll(async () => {
  if (!run) return;
  H = await startHarness();
  app = await launch();
});
afterAll(async () => {
  await app?.close();
  await H?.close();
});

describe.skipIf(!run)('the desktop app', () => {
  it('loads the sample model in one step, from its own pages', async () => {
    const win = await app.firstWindow();
    await win.waitForFunction(() => 'mochiStudio' in window, null, { timeout: 30_000 });
    await win.locator('#try-sample').click();
    await win.waitForFunction(() => (window as any).mochiStudio.settings !== undefined);
    expect(await win.evaluate(() => (window as any).mochiStudio.model.files.label)).toBe(
      'Mochi (sample)',
    );
    expect(
      await win.evaluate(() => (window as any).mochiStudio.info.parameters.map((p: any) => p.id)),
    ).toContain('ParamHairFront');
  });

  it('runs the bridge itself, and its OBS address works in another browser', async () => {
    const win = await app.firstWindow();
    await win.waitForFunction(() => (window as any).mochiAgentLink?.state === 'connected', null, {
      timeout: 30_000,
    });
    expect(win.url()).toBe(`http://127.0.0.1:${port}/app/index.html?desktop=1`);
    // Load a model in the app.
    const zip = join(home, 'Test.zip');
    writeFileSync(zip, syntheticModelZip());
    await win.locator('#model-zip').setInputFiles(zip);
    await win.waitForFunction(() => (window as any).mochiStudio.settings !== undefined);
    // The OBS address points at the app's own bridge.
    await openSection(win, 'Output');
    await expect.poll(() => win.locator('#obs-url').inputValue()).toContain(`127.0.0.1:${port}`);
    const obs = await win.locator('#obs-url').inputValue();
    expect(obs).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${port}/app/output\\.html\\?`));
    // A separate browser profile (like OBS) shows the model.
    const ctx = await H.browser.newContext();
    const out = await ctx.newPage();
    await out.goto(obs);
    await out.waitForFunction(
      () => document.body.dataset.model?.startsWith('test.model3.json'),
      null,
      {
        timeout: 30_000,
      },
    );
    await expect.poll(() => win.locator('#views-indicator').textContent()).toBe('Output views: 1');
    // The guide's last step counts this view: it came through the bridge, as OBS's do.
    expect(await win.locator('#guide [data-step=obs]').getAttribute('data-status')).toBe('done');
    // An error in the OBS view reaches the app's log through the bridge, and the
    // view keeps drawing.
    await out.evaluate(() => {
      (window as any).mochiOutput.runtime.setParameters = () => {
        throw new Error('obs view broke');
      };
    });
    const drawn = await out.evaluate(() => (window as any).mochiOutput.framesDrawn as number);
    await expect
      .poll(() => win.evaluate(() => (window as any).mochiLog.entries.map((e: any) => e.text)))
      .toContain('Output view, parameters: obs view broke');
    expect(await out.evaluate(() => (window as any).mochiOutput.framesDrawn)).toBeGreaterThan(
      drawn,
    );
    await ctx.close();
    // A bad frame on the bridge (here as an agent would connect) neither stops the app nor its
    // bridge; the window's log says so.
    await new Promise<void>((resolve) => {
      const s = connect(port, '127.0.0.1');
      s.on('error', () => resolve());
      s.on('close', () => resolve());
      s.once('connect', () =>
        s.write(
          `GET /api HTTP/1.1\r\nHost: localhost:${port}\r\nUpgrade: websocket\r\n` +
            'Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
            'Sec-WebSocket-Version: 13\r\n\r\n',
        ),
      );
      s.once('data', () => s.write(Buffer.from([0xc1, 0x81, 1, 2, 3, 4, 0x40])));
    });
    await expect
      .poll(() => win.evaluate(() => (window as any).mochiLog.entries.map((e: any) => e.text)))
      .toEqual(expect.arrayContaining([expect.stringMatching(/^An agent: connection error/)]));
    // Agents reach the same bridge once agent access is on.
    await win.evaluate(() => (window as any).mochiAgentLink.enable());
    const { token } = new BridgeStore(home).createToken('desktop test', ['read']);
    const c = await BridgeClient.connect(`ws://127.0.0.1:${port}/api`, token, 'test');
    expect(((await c.command('get_state')) as any).model.loaded).toBe(true);
    c.close();
  });

  it('serves a folder opened from disk to views without uploading it', async () => {
    const win = await app.firstWindow();
    await openSection(win, 'Model');
    const before = await win.evaluate(() => ({ ...(window as any).mochiAgentLink.uploadStats }));
    await win.locator('#panel-model').getByRole('button', { name: 'Open folder…' }).click();
    await win.waitForFunction(
      () => (window as any).mochiStudio.settings?.modelKey?.startsWith('disk.model3.json'),
      null,
      { timeout: 30_000 },
    );
    await openSection(win, 'Output');
    const obs = await win.locator('#obs-url').inputValue();
    const ctx = await H.browser.newContext();
    const out = await ctx.newPage();
    await out.goto(obs);
    await out.waitForFunction(
      () => document.body.dataset.model?.startsWith('disk.model3.json'),
      null,
      { timeout: 30_000 },
    );
    await ctx.close();
    const after = await win.evaluate(() => ({ ...(window as any).mochiAgentLink.uploadStats }));
    expect(after.queuedBytes).toBe(before.queuedBytes);
    expect(after.sentBytes).toBe(before.sentBytes);
    // The bridge read the files from disk: the page answered no file requests.
    expect(after.requests).toBe(before.requests);
  });

  it('saves an expression from the editor into the model folder', async () => {
    const win = await app.firstWindow();
    await openSection(win, 'Hotkeys');
    await win.locator('#expr-new').click();
    await win.locator('#expr-name').fill('Desk Grin');
    const row = win.locator('.expr-param[data-param=ParamAngleZ]');
    await row.locator('.expr-use').check();
    await row.locator('.expr-value').fill('7');
    await row.locator('.expr-value').dispatchEvent('change');
    expect(await win.locator('#expr-save').textContent()).toBe('Save into the model folder');
    await win.locator('#expr-save').click();
    const file = join(folder, 'Desk Grin.exp3.json');
    await expect.poll(() => existsSync(file), { timeout: 10_000 }).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8')).Parameters).toEqual([
      { Id: 'ParamAngleZ', Value: 7, Blend: 'Overwrite' },
    ]);
    // The settings name the file; its text is in the folder.
    await expect
      .poll(() => win.evaluate(() => (window as any).mochiStudio.settings.ownExpressions))
      .toEqual([{ file: 'Desk Grin.exp3.json', name: 'Desk Grin' }]);
    // Opened again, the model has it, read from the folder.
    await openSection(win, 'Model');
    await win.locator('#panel-model').getByRole('button', { name: 'Open folder…' }).click();
    await win.waitForFunction(
      () =>
        (window as any).mochiStudio.model?.manifest.expressions.some(
          (e: { name: string }) => e.name === 'Desk Grin',
        ),
      null,
      { timeout: 30_000 },
    );
  });

  it('follows the pointer anywhere on the screen, read by the app itself', async () => {
    const win = await app.firstWindow();
    const { p, b } = await app.evaluate(({ screen }) => ({
      p: screen.getCursorScreenPoint(),
      b: screen.getPrimaryDisplay().bounds,
    }));
    const clamp1 = (v: number) => Math.max(-1, Math.min(1, v));
    const x = clamp1((p.x - (b.x + b.width / 2)) / (b.width / 2));
    const y = clamp1((b.y + b.height / 2 - p.y) / (b.height / 2));
    const mouse = () =>
      win.evaluate(() => {
        const i = (window as any).mochiStudio.lastInputs;
        return [i.MousePositionX, i.MousePositionY] as [number, number];
      });
    expect(await win.evaluate(() => (window as any).mochiStudio.pointerScope)).toBe('screen');
    await expect.poll(async () => (await mouse())[0]).toBeCloseTo(x, 3);
    expect((await mouse())[1]).toBeCloseTo(y, 3);
    // Events over the page do not move it: the screen's pointer counts.
    await win.mouse.move(3, 3);
    await win.waitForTimeout(300);
    expect((await mouse())[0]).toBeCloseTo(x, 3);
    // A choice of screen: the main one by default, or one of the list.
    await openSection(win, 'Tracking');
    const choice = win.locator('#mouse-screen');
    await expect.poll(() => choice.locator('option').count()).toBeGreaterThan(1);
    expect(await choice.inputValue()).toBe('main');
    const display = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().id);
    await choice.selectOption(String(display));
    await expect
      .poll(() =>
        win.evaluate(async () => (await (window as any).mochiStudio.store.getApp()).mouseScreen),
      )
      .toBe(display);
    await expect.poll(async () => (await mouse())[0]).toBeCloseTo(x, 3);
    await choice.selectOption('main');
    await win.keyboard.press('Escape');
  });

  it('captures a screen for the light overlay through its own source list', async () => {
    const win = await app.firstWindow();
    await openSection(win, 'Tracking');
    const source = win.locator('#light-source');
    await win.locator('#light-sources').click();
    await expect
      .poll(() => source.locator('option').count(), { timeout: 10_000 })
      .toBeGreaterThan(0);
    expect(await source.locator('option').first().textContent()).toMatch(/^Screen: /);
    await win.locator('#light-toggle').click();
    await expect
      .poll(
        () =>
          win.evaluate(
            () =>
              `${document.querySelector('#light-status')?.textContent} | ${document.body.innerText.slice(-160)}`,
          ),
        { timeout: 15_000 },
      )
      .toMatch(/^On: a screen; average/);
    expect(await win.evaluate(() => (window as any).mochiStudio.lightOverlay.isWindowCapture)).toBe(
      false,
    );
    await win.locator('#light-toggle').click();
    expect(await win.evaluate(() => (window as any).mochiStudio.lightOverlayOn)).toBe(false);
    await win.keyboard.press('Escape');
  });

  it('draws a web page as an item, and sends its frames to an OBS view', async () => {
    const win = await app.firstWindow();
    // A page of our own on another local port: red, with a counter that changes.
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><body style="margin:0;background:#e01010"><h1 id=n>0</h1></body>');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const pagePort = (server.address() as { port: number }).port;
    // Mochi Studio's own pages are refused.
    const errorsBefore = await win.evaluate(() => {
      const w = window as any;
      w.webErrors = [];
      w.mochiStudio.events.on('error', (e: any) => w.webErrors.push(e.message));
      return 0;
    });
    void errorsBefore;
    const id = await win.evaluate(
      (url) => (window as any).mochiStudio.addWebItem({ url, width: 64, height: 64, fps: 10 }),
      `http://127.0.0.1:${pagePort}/`,
    );
    expect(
      await win.evaluate(
        (id) => (window as any).mochiStudio.items.find((i: any) => i.id === id).web,
        id,
      ),
    ).toEqual({
      url: `http://127.0.0.1:${pagePort}/`,
      width: 64,
      height: 64,
      fps: 10,
    });
    // Over the whole model, in front.
    await win.evaluate(
      (id) =>
        (window as any).mochiStudio.placeItem(id, {
          x: 0,
          y: 0,
          scale: 12,
          rotation: 0,
          front: true,
        }),
      id,
    );
    const centre = () =>
      win.evaluate(async () => {
        const w = window as any;
        const pt = w.mochiStudio.runtime.modelToPage(0, 0);
        const shot = await w.mochiStudio.screenshot();
        const bmp = await createImageBitmap(new Blob([shot], { type: 'image/png' }));
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const g = c.getContext('2d')!;
        g.drawImage(bmp, 0, 0);
        const r = document.querySelector('canvas')!.getBoundingClientRect();
        const k = bmp.width / r.width;
        const d = g.getImageData(
          Math.round((pt.x - r.left) * k),
          Math.round((pt.y - r.top) * k),
          1,
          1,
        ).data;
        return [d[0]!, d[1]!, d[2]!];
      });
    await expect
      .poll(
        async () => {
          const [r, g, b] = await centre();
          return r! > 180 && g! < 60 && b! < 60;
        },
        { timeout: 20_000 },
      )
      .toBe(true);
    // An OBS view in another browser gets the frames over the bridge.
    await openSection(win, 'Output');
    const obs = await win.locator('#obs-url').inputValue();
    await win.keyboard.press('Escape');
    const ctx = await H.browser.newContext();
    const out = await ctx.newPage();
    const textures: string[] = [];
    await out.exposeFunction('noteTexture', (x: string) => textures.push(x));
    await out.addInitScript(() => {
      const w = window as any;
      const t = setInterval(() => {
        const rt = w.mochiOutput?.runtime;
        if (!rt) return;
        clearInterval(t);
        const orig = rt.updateItemTexture.bind(rt);
        rt.updateItemTexture = (i: string, img: unknown) => {
          w.noteTexture(i);
          orig(i, img);
        };
      }, 20);
    });
    await out.goto(obs);
    await expect.poll(() => textures.includes(id), { timeout: 20_000 }).toBe(true);
    await ctx.close();
    // The bridge's own address is refused.
    await win.evaluate(
      (url) => (window as any).mochiStudio.addWebItem({ url, width: 32, height: 32, fps: 1 }),
      `http://127.0.0.1:${port}/app/index.html`,
    );
    await expect
      .poll(() => win.evaluate(() => (window as any).webErrors.join(' ')))
      .toContain('cannot show Mochi Studio’s own pages');
    for (const i of await win.evaluate(() =>
      (window as any).mochiStudio.items.map((x: any) => x.id),
    ))
      await win.evaluate((i) => (window as any).mochiStudio.removeItem(i), i);
    server.close();
  });

  it('lists the folder as recent, and reopens it when the app starts again', async () => {
    let win = await app.firstWindow();
    await openSection(win, 'Model');
    await expect.poll(() => win.locator('#recent-models li').count()).toBe(1);
    expect(await win.locator('#recent-models').textContent()).toContain('Folder Model');
    expect(await win.locator('#reopen-last').isChecked()).toBe(true);
    await app.close();
    app = await launch();
    win = await app.firstWindow();
    await win.waitForFunction(
      () => (window as any).mochiStudio.settings?.modelKey?.startsWith('disk.model3.json'),
      null,
      { timeout: 30_000 },
    );
  });

  it('says when the last folder has moved, and offers the rest', async () => {
    await app.close();
    renameSync(folder, `${folder} (moved)`);
    app = await launch();
    const win = await app.firstWindow();
    await expect
      .poll(() => win.locator('.toast').textContent(), { timeout: 30_000 })
      .toContain('is no longer at');
    expect(await win.evaluate(() => (window as any).mochiStudio.model)).toBeUndefined();
    // The empty stage offers it, marked as moved; the Model tab can remove it.
    expect(await win.locator('#stage-recent').textContent()).toContain('moved or gone');
    await openSection(win, 'Model');
    await win.getByRole('button', { name: 'Remove Folder Model from the list' }).click();
    await expect.poll(() => win.locator('#recent-models li').count()).toBe(0);
    renameSync(`${folder} (moved)`, folder);
  });

  it('registers hotkeys that work while another app has focus, and says which cannot', async () => {
    const win = await app.firstWindow();
    await win.locator('#panel-model').getByRole('button', { name: 'Open folder…' }).click();
    await win.waitForFunction(() => (window as any).mochiStudio.settings !== undefined, null, {
      timeout: 30_000,
    });
    await win.evaluate(() => {
      const st = (window as any).mochiStudio;
      st.updateSettings({
        hotkeys: [
          {
            id: 'g',
            label: 'Blush',
            keys: 'Ctrl+Alt+F9',
            button: false,
            action: { type: 'expression', expression: 'Blush' },
          },
          {
            id: 'w',
            label: 'Blush too',
            keys: 'KeyH',
            button: false,
            action: { type: 'expression', expression: 'Blush' },
          },
        ],
      });
    });
    await openSection(win, 'Hotkeys');
    expect(await win.locator('#global-hotkeys-toggle').isChecked()).toBe(true);
    await expect.poll(() => win.locator('#global-hotkeys li').count()).toBe(2);
    // A plain typing key stays window-only, with the reason.
    expect(await win.locator('#global-hotkeys [data-hotkey=w]').textContent()).toContain(
      'taken from every other app',
    );
    // The system registered the other (or says it is taken: either is reported).
    const g = win.locator('#global-hotkeys [data-hotkey=g]');
    const registered = (await g.getAttribute('data-global')) === 'true';
    process.stderr.write(`[desktop] Ctrl+Alt+F9 registered with the system: ${registered}\n`);
    expect(await g.textContent()).toMatch(registered ? /works in other apps/ : /already uses/);
    if (registered) {
      // A press elsewhere reaches the page as the system shortcut's event.
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.webContents.send('mochi:global-hotkey', 'Control+Alt+F9'),
      );
      await expect
        .poll(() => win.evaluate(() => [...(window as any).mochiStudio.activeExpressions]))
        .toEqual(['Blush']);
    }
    // Turned off, nothing is registered.
    await win.locator('#global-hotkeys-toggle').uncheck();
    expect(
      await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Control+Alt+F9')),
    ).toBe(false);
  });

  it('opens zips through its own dialog and remembers them too', async () => {
    const win = await app.firstWindow();
    await openSection(win, 'Model');
    await win.locator('#panel-model').getByRole('button', { name: 'Open zip…' }).click();
    await win.waitForFunction(
      () => (window as any).mochiStudio.settings?.modelKey?.includes('zipped.model3.json'),
      null,
      { timeout: 30_000 },
    );
    await expect
      .poll(() => win.locator('#recent-models li').first().textContent())
      .toContain('Zipped Model.zip');
  });
});
