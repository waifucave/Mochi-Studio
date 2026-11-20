/**
 * The display light overlay (the plugin API's
 * `SceneColorOverlayInfoRequest`): the colors of
 * a captured screen or window light the model, and the items if chosen.
 *
 * - **The capture parts.** The picture is cut into three upright thirds:
 *   left, middle and right. Each is averaged, and the overlay's average
 *   takes the parts that are on (white with none).
 * - **The final color**, per channel (the documented formula):
 *   `overlay = average × colorBoost / 50 + 255 × baseBrightness / 100`,
 *   at most 459 (1.8 × 255).
 * - **Smoothing** (0 to 60): Mochi Studio's reading is a time constant of
 *   `smoothing / 30` seconds (60: two seconds; 0: none).
 * - **What the model gets:** `overlay / 255` per channel as a multiply
 *   tint, from 0 to 1.8: Mochi2D 0.14.0's tints go up to 2 (the color
 *   limited to white), so the formula's whole range shows.
 *
 * Only these averages are used: no frame is kept or sent anywhere.
 */

export type Rgb = [number, number, number];
export type CapturePart = 'left' | 'middle' | 'right';
export const CAPTURE_PARTS: readonly CapturePart[] = ['left', 'middle', 'right'];

/** The person's settings (app-wide). */
export interface LightOverlaySettings {
  /** 0 to 100. */
  baseBrightness: number;
  /** 0 to 100; 50 keeps the captured colors as they are. */
  colorBoost: number;
  /** 0 to 60. */
  smoothing: number;
  /** Which thirds of the picture count. */
  parts: Record<CapturePart, boolean>;
  /** The items are lit too. */
  items: boolean;
  /** The static color (0–255), used instead of a capture. */
  staticColor: Rgb;
}

/**
 * The documented values, which settings files also carry: brightness 15,
 * overlay 40, smoothing 3, every part on, items included.
 */
export const DEFAULT_LIGHT_OVERLAY: LightOverlaySettings = {
  baseBrightness: 15,
  colorBoost: 40,
  smoothing: 3,
  parts: { left: true, middle: true, right: true },
  items: true,
  staticColor: [255, 255, 255],
};

/** A fresh copy of the defaults (Reset). */
export const defaultLightOverlay = (): LightOverlaySettings => ({
  ...DEFAULT_LIGHT_OVERLAY,
  parts: { ...DEFAULT_LIGHT_OVERLAY.parts },
  staticColor: [...DEFAULT_LIGHT_OVERLAY.staticColor],
});

/** Where the light's color comes from: a capture, or the static color. */
export type LightSource = 'capture' | 'static';

export const OVERLAY_MAX = 459;
const WHITE: Rgb = [255, 255, 255];

const num = (v: unknown, d: number, lo: number, hi: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.min(hi, Math.max(lo, v))) : d;

export function parseLightOverlay(raw: unknown): LightOverlaySettings {
  const o =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const p =
    typeof o.parts === 'object' && o.parts !== null ? (o.parts as Record<string, unknown>) : {};
  const d = DEFAULT_LIGHT_OVERLAY;
  return {
    baseBrightness: num(o.baseBrightness, d.baseBrightness, 0, 100),
    colorBoost: num(o.colorBoost, d.colorBoost, 0, 100),
    smoothing: num(o.smoothing, d.smoothing, 0, 60),
    parts: {
      left: p.left !== false,
      middle: p.middle !== false,
      right: p.right !== false,
    },
    items: typeof o.items === 'boolean' ? o.items : d.items,
    staticColor: parseRgb(o.staticColor) ?? [...d.staticColor],
  };
}

function parseRgb(v: unknown): Rgb | undefined {
  if (!Array.isArray(v) || v.length < 3) return undefined;
  const c = v.slice(0, 3).map((x) => (typeof x === 'number' && Number.isFinite(x) ? x : NaN));
  return c.every((x) => !Number.isNaN(x))
    ? (c.map((x) => Math.round(Math.min(255, Math.max(0, x)))) as Rgb)
    : undefined;
}

/**
 * An art mesh's own tint under the light, with its strength `s` (0 to 1): `1 + s · (light − 1)`
 * per channel, so 0 leaves the mesh as it is and 1 takes the whole light.
 */
export function strengthTint(light: readonly number[], s: number): number[] {
  const k = Math.min(1, Math.max(0, s));
  return light.map((c) => 1 + k * (c - 1));
}

/** Stored per-mesh strengths: mesh ID → 0 to 1 (two decimals); 1s are left out. */
export function parseLightStrengths(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
  for (const [id, v] of Object.entries(raw).slice(0, 5000))
    if (id && typeof v === 'number' && Number.isFinite(v)) {
      const k = Math.round(Math.min(1, Math.max(0, v)) * 100) / 100;
      if (k !== 1) out[id.slice(0, 100)] = k;
    }
  return out;
}

/**
 * A «Screen Overlay» hotkey's settings: off, the
 * static color, or a capture, with the panel's settings as recorded. `raw`
 * keeps an imported file's `ColorOverlay` as it is.
 */
export interface ScreenOverlayAction {
  on: boolean;
  source: LightSource;
  settings: LightOverlaySettings;
  /** The file's window name, when it recorded one (Mochi Studio does not look for it). */
  windowName?: string;
  raw?: Record<string, unknown>;
}

