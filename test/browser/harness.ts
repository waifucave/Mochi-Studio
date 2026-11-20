import { zipSync } from 'fflate';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { preview, type PreviewServer } from 'vite';
import { syntheticModelFiles } from '../support/syntheticModel';

export interface Harness {
  url: string;
  browser: Browser;
  context: BrowserContext;
  close(): Promise<void>;
}

/** Serves dist/ (run `vite build` first) and launches headless Chromium with fake media devices. */
export async function startHarness(): Promise<Harness> {
  const server: PreviewServer = await preview({
    preview: { port: 0, strictPort: false, host: '127.0.0.1' },
    logLevel: 'silent',
  });
  const url = server.resolvedUrls?.local[0];
  if (!url) throw new Error('preview server has no URL');
  // Playwright's own browser by default; CHROMIUM_PATH overrides it.
  const executablePath = process.env.CHROMIUM_PATH;
  const browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const context = await browser.newContext({
    permissions: ['camera', 'microphone'],
    viewport: { width: 1280, height: 800 },
  });
  return {
    url,
    browser,
    context,
    async close() {
      await browser.close();
      await new Promise<void>((r) => server.httpServer.close(() => r()));
    },
  };
}

/** A made-up model folder (built with Mochi2D's writeMoc, not real model data) as a zip. */
export function syntheticModelZip(): Uint8Array {
  const files = syntheticModelFiles();
  return zipSync(Object.fromEntries(Object.entries(files).map(([p, d]) => [`Test/${p}`, d])));
}

/** The made-up model with a physics file (written with Mochi2D's writePhysics), as a zip. */
export function syntheticPhysicsModelZip(): Uint8Array {
  const files = syntheticModelFiles({ withPhysics: true });
  return zipSync(Object.fromEntries(Object.entries(files).map(([p, d]) => [`Test/${p}`, d])));
}

/** The made-up model whose open mouth is drawn behind its body (a draw order that changes). */
export function syntheticReorderingModelZip(): Uint8Array {
  const files = syntheticModelFiles({ mouthBehindWhenOpen: true });
  return zipSync(Object.fromEntries(Object.entries(files).map(([p, d]) => [`Test/${p}`, d])));
}

/** A made-up item model folder as a zip. */
export function syntheticItemZip(): Uint8Array {
  const files = syntheticModelFiles({ name: 'hat', color: [220, 60, 60], withItemExtras: true });
  return zipSync(Object.fromEntries(Object.entries(files).map(([p, d]) => [`Hat/${p}`, d])));
}

/** Where each old section now lives: a settings tab, or (Items) the items sheet. */
const SECTION_TAB = {
  Audio: 'General',
  Agents: 'General',
  Tracking: 'Camera',
  Output: 'Camera',
  Model: 'Model',
  Mapping: 'Model',
  Hotkeys: 'Hotkeys',
} as const;
export type Section = keyof typeof SECTION_TAB | 'Items';

/** Opens a section the way a user does: the ☰ menu, then Settings and a tab (or Items). */
export async function openSection(page: Page, name: Section): Promise<void> {
  const menu = page.locator('#main-menu');
  if (!(await menu.isVisible())) await page.locator('#menu-button').click();
  if (name === 'Items') {
    await page.locator('#menu-items').click();
    return;
  }
  await page.locator('#menu-settings').click();
  await page.getByRole('tab', { name: SECTION_TAB[name], exact: true }).click();
}
