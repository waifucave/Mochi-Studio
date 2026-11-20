/**
 * Pure pieces of the plugin API that the page uses: model IDs, the
 * protocol's coordinates against Mochi Studio's transform, hotkey types,
 * and art-mesh matching for tints.
 */
import type { Hotkey } from '../hotkeys';
import { ZOOM_MAX, ZOOM_MIN, type SceneTransform } from '../scene';

/** A model ID: 32 lowercase hexadecimal characters, stable for the same source. */
export function modelIdFor(source: string): string {
  let out = '';
  for (let seed = 0; seed < 4; seed++) {
    let h = (0x811c9dc5 ^ (seed * 0x9e3779b9)) >>> 0;
    for (let i = 0; i < source.length; i++) {
      h ^= source.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out += h.toString(16).padStart(8, '0');
  }
  return out;
}

export const isModelId = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{32}$/i.test(v);

// --- coordinates -----------------------------------------------------

/**
 * The model's placement in the protocol's terms. The window spans −1…1 in x
 * (left to right) and y (bottom to top); Mochi Studio's offset is in canvas
 * heights, y down. `size` −100…100 is Mochi Studio's zoom 0.1…10 on a
 * logarithmic scale (0 is zoom 1). Rotation: both clockwise in degrees;
 * replies give 0…360.
 */
export interface ProtocolPosition {
  positionX: number;
  positionY: number;
  rotation: number;
  size: number;
}

export function zoomToSize(zoom: number): number {
  return Math.max(-100, Math.min(100, 100 * Math.log10(Math.max(1e-6, zoom))));
}
export function sizeToZoom(size: number): number {
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, 10 ** (size / 100)));
}

const round = (v: number, digits = 4): number => Number(v.toFixed(digits));

export function toProtocolPosition(
  t: SceneTransform,
  width: number,
  height: number,
): ProtocolPosition {
  const aspect = height > 0 ? width / height : 1;
  return {
    positionX: round((t.x * 2) / aspect),
    positionY: round(-t.y * 2),
    rotation: round((((t.rotation % 360) + 360) % 360) as number),
    size: round(zoomToSize(t.zoom)),
  };
}

export function fromProtocolPosition(
  p: ProtocolPosition,
  width: number,
  height: number,
): SceneTransform {
  const aspect = height > 0 ? width / height : 1;
  return {
    x: (p.positionX * aspect) / 2,
    y: -p.positionY / 2,
    rotation: p.rotation,
    zoom: sizeToZoom(p.size),
  };
}

/**
 * A MoveModelRequest's target, or the error to send. Omitted values keep
 * their current ones; relative values add to them.
 */
export function moveTarget(
  data: Record<string, unknown>,
  current: ProtocolPosition,
): { target: ProtocolPosition; seconds: number } | { errorID: 301 | 302; message: string } {
  const time = data.timeInSeconds;
  const relative = data.valuesAreRelativeToModel;
  if (typeof time !== 'number' || typeof relative !== 'boolean')
    return {
      errorID: 301,
      message: 'timeInSeconds and valuesAreRelativeToModel are required.',
    };
  if (!Number.isFinite(time) || time < 0 || time > 2)
    return { errorID: 302, message: 'timeInSeconds must be from 0 to 2.' };
  const limits: Record<keyof ProtocolPosition, number> = {
    positionX: 1000,
    positionY: 1000,
    rotation: 360,
    size: 100,
  };
  const target = { ...current };
  for (const k of Object.keys(limits) as Array<keyof ProtocolPosition>) {
    const v = data[k];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > limits[k])
      return { errorID: 302, message: `${k} must be a number from −${limits[k]} to ${limits[k]}.` };
    target[k] = relative ? current[k] + v : v;
  }
  target.positionX = Math.max(-1000, Math.min(1000, target.positionX));
  target.positionY = Math.max(-1000, Math.min(1000, target.positionY));
  target.size = Math.max(-100, Math.min(100, target.size));
  return { target, seconds: time };
}

/** Eases between two transforms (smooth start and end); t from 0 to 1. */
export function easeTransform(a: SceneTransform, b: SceneTransform, t: number): SceneTransform {
  const k = t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
  const mix = (x: number, y: number): number => x + (y - x) * k;
  return {
    x: mix(a.x, b.x),
    y: mix(a.y, b.y),
    zoom: a.zoom * (b.zoom / a.zoom) ** k,
    rotation: mix(a.rotation, b.rotation),
  };
}