/** A `.vtube.json` hotkey's `ColorOverlay` object as a Screen Overlay action. */
export function overlayFromFile(o: Record<string, unknown>): ScreenOverlayAction {
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  const sc =
    typeof o.StaticColor === 'object' && o.StaticColor !== null
      ? (o.StaticColor as Record<string, unknown>)
      : {};
  const frac = (v: unknown): number => Math.round(Math.min(1, Math.max(0, num(v) ?? 0)) * 255);
  const windowName = typeof o.WindowName === 'string' ? o.WindowName : '';
  return {
    on: o.On === true,
    source: o.IsStaticColor === true ? 'static' : 'capture',
    settings: parseLightOverlay({
      baseBrightness: num(o.BaseValue),
      colorBoost: num(o.OverlayValue),
      smoothing: num(o.Smoothing),
      parts: {
        left: o.IncludeLeft !== false,
        middle: o.IncludeMid !== false,
        right: o.IncludeRight !== false,
      },
      items: o.IncludeItems === true,
      staticColor: [frac(sc.r), frac(sc.g), frac(sc.b)],
    }),
    ...(windowName ? { windowName: windowName.slice(0, 200) } : {}),
    raw: JSON.parse(JSON.stringify(o)) as Record<string, unknown>,
  };
}

/** A stored Screen Overlay action, read safely. */
export function parseScreenOverlay(v: unknown): ScreenOverlayAction {
  const o = typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  let raw: Record<string, unknown> | undefined;
  if (typeof o.raw === 'object' && o.raw !== null && !Array.isArray(o.raw)) {
    const text = JSON.stringify(o.raw);
    if (text.length <= 4000) raw = JSON.parse(text) as Record<string, unknown>;
  }
  return {
    on: o.on === true,
    source: o.source === 'static' ? 'static' : 'capture',
    settings: parseLightOverlay(o.settings),
    ...(typeof o.windowName === 'string' && o.windowName
      ? { windowName: o.windowName.slice(0, 200) }
      : {}),
    ...(raw ? { raw } : {}),
  };
}

/** Each third's average color, from RGBA pixels (alpha ignored), 0 to 255. */
export function partAverages(
  data: ArrayLike<number>,
  width: number,
  height: number,
): Record<CapturePart, Rgb> {
  const sums = CAPTURE_PARTS.map(() => [0, 0, 0, 0]);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const part = Math.min(2, Math.floor((x * 3) / width));
      const o = (y * width + x) * 4;
      const s = sums[part]!;
      s[0]! += data[o] ?? 0;
      s[1]! += data[o + 1] ?? 0;
      s[2]! += data[o + 2] ?? 0;
      s[3]!++;
    }
  const avg = (s: number[]): Rgb =>
    s[3] ? [s[0]! / s[3], s[1]! / s[3], s[2]! / s[3]] : [...WHITE];
  return { left: avg(sums[0]!), middle: avg(sums[1]!), right: avg(sums[2]!) };
}

/** The average over the parts that are on (white when none is). */
export function activeAverage(
  parts: Record<CapturePart, Rgb>,
  on: Record<CapturePart, boolean>,
): Rgb {
  const used = CAPTURE_PARTS.filter((p) => on[p]);
  if (!used.length) return [...WHITE];
  const out: Rgb = [0, 0, 0];
  for (const p of used) for (let i = 0; i < 3; i++) out[i]! += parts[p][i]! / used.length;
  return out;
}

/** The documented final color: average × boost / 50 + 255 × base / 100, at most 459 per channel. */
export function overlayColor(
  avg: Rgb,
  s: Pick<LightOverlaySettings, 'baseBrightness' | 'colorBoost'>,
): Rgb {
  return avg.map((c) =>
    Math.min(OVERLAY_MAX, (c * s.colorBoost) / 50 + (255 * s.baseBrightness) / 100),
  ) as Rgb;
}

/** The multiply tint the model gets: overlay / 255, 0 to 1.8 (Mochi2D 0.14.0's tints reach 2). */
export function overlayTint(overlay: Rgb): Rgb {
  return overlay.map((c) => Math.min(OVERLAY_MAX / 255, Math.max(0, c / 255))) as Rgb;
}

/** Smooths the average over time: a time constant of smoothing / 30 seconds. */
export class LightSmoother {
  private value: Rgb | undefined;
  step(target: Rgb, dtSeconds: number, smoothing: number): Rgb {
    const tau = smoothing / 30;
    if (!this.value || tau <= 0) this.value = [...target];
    else {
      const k = 1 - Math.exp(-Math.max(0, dtSeconds) / tau);
      this.value = this.value.map((v, i) => v + (target[i]! - v) * k) as Rgb;
    }
    return [...this.value];
  }
  reset(): void {
    this.value = undefined;
  }
}

/** What `SceneColorOverlayInfoRequest` answers. */
export interface OverlayState {
  active: boolean;
  isWindowCapture: boolean;
  settings: LightOverlaySettings;
  parts: Record<CapturePart, Rgb>;
  average: Rgb;
  overlay: Rgb;
}

export function overlayInfo(st: OverlayState | undefined, settings: LightOverlaySettings) {
  const round = (c: Rgb) => c.map((v) => Math.round(v)) as Rgb;
  const rgb = (c: Rgb, prefix: string) => {
    const [r, g, b] = round(c);
    return { [`${prefix}R`]: r, [`${prefix}G`]: g, [`${prefix}B`]: b };
  };
  const on = !!st?.active;
  const part = (p: CapturePart) => ({
    active: on ? settings.parts[p] : false,
    ...rgb(on ? st!.parts[p] : WHITE, 'color'),
  });
  return {
    active: on,
    itemsIncluded: settings.items,
    isWindowCapture: on ? st!.isWindowCapture : false,
    baseBrightness: settings.baseBrightness,
    colorBoost: settings.colorBoost,
    smoothing: settings.smoothing,
    leftCapturePart: part('left'),
    middleCapturePart: part('middle'),
    rightCapturePart: part('right'),
    ...rgb(on ? st!.average : WHITE, 'colorAvg'),
    ...rgb(on ? st!.overlay : WHITE, 'colorOverlay'),
  };
}
