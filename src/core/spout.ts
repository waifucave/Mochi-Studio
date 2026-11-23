/**
 * Spout2 output, in the desktop app on Windows: each output
 * sends the model, without the user interface, on a transparent background
 * with premultiplied color, to programs on the same computer (OBS's Spout2
 * plugin). Its sender is named after the app and numbered by output:
 * `MochiStudio`, `MochiStudio2`, …
 *
 * These are the settings (app-wide) and what the control window tells the
 * desktop app's main process, which renders each output off screen and
 * sends its frames (desktop/spout.ts).
 */

export interface SpoutOutputSetting {
  enabled: boolean;
  /** Flipped horizontally, as in a mirror. */
  mirror: boolean;
  /** A fixed size in pixels; without it, the stage's size. */
  size?: { width: number; height: number };
}

export interface SpoutSettings {
  outputs: SpoutOutputSetting[];
}

export const SPOUT_MAX_OUTPUTS = 4;
export const SPOUT_MIN_SIZE = 16;
export const SPOUT_MAX_SIZE = 7680;

export const DEFAULT_SPOUT: SpoutSettings = { outputs: [{ enabled: false, mirror: false }] };

/** The sender name of the n-th output (0 first): MochiStudio, MochiStudio2, … */
export function spoutSenderName(index: number): string {
  return index === 0 ? 'MochiStudio' : `MochiStudio${index + 1}`;
}

const clampSize = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v)
    ? Math.max(SPOUT_MIN_SIZE, Math.min(SPOUT_MAX_SIZE, Math.round(v)))
    : undefined;

/** Reads stored settings safely: at least one output, at most four. */
export function parseSpout(v: unknown): SpoutSettings {
  const raw = (typeof v === 'object' && v !== null ? v : {}) as { outputs?: unknown };
  const list = Array.isArray(raw.outputs) ? raw.outputs : [];
  const outputs = list.flatMap((o): SpoutOutputSetting[] => {
    if (typeof o !== 'object' || o === null) return [];
    const x = o as Record<string, unknown>;
    const s = x.size as Record<string, unknown> | undefined;
    const width = clampSize(s?.width);
    const height = clampSize(s?.height);
    return [
      {
        enabled: x.enabled === true,
        mirror: x.mirror === true,
        ...(width && height ? { size: { width, height } } : {}),
      },
    ];
  });
  return {
    outputs: outputs.length
      ? outputs.slice(0, SPOUT_MAX_OUTPUTS)
      : structuredClone(DEFAULT_SPOUT.outputs),
  };
}

/** One output as the main process renders it. */
export interface SpoutOutputConfig {
  name: string;
  width: number;
  height: number;
  mirror: boolean;
}

/** What the control window sends: the outputs that are on (the others are released). */
export interface SpoutConfig {
  /** The output page's address (the app's own output view, transparent). */
  page: string;
  fps: number;
  outputs: SpoutOutputConfig[];
  /** For measurements and tests: the frames' path. Default: the GPU's when it can. */
  path?: 'auto' | 'readback';
  /** For tests: never draw at a scale (an output larger than the screen at its own size). */
  noScale?: boolean;
}

export type SpoutPath = 'gpu' | 'readback';

export interface SpoutOutputState {
  name: string;
  /** Sending frames. */
  active: boolean;
  width: number;
  height: number;
  mirror: boolean;
  /** How frames reach the sender: kept on the GPU, or read back to memory. */
  path?: SpoutPath;
  frames: number;
  /** The frames a second it may send now (lowered while the app's window answers slowly). */
  fps?: number;
  /** The frames a second it actually sends (over the last few seconds). */
  sentFps?: number;
  /** Held below the rate asked for: this computer can't keep up at this size. */
  held?: boolean;
  error?: string;
}

export interface SpoutState {
  /** Spout2 can run here (the desktop app on Windows, with its module). */
  available: boolean;
  /** Why not, when it cannot. */
  problem?: string;
  outputs: SpoutOutputState[];
}

/** The size an output sends: its fixed size, or the stage's (in device pixels, even). */
export function spoutSize(
  o: SpoutOutputSetting,
  stage: { width: number; height: number },
): { width: number; height: number } {
  if (o.size) return { ...o.size };
  const even = (v: number) =>
    Math.max(SPOUT_MIN_SIZE, Math.min(SPOUT_MAX_SIZE, Math.round(v / 2) * 2));
  return { width: even(stage.width), height: even(stage.height) };
}

/** The configuration for the main process, from the settings and the stage's size. */
export function spoutConfig(
  s: SpoutSettings,
  stage: { width: number; height: number },
  page: string,
  fps: number,
): SpoutConfig {
  return {
    page,
    fps: Math.max(1, Math.min(60, Math.round(fps > 0 ? fps : 60))),
    outputs: s.outputs.flatMap((o, i) =>
      o.enabled ? [{ name: spoutSenderName(i), mirror: o.mirror, ...spoutSize(o, stage) }] : [],
    ),
  };
}

/** The address an output's page loads: the output view, transparent, perhaps mirrored. */
export function spoutPageUrl(page: string, o: SpoutOutputConfig): string {
  const u = new URL(page);
  u.searchParams.set('transparent', '1');
  u.searchParams.set('spout', o.name);
  if (o.mirror) u.searchParams.set('mirror', '1');
  else u.searchParams.delete('mirror');
  return u.href;
}

/**
 * The main process's check of a configuration from the page: the app's own
 * output view only, at most four outputs with the app's sender names, sizes
 * and rates within bounds.
 */
export function parseSpoutConfig(v: unknown, origin: string): SpoutConfig | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const x = v as Record<string, unknown>;
  if (typeof x.page !== 'string') return undefined;
  let page: URL;
  try {
    page = new URL(x.page);
  } catch {
    return undefined;
  }
  if (page.origin !== origin || page.pathname !== '/app/output.html') return undefined;
  const names = new Set(Array.from({ length: SPOUT_MAX_OUTPUTS }, (_, i) => spoutSenderName(i)));
  const seen = new Set<string>();
  const outputs = (Array.isArray(x.outputs) ? x.outputs : []).flatMap((o): SpoutOutputConfig[] => {
    if (typeof o !== 'object' || o === null) return [];
    const y = o as Record<string, unknown>;
    const name = typeof y.name === 'string' ? y.name : '';
    const width = clampSize(y.width);
    const height = clampSize(y.height);
    if (!names.has(name) || seen.has(name) || !width || !height) return [];
    seen.add(name);
    return [{ name, width, height, mirror: y.mirror === true }];
  });
  const fps = typeof x.fps === 'number' && Number.isFinite(x.fps) ? x.fps : 60;
  return {
    page: page.href,
    fps: Math.max(1, Math.min(60, Math.round(fps))),
    outputs,
    ...(x.path === 'readback' ? { path: 'readback' as const } : {}),
    ...(x.noScale === true ? { noScale: true } : {}),
  };
}

/**
 * The drawing scale for an output: 1 when it fits the screen's work area,
 * else the smallest whole scale that divides both sides and makes it fit
 * (so frames keep the exact size), else the smallest that makes it fit.
 */
export function drawScale(
  o: { width: number; height: number },
  area: { width: number; height: number },
): number {
  const fits = (k: number) => o.width / k <= area.width && o.height / k <= area.height;
  if (fits(1)) return 1;
  for (let k = 2; k <= 8; k++) if (o.width % k === 0 && o.height % k === 0 && fits(k)) return k;
  return Math.ceil(Math.max(o.width / area.width, o.height / area.height));
}