// --- hotkeys -----------------------------------------------------------

/** The protocol's hotkey type and a readable description of a Mochi Studio hotkey. */
export function hotkeyType(h: Hotkey): { type: string; description: string } {
  const a = h.action;
  switch (a.type) {
    case 'expression':
      return { type: 'ToggleExpression', description: `Toggles the expression ${a.expression}.` };
    case 'motion':
      return {
        type: 'TriggerAnimation',
        description:
          a.mode === 'hold' ? 'Plays a motion and holds its last frame.' : 'Plays a motion once.',
      };
    case 'clearExpressions':
      return { type: 'RemoveAllExpressions', description: 'Turns all expressions off.' };
    case 'calibrate':
      return { type: 'CalibrateCam', description: 'Calibrates the neutral pose.' };
    case 'item':
      return { type: 'Unset', description: 'Shows or hides an item (Mochi Studio).' };
    case 'itemScene':
      return { type: 'ToggleItemScene', description: 'Turns an item scene on or off.' };
    case 'screenOverlay':
      return {
        type: 'ScreenColorOverlay',
        description: a.overlay.on
          ? 'Turns the light from the screen on with its recorded settings.'
          : 'Turns the light from the screen off.',
      };
  }
}

// --- art meshes and tints -----------------------------------------------

export interface ArtMeshInfo {
  id: string;
  tags: string[];
}

/** Tags from a model's user data: each art mesh's text, split at spaces and line breaks. */
export function tagsFromUserData(
  entries: Array<{ id: string; value: string }>,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const e of entries) {
    const tags = e.value.split(/\s+/).filter(Boolean);
    out.set(e.id, [...(out.get(e.id) ?? []), ...tags]);
  }
  return out;
}

/** The indices of the art meshes a matcher selects; any criterion matches, ignoring case. */
export function matchArtMeshes(
  meshes: readonly ArtMeshInfo[],
  matcher: Record<string, unknown>,
): number[] {
  const strings = (v: unknown): string[] =>
    Array.isArray(v)
      ? v.filter((x): x is string => typeof x === 'string').map((x) => x.toLowerCase())
      : [];
  const numbers = new Set(
    Array.isArray(matcher.artMeshNumber)
      ? matcher.artMeshNumber.filter((x): x is number => Number.isInteger(x))
      : [],
  );
  const nameExact = strings(matcher.nameExact);
  const nameContains = strings(matcher.nameContains);
  const tagExact = strings(matcher.tagExact);
  const tagContains = strings(matcher.tagContains);
  const all = matcher.tintAll === true;
  const out: number[] = [];
  meshes.forEach((m, i) => {
    const id = m.id.toLowerCase();
    const tags = m.tags.map((t) => t.toLowerCase());
    if (
      all ||
      numbers.has(i) ||
      nameExact.includes(id) ||
      nameContains.some((s) => id.includes(s)) ||
      tags.some((t) => tagExact.includes(t)) ||
      tags.some((t) => tagContains.some((s) => t.includes(s)))
    )
      out.push(i);
  });
  return out;
}

export interface Tint {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** A ColorTintRequest's color (0–255 each), or the error to send. */
export function tintColor(
  data: Record<string, unknown>,
): { tint: Tint } | { errorID: 251 | 252; message: string } {
  const c = data.colorTint as Record<string, unknown> | undefined;
  if (
    !c ||
    typeof c !== 'object' ||
    !data.artMeshMatcher ||
    typeof data.artMeshMatcher !== 'object'
  )
    return { errorID: 251, message: 'colorTint and artMeshMatcher are required.' };
  const parts = ['colorR', 'colorG', 'colorB', 'colorA'].map((k) => c[k]);
  if (parts.some((v) => typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 255))
    return {
      errorID: 252,
      message: 'colorR, colorG, colorB and colorA must each be from 0 to 255.',
    };
  const [r, g, b, a] = parts as number[];
  return { tint: { r: r!, g: g!, b: b!, a: a! } };
}

/** "smile.exp3.json" → "smile". */
export function expressionNameFromFile(file: string): string {
  const base = file.split('/').pop() ?? file;
  return base.replace(/\.exp3\.json$/i, '');
}
