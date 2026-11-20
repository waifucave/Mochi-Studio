/**
 * A stream, compressed: the control window with
 * tracking fed at 30 frames a second, a plugin connected (injecting
 * parameters, loading and unloading items, toggling expressions, asking for
 * state), hotkeys pressed, items added and removed, an output view open (and
 * refreshed, as OBS does), and the light overlay on a made-up capture.
 *
 * The events of `streamMinutes` of streaming are packed into `minutes` of
 * real time; tracking, injection and drawing run at their real rates. Memory
 * is sampled in the window and in the output view after a forced garbage
 * collection: the JS heap, DOM nodes, event listeners, and the WebGL objects
 * alive (counted by wrapping WebGL's create and delete calls).
 *
 * Used by test/browser/soak.test.ts (short) and scripts/soak.ts (long).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CDPSession, Page } from 'playwright-core';
import { BridgeServer } from '../../bridge/src/server.ts';
import { BridgeStore } from '../../bridge/src/store.ts';
import {
  openSection,
  startHarness,
  syntheticItemZip,
  syntheticModelZip,
  type Harness,
} from '../browser/harness';
import { PluginClient } from './pluginClient';
import { encodePng } from './syntheticModel';

export interface SoakOptions {
  /** Real minutes to run. */
  minutes: number;
  /** Stream minutes whose events are packed into them (default 60). */
  streamMinutes?: number;
  /** Seconds between memory samples. */
  sampleEvery?: number;
  /** The model as a zip (default: the small synthetic model). */
  modelZip?: Uint8Array;
  /** Progress lines. */
  log?: (m: string) => void;
}

export interface PageSample {
  heapMB: number;
  nodes: number;
  listeners: number;
  gl: Record<string, number>;
  frames: number;
}

export interface SoakSample {
  /** Real seconds since the start. */
  t: number;
  /** Stream minutes covered so far. */
  streamMinute: number;
  window: PageSample;
  view: PageSample;
  items: number;
}

export interface SoakResult {
  samples: SoakSample[];
  events: Record<string, number>;
  errors: string[];
  /** Frames a second drawn, over the run. */
  fps: { window: number; view: number };
  /**
   * Frames a second drawn before the events start (tracking, the plugin's
   * injections and the light overlay running): what this machine draws.
   */
  baseFps: { window: number; view: number };
}

/**
 * Run through tsx (the scripts), functions handed to the page may call
 * esbuild's `__name` helper, which the page lacks: a no-op one.
 */
export const KEEP_NAMES = 'globalThis.__name ??= (f) => f;';

/** Events per stream hour. */
const RATES: Record<string, number> = {
  hotkeyKey: 120,
  hotkeyPlugin: 120,
  expression: 120,
  pluginItemLoad: 60,
  pluginItemUnload: 60,
  imageItemAdd: 20,
  imageItemRemove: 20,
  pluginQuery: 720,
  viewRefresh: 4,
};

/** Counts live WebGL objects: wraps the create and delete calls (added before the page's scripts). */
function countGl(): void {
  const w = window as unknown as { glLive: Record<string, number> };
  w.glLive = {};
  const kinds = [
    'Texture',
    'Buffer',
    'Framebuffer',
    'Renderbuffer',
    'Program',
    'Shader',
    'VertexArray',
  ];
  for (const proto of [WebGLRenderingContext.prototype, WebGL2RenderingContext.prototype] as any[])
    for (const k of kinds) {
      const make = proto[`create${k}`];
      const drop = proto[`delete${k}`];
      if (!make || !drop || make.__counted) continue;
      proto[`create${k}`] = function (this: unknown, ...a: unknown[]) {
        const o = make.apply(this, a);
        if (o) w.glLive[k] = (w.glLive[k] ?? 0) + 1;
        return o;
      };
      proto[`create${k}`].__counted = true;
      proto[`delete${k}`] = function (this: unknown, o: unknown) {
        if (o) w.glLive[k] = (w.glLive[k] ?? 0) - 1;
        return drop.call(this, o);
      };
    }
}

