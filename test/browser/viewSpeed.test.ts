import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

function walk(d: string): string[] {
  return readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
import { zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { staticCatalog } from '../../bridge/src/mcp.ts';
import { BridgeServer } from '../../bridge/src/server.ts';
import { BridgeStore } from '../../bridge/src/store.ts';
import { syntheticModelFiles } from '../support/syntheticModel';
import { startHarness, type Harness, openSection } from './harness';

/**
 * How long an output view takes to load a large model through the bridge,
 * against the control window's own load. Run with MOCHI_BENCH=1 (it builds a
 * model of about 80 MB: five 2048² textures and 60 small files, like a real
 * model's folder). MOCHI_BENCH_SIZE, _TEXTURES and _FILES change that.
 */
const run = !!process.env.MOCHI_BENCH;
let H: Harness;
let bridge: BridgeServer;

beforeAll(async () => {
  if (!run) return;
  H = await startHarness();
  bridge = new BridgeServer({
    port: 0,
    store: new BridgeStore(mkdtempSync(join(tmpdir(), 'mochi-bench-'))),
    catalog: staticCatalog(),
    log: () => undefined,
  });
  await bridge.listen();
});
afterAll(async () => {
  await bridge?.close();
  await H?.close();
});

describe.skipIf(!run)('view loading speed', () => {
  it('loads a large model through the bridge in little more than the control window’s time', async () => {
    const size = Number(process.env.MOCHI_BENCH_SIZE ?? 2048);
    // MOCHI_BENCH_MODEL=assets/models/DeepSeek measures a real (local) model instead.
    const folder = process.env.MOCHI_BENCH_MODEL;
    const files = folder
      ? Object.fromEntries(
          walk(folder).map((p) => [relative(folder, p), new Uint8Array(readFileSync(p))]),
        )
      : syntheticModelFiles({
          textureSize: size,
          // MOCHI_BENCH_COMPRESS=1 (the default from 4096²): textures about as large as a real model's.
          compressTextures:
            (process.env.MOCHI_BENCH_COMPRESS ?? (size >= 4096 ? '1' : '0')) === '1',
          textures: Number(process.env.MOCHI_BENCH_TEXTURES ?? 5),
          extraFiles: Number(process.env.MOCHI_BENCH_FILES ?? 30),
        });
    const zip = zipSync(
      Object.fromEntries(Object.entries(files).map(([p, d]) => [`Big/${p}`, d])),
      { level: 0 },
    );
    const bytes = Object.values(files).reduce((a, d) => a + d.length, 0);

    const page = await H.context.newPage();
    // MOCHI_BENCH_INPAGE=1: uploads on the page's main thread (the old way), to compare.
    const inPage = process.env.MOCHI_BENCH_INPAGE === '1';
    await page.goto(inPage ? `${H.url}?uploadInPage` : H.url);
    await page.waitForFunction(() => 'mochiStudio' in window);
    // As in real use: bridge views on, then the model is opened.
    const port = bridge.port;
    await page.evaluate(
      (u) => (window as any).mochiAgentLink.enableViews(u),
      `ws://127.0.0.1:${port}`,
    );
    await expect
      .poll(() => page.evaluate(() => (window as any).mochiAgentLink.state), { timeout: 20_000 })
      .toBe('pairing');
    await page.evaluate((c) => (window as any).mochiAgentLink.pair(c), bridge.store.pairingCode());
    await expect
      .poll(() => page.evaluate(() => (window as any).mochiAgentLink.state))
      .toBe('connected');
    // MOCHI_BENCH_GPU=<passes>: draw that many full-canvas passes of a heavy
    // shader every frame in the control window, like a heavy model drawn
    // with software WebGL (all pages of a browser share its GPU process).
    // It starts once the control window has loaded the model, as drawing does.
    const gpu = Number(process.env.MOCHI_BENCH_GPU ?? 0);
    const startGpuLoad = () =>
      page.evaluate((passes) => {
        const c = document.createElement('canvas');
        c.width = 1280;
        c.height = 720;
        c.style.cssText = 'position:fixed;left:0;top:0;width:64px;height:36px;opacity:0.01';
        document.body.append(c);
        const gl = c.getContext('webgl2')!;
        const sh = (type: number, src: string) => {
          const s = gl.createShader(type)!;
          gl.shaderSource(s, src);
          gl.compileShader(s);
          return s;
        };
        const prog = gl.createProgram()!;
        gl.attachShader(
          prog,
          sh(gl.VERTEX_SHADER, '#version 300 es\nin vec2 p;void main(){gl_Position=vec4(p,0,1);}'),
        );
        gl.attachShader(
          prog,
          sh(
            gl.FRAGMENT_SHADER,
            '#version 300 es\nprecision highp float;out vec4 o;void main(){float a=0.;for(int i=0;i<64;i++)a+=sin(gl_FragCoord.x*.01+float(i));o=vec4(a*.01);}',
          ),
        );
        gl.linkProgram(prog);
        gl.useProgram(prog);
        gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        // Part of each frame the control window draws, as a heavier model would be.
        const rt = (window as any).mochiStudio.runtime;
        const render = rt.render.bind(rt);
        rt.render = (dt: number) => {
          render(dt);
          for (let i = 0; i < passes; i++) gl.drawArrays(gl.TRIANGLES, 0, 3);
        };
      }, gpu);
    // MOCHI_BENCH_BUSY=<ms>: keep the main thread busy that long every frame,
    // like a control window drawing a heavy model with a slow GPU.
    const busy = Number(process.env.MOCHI_BENCH_BUSY ?? 0);
    if (busy)
      await page.evaluate((ms) => {
        const spin = (): void => {
          const end = performance.now() + ms;
          while (performance.now() < end) {
            /* busy */
          }
          requestAnimationFrame(spin);
        };
        requestAnimationFrame(spin);
      }, busy);
    const t0 = Date.now();
    const zipPath = join(mkdtempSync(join(tmpdir(), 'mochi-bench-zip-')), 'Big.zip');
    writeFileSync(zipPath, zip);
    await page.locator('#model-zip').setInputFiles(zipPath);
    await page.waitForFunction(() => (window as any).mochiStudio.settings !== undefined, null, {
      timeout: 120_000,
    });
    const controlMs = Date.now() - t0;
    if (gpu) await startGpuLoad();
    await openSection(page, 'Output');
    await expect
      .poll(() => page.locator('#obs-url').inputValue(), { timeout: 10_000 })
      .toContain('view=');
    const obs = await page.locator('#obs-url').inputValue();

    const waitUploads = process.env.MOCHI_BENCH_WAIT === '1';
    if (waitUploads)
      await expect
        .poll(() => page.evaluate(() => (window as any).mochiAgentLink.pendingUploads), {
          timeout: 120_000,
        })
        .toBe(0);
    const uploads = await page.evaluate(() => (window as any).mochiAgentLink.uploadStats);
    // Diagnostics: MOCHI_BENCH_STOP=1 stops the control window's frames while the view loads.
    if (process.env.MOCHI_BENCH_STOP === '1')
      await page.evaluate(() => (window as any).mochiStudio.stop());
    // MOCHI_BENCH_LOADING_FPS=<n>: the control window's frame cap while the view loads (0: none).
    if (process.env.MOCHI_BENCH_LOADING_FPS !== undefined)
      await page.evaluate(
        (n) => ((window as any).mochiStudio.loadingViewFps = n),
        Number(process.env.MOCHI_BENCH_LOADING_FPS),
      );
    await page.evaluate(() => {
      const w = window as any;
      w.benchFrames = 0;
      const rt = w.mochiStudio.runtime;
      const render = rt.render.bind(rt);
      rt.render = (dt: number) => {
        w.benchFrames++;
        render(dt);
      };
    });
    const ctx = await H.browser.newContext();
    const out = await ctx.newPage();
    const t1 = Date.now();
    await out.goto(obs);
    await out.waitForFunction(() => document.body.dataset.model !== undefined, null, {
      timeout: 180_000,
    });
    const viewMs = Date.now() - t1;
    const controlFps = (await page.evaluate(() => (window as any).benchFrames)) / (viewMs / 1000);
    process.stderr.write(
      `[bench] control window ${controlFps.toFixed(1)} fps while the view loaded\n`,
    );
    process.stderr.write(
      `[bench] uploads before: ${JSON.stringify(uploads)}; after: ${JSON.stringify(await page.evaluate(() => (window as any).mochiAgentLink.uploadStats))}\n`,
    );
    const stats = (await out.evaluate(() => (window as any).mochiOutput.loadStats)) ?? {};
    const line = `model ${(bytes / 1048576).toFixed(0)} MB: control window ${controlMs} ms; view through the bridge ${viewMs} ms (transfer ${stats.fetchMs} ms, load in total ${stats.loadMs} ms)${waitUploads ? `, opened after the upload (${uploads.ms} ms)` : ', opened at once'}; uploads ${inPage ? 'on the page' : 'in a worker'}${busy ? `, main thread busy ${busy} ms per frame` : ''}${gpu ? `, control window GPU load ${gpu} passes` : ''}`;
    console.log(line);
    process.stderr.write(`[bench] ${line}\n`);
    // The control window saw the progress and the result.
    await expect.poll(() => page.locator('#view-progress').textContent()).toContain('ready');
    // The bridge's part is the transfer; decoding and drawing cost the same as
    // in the control window (on a slow software renderer, more).
    expect(stats.fetchMs).toBeLessThan(5000);
    expect(viewMs).toBeLessThan(Math.max(controlMs, stats.loadMs - stats.fetchMs) + 5000);
    await ctx.close();
    await page.close();
  }, 300_000);
});