/** The light overlay's capture stand-in: a canvas whose colors change slowly. */
function fakeCapture(): void {
  navigator.mediaDevices.getDisplayMedia = async () => {
    const c = document.createElement('canvas');
    c.width = 96;
    c.height = 54;
    const g = c.getContext('2d')!;
    let hue = 0;
    setInterval(() => {
      hue = (hue + 3) % 360;
      g.fillStyle = `hsl(${hue} 70% 50%)`;
      g.fillRect(0, 0, 96, 54);
    }, 100);
    return c.captureStream(10);
  };
}

/**
 * Opens an output view as its own window (a popup of the control window, so
 * its sync reaches it): a background tab would get almost no animation
 * frames, while an OBS browser source always draws.
 */
export async function openViewWindow(page: Page, url: string): Promise<Page> {
  await page.context().addInitScript(countGl);
  const [view] = await Promise.all([
    page.context().waitForEvent('page'),
    page.evaluate((u) => void window.open(u, '_blank', 'noopener,popup,width=960,height=540'), url),
  ]);
  await view.waitForLoadState();
  return view;
}

async function sample(page: Page, cdp: CDPSession, global: string): Promise<PageSample> {
  await cdp.send('HeapProfiler.collectGarbage');
  const { metrics } = (await cdp.send('Performance.getMetrics')) as {
    metrics: { name: string; value: number }[];
  };
  const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
  const inPage = await page.evaluate(
    (g) => ({
      gl: { ...((window as any).glLive ?? {}) },
      frames: (window as any)[g]?.framesDrawn ?? 0,
    }),
    global,
  );
  return {
    heapMB: Math.round(((m.JSHeapUsedSize ?? 0) / 1048576) * 10) / 10,
    nodes: m.Nodes ?? 0,
    listeners: m.JSEventListeners ?? 0,
    ...inPage,
  };
}

/** A small picture, different each time (a dropped image item). */
function picture(n: number): Uint8Array {
  const w = 64;
  const rgba = new Uint8Array(w * w * 4);
  for (let i = 0; i < w * w; i++) rgba.set([(n * 40) % 256, 120, 200, 255], i * 4);
  return encodePng(w, w, rgba);
}

export async function runSoak(o: SoakOptions): Promise<SoakResult> {
  const log = o.log ?? (() => undefined);
  const streamMinutes = o.streamMinutes ?? 60;
  const scale = streamMinutes / o.minutes;
  const sampleEvery = (o.sampleEvery ?? 10) * 1000;
  const errors: string[] = [];
  const events: Record<string, number> = Object.fromEntries(Object.keys(RATES).map((k) => [k, 0]));
  let H: Harness | undefined;
  let bridge: BridgeServer | undefined;
  let plugin: PluginClient | undefined;
  try {
    H = await startHarness();
    await H.context.addInitScript({ content: KEEP_NAMES });
    const store = new BridgeStore(mkdtempSync(join(tmpdir(), 'mochi-soak-')));
    const pluginPort = 27_300 + Math.floor(Math.random() * 600);
    bridge = new BridgeServer({
      port: 0,
      store,
      log: () => undefined,
      plugins: { port: pluginPort, broadcastAddress: '127.0.0.1', broadcastPort: 9 },
    });
    const bridgePort = await bridge.listen();
    const page = await H.context.newPage();
    page.on('pageerror', (e) => errors.push(`window: ${e.message}`));
    await page.addInitScript(countGl);
    await page.addInitScript(fakeCapture);
    await page.goto(H.url);
    await page.waitForFunction(() => 'mochiStudio' in window);
    await page.locator('#model-zip').setInputFiles({
      name: 'Model.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(o.modelZip ?? syntheticModelZip()),
    });
    await page.waitForFunction(() => (window as any).mochiStudio.settings !== undefined, null, {
      timeout: 120_000,
    });
    log('model loaded');

    // The person's item (plugins load copies of it by name), and the hotkeys.
    await page.locator('#item-zip').setInputFiles({
      name: 'Hat.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(syntheticItemZip()),
    });
    await page.waitForFunction(() => (window as any).mochiStudio.items.length === 1);
    const expressions: { name: string; file: string }[] = await page.evaluate(() =>
      (window as any).mochiStudio.model.manifest.expressions.map((e: any) => ({
        name: e.name,
        file: String(e.file).split('/').pop(),
      })),
    );
    await page.evaluate(
      (exp) =>
        (window as any).mochiStudio.updateSettings({
          hotkeys: [
            {
              id: 'blush',
              label: 'Blush',
              keys: 'KeyB',
              button: false,
              action: { type: 'expression', expression: exp },
            },
            {
              id: 'hat',
              label: 'Hat',
              keys: 'KeyH',
              button: false,
              action: { type: 'item', item: (window as any).mochiStudio.items[0].id },
            },
          ],
        }),
      expressions[0]!.name,
    );

    // The plugin, through the bridge.
    await openSection(page, 'Agents');
    await page.locator('#bridge-url').fill(`ws://127.0.0.1:${bridgePort}`);
    await page.locator('#plugins-toggle').check();
    await page.locator('#plugins-pair-code').waitFor({ state: 'visible' });
    await page.locator('#plugins-pair-code').fill(store.pairingCode());
    await page.locator('#plugins-pair-code ~ button').click();
    await page.waitForFunction(
      (p) => document.querySelector('#plugins-status')?.textContent?.includes(p),
      `ws://localhost:${pluginPort}`,
    );
    await page.keyboard.press('Escape');
    plugin = await PluginClient.connect(`ws://localhost:${pluginPort}`);
    const tokenId = plugin.send('AuthenticationTokenRequest', {
      pluginName: 'Soak Plugin',
      pluginDeveloper: 'Tester',
    });
    await page.locator('#plugin-approval').waitFor({ state: 'visible' });
    await page.locator('#plugin-allow').click();
    const token = await plugin.next((m) => m.requestID === tokenId, 10_000);
    await plugin.request('AuthenticationRequest', {
      pluginName: 'Soak Plugin',
      pluginDeveloper: 'Tester',
      authenticationToken: token.data.authenticationToken,
    });
    log('plugin connected');

    // The light overlay, and tracking at 30 frames a second.
    await page.evaluate(() => (window as any).mochiStudio.startLightOverlay());
    await page.evaluate(() => {
      const w = window as any;
      const t0 = performance.now();
      w.soakFeed = setInterval(() => {
        const t = performance.now();
        const s = (t - t0) / 1000;
        const yaw = Math.sin(s * 0.7) * 0.3;
        const c = Math.cos(yaw);
        const n = Math.sin(yaw);
        w.mochiStudio.feedFrame({
          t,
          face: true,
          blendshapes: {
            jawOpen: (Math.sin(s * 3) + 1) / 3,
            eyeBlinkLeft: s % 4 < 0.15 ? 1 : 0,
            eyeBlinkRight: s % 4 < 0.15 ? 1 : 0,
            mouthSmileLeft: 0.3,
            mouthSmileRight: 0.3,
          },
          matrix: [c, 0, -n, 0, 0, 1, 0, 0, n, 0, c, 0, 0, 0, -40, 1],
        });
      }, 33);
    });

    // The output view (in this browser, as the window's own sync reaches it).
    const viewUrl = new URL('output.html', H.url).href;
    const watchView = (v: Page) => v.on('pageerror', (e) => errors.push(`view: ${e.message}`));
    let view = await openViewWindow(page, viewUrl);
    watchView(view);
    await view.waitForFunction(() => !!document.body.dataset.model, null, { timeout: 120_000 });
    await page.bringToFront();
    log('output view ready');

    const wcdp = await page.context().newCDPSession(page);
    await wcdp.send('Performance.enable');
    let vcdp = await view.context().newCDPSession(view);
    await vcdp.send('Performance.enable');

    const pluginItems: string[] = [];
    const imageItems: string[] = [];
    let blushOn = false;
    let pictures = 0;
    const injector = setInterval(() => {
      plugin?.send('InjectParameterDataRequest', {
        faceFound: true,
        mode: 'set',
        parameterValues: [
          { id: 'FaceAngleZ', value: Math.sin(Date.now() / 900) * 10 },
          { id: 'MouthSmile', value: 0.5 },
        ],
      });
    }, 100);
    const queries = [
      'ItemListRequest',
      'StatisticsRequest',
      'CurrentModelRequest',
      'InputParameterListRequest',
      'ExpressionStateRequest',
      'SceneColorOverlayInfoRequest',
      'FaceFoundRequest',
      'HotkeysInCurrentModelRequest',
    ];

    const act: Record<string, () => Promise<void>> = {
      hotkeyKey: async () => {
        await page.keyboard.press(Math.random() < 0.5 ? 'KeyB' : 'KeyH');
      },
      hotkeyPlugin: async () => {
        await plugin!.request('HotkeyTriggerRequest', { hotkeyID: 'blush' }, 60_000);
      },
      expression: async () => {
        blushOn = !blushOn;
        await plugin!.request('ExpressionActivationRequest', {
          expressionFile: expressions[1 % expressions.length]!.file,
          active: blushOn,
        });
      },
      pluginItemLoad: async () => {
        if (pluginItems.length >= 3) return;
        // A busy renderer (a large model in software WebGL) can answer late: wait for it, or
        // the item it loads is left behind untracked.
        const r = await plugin!.request(
          'ItemLoadRequest',
          {
            fileName: 'Hat',
            positionX: Math.random() - 0.5,
            positionY: Math.random() - 0.5,
            size: 0.2,
          },
          60_000,
        );
        if (r.data.instanceID) {
          pluginItems.push(r.data.instanceID);
          events.pluginItemLoaded = (events.pluginItemLoaded ?? 0) + 1;
        }
      },
      pluginItemUnload: async () => {
        const id = pluginItems.shift();
        if (id) await plugin!.request('ItemUnloadRequest', { instanceIDs: [id] }, 60_000);
      },
      imageItemAdd: async () => {
        if (imageItems.length >= 2) return;
        const n = ++pictures;
        const bytes = [...picture(n)];
        await page.evaluate(
          ({ bytes, n }) => {
            const dt = new DataTransfer();
            dt.items.add(
              new File([new Uint8Array(bytes)], `sticker${n}.png`, { type: 'image/png' }),
            );
            document
              .querySelector('.stage-wrap')!
              .dispatchEvent(
                new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }),
              );
          },
          { bytes, n },
        );
        // A busy renderer (a large model in software WebGL) can take a while: wait for it,
        // by its name (the plugin's items come and go meanwhile), so it isn't left untracked.
        const label = `sticker${n}`;
        const added: string[] = await page
          .waitForFunction(
            (label) => {
              const ids = (window as any).mochiStudio.items
                .filter((i: any) => i.label === label)
                .map((i: any) => i.id);
              return ids.length ? ids : false;
            },
            label,
            { timeout: 60_000, polling: 100 },
          )
          .then((h) => h.jsonValue() as Promise<string[]>)
          .catch(() => [] as string[]);
        if (!added.length) throw new Error('the dropped picture did not become an item');
        imageItems.push(...added);
        events.imageItemAdded = (events.imageItemAdded ?? 0) + 1;
      },
      imageItemRemove: async () => {
        const id = imageItems.shift();
        if (id) await page.evaluate((id) => (window as any).mochiStudio.removeItem(id), id);
      },
      pluginQuery: async () => {
        await plugin!.request(queries[events.pluginQuery! % queries.length]!, {}, 60_000);
      },
      viewRefresh: async () => {
        await vcdp.detach().catch(() => undefined);
        await view.close();
        view = await openViewWindow(page, viewUrl);
        watchView(view);
        await view.waitForFunction(() => !!document.body.dataset.model, null, {
          timeout: 120_000,
        });
        await page.bringToFront();
        vcdp = await view.context().newCDPSession(view);
        await vcdp.send('Performance.enable');
      },
    };

    // What this machine draws before the events start, for the run to be measured against.
    const drawn = (p: Page, g: string) =>
      p.evaluate((g) => (window as any)[g].framesDrawn as number, g);
    const b0 = {
      at: Date.now(),
      window: await drawn(page, 'mochiStudio'),
      view: await drawn(view, 'mochiOutput'),
    };
    await new Promise((r) => setTimeout(r, 3000));
    const b1 = {
      at: Date.now(),
      window: await drawn(page, 'mochiStudio'),
      view: await drawn(view, 'mochiOutput'),
    };
    const baseFps = {
      window: Math.round(((b1.window - b0.window) / (b1.at - b0.at)) * 10_000) / 10,
      view: Math.round(((b1.view - b0.view) / (b1.at - b0.at)) * 10_000) / 10,
    };
    log(`frames a second before the events: ${JSON.stringify(baseFps)}`);

    const samples: SoakSample[] = [];
    const start = Date.now();
    const frames0 = {
      window: await page.evaluate(() => (window as any).mochiStudio.framesDrawn as number),
      view: 0,
    };
    let viewFrames = 0;
    let lastViewFrames = 0;
    const take = async () => {
      const w = await sample(page, wcdp, 'mochiStudio');
      const v = await sample(view, vcdp, 'mochiOutput');
      // A refreshed view counts from 0 again.
      viewFrames += v.frames >= lastViewFrames ? v.frames - lastViewFrames : v.frames;
      lastViewFrames = v.frames;
      const s: SoakSample = {
        t: Math.round((Date.now() - start) / 100) / 10,
        streamMinute: Math.round(((Date.now() - start) / 60000) * scale * 10) / 10,
        window: w,
        view: v,
        items: await page.evaluate(() => (window as any).mochiStudio.items.length as number),
      };
      samples.push(s);
      log(
        `t=${s.t}s stream ${s.streamMinute} min: window ${w.heapMB} MB, ${w.nodes} nodes, ` +
          `${w.listeners} listeners, gl ${JSON.stringify(w.gl)}; view ${v.heapMB} MB, ` +
          `${v.nodes} nodes; items ${s.items}`,
      );
    };
    await take();
    let nextSample = start + sampleEvery;
    const end = start + o.minutes * 60_000;
    const pause = () => new Promise((r) => setTimeout(r, 50));
    /** Runs the next event of a kind if the stream's clock has reached it. */
    const due = async (k: string): Promise<boolean> => {
      const streamHours = ((Date.now() - start) / 3_600_000) * scale;
      if (events[k]! >= Math.floor(streamHours * RATES[k]!)) return false;
      try {
        await act[k]!();
      } catch (e) {
        errors.push(`${k}: ${(e as Error).message}`);
      }
      events[k]!++;
      return true;
    };
    // Each kind of event on its own schedule, as on a stream: a slow one (an item that a
    // software renderer takes a while to load) doesn't hold up the hotkeys. Refreshing the
    // view and sampling share one, as a refresh replaces the view that is sampled.
    const lanes = Object.keys(RATES)
      .filter((k) => k !== 'viewRefresh')
      .map(async (k) => {
        while (Date.now() < end) if (!(await due(k))) await pause();
      });
    while (Date.now() < end) {
      await due('viewRefresh');
      if (Date.now() >= nextSample) {
        await take();
        nextSample += sampleEvery;
      }
      await pause();
    }
    await Promise.all(lanes);
    clearInterval(injector);
    // Everything added is removed again: the WebGL objects should return to where they were.
    for (const id of pluginItems.splice(0))
      await plugin.request('ItemUnloadRequest', { instanceIDs: [id] }, 60_000);
    for (const id of imageItems.splice(0))
      await page.evaluate((id) => (window as any).mochiStudio.removeItem(id), id);
    await new Promise((r) => setTimeout(r, 1000));
    await take();
    const seconds = (Date.now() - start) / 1000;
    const wf =
      (await page.evaluate(() => (window as any).mochiStudio.framesDrawn)) - frames0.window;
    return {
      samples,
      events,
      errors,
      fps: {
        window: Math.round((wf / seconds) * 10) / 10,
        view: Math.round((viewFrames / seconds) * 10) / 10,
      },
      baseFps,
    };
  } finally {
    plugin?.close();
    await bridge?.close();
    await H?.close();
  }
}

/** Growth from the first sample after warm-up to the last: heap, nodes, listeners. */
export function growth(samples: SoakSample[], pageName: 'window' | 'view', warmup = 1) {
  const a = samples[Math.min(warmup, samples.length - 1)]![pageName];
  const b = samples.at(-1)![pageName];
  return {
    heapMB: Math.round((b.heapMB - a.heapMB) * 10) / 10,
    nodes: b.nodes - a.nodes,
    listeners: b.listeners - a.listeners,
  };
}
