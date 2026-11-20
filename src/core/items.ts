/**
 * Items: further models (props such as an umbrella or a hat) drawn over the
 * main model through Mochi2D's item API. Mochi Studio keeps, per model, the
 * list of items, whether each is shown, and where it is. The item's files
 * are stored locally (IndexedDB), never in the settings file.
 */
import { parseWebItem, type WebItemSource } from './webItems';

/** Where an item is drawn, in the main model's units (y up) and degrees (counterclockwise). */
export interface ItemPlacement {
  x: number;
  y: number;
  /** Main-model canvas pixels per item canvas pixel. */
  scale: number;
  rotation: number;
  /** In front of the main model, or behind it. */
  front: boolean;
  /** Flipped horizontally about its anchor (Mochi2D 0.7.0's `mirror`). */
  mirror?: boolean;
}

export interface ItemEntry {
  /** Mochi Studio's id for the item (also what item hotkeys refer to). */
  id: string;
  /** A name for the UI: the folder or zip name, editable. */
  label: string;
  visible: boolean;
  /** The last known placement; undefined until the item has been placed once. */
  placement?: ItemPlacement;
  pinned: boolean;
  /** Locked on the stage (double-click): it cannot be dragged. */
  locked?: boolean;
  /** The file it came from (folder or zip name, or an image's file name), for plugins' `fileName`. */
  file?: string;
  /**
   * Loaded by a plugin for this session only: its files are not stored, and
   * it is gone after a reload unless the person keeps it.
   */
  temporary?: boolean;
  /** Animated items: the frame rate (0–60; 0 holds the frame) and whether it plays. */
  animation?: { fps: number; playing: boolean };
  /** A web item's page (src/core/webItems.ts). */
  web?: WebItemSource;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function parsePlacement(v: unknown): ItemPlacement | undefined {
  if (!isObj(v) || !fin(v.x) || !fin(v.y)) return undefined;
  return {
    x: Math.max(-1e5, Math.min(1e5, v.x)),
    y: Math.max(-1e5, Math.min(1e5, v.y)),
    scale: fin(v.scale) && v.scale > 0 ? Math.min(100, v.scale) : 1,
    rotation: fin(v.rotation) ? v.rotation : 0,
    front: v.front !== false,
    ...(v.mirror === true ? { mirror: true } : {}),
  };
}

/** Validates untrusted item entries; drops broken ones and duplicate ids. */
export function parseItems(v: unknown): ItemEntry[] {
  if (!Array.isArray(v)) return [];
  const out: ItemEntry[] = [];
  const seen = new Set<string>();
  for (const x of v) {
    if (!isObj(x) || typeof x.id !== 'string' || !x.id || seen.has(x.id)) continue;
    if (x.temporary === true) continue;
    seen.add(x.id);
    out.push({
      id: x.id.slice(0, 50),
      label: typeof x.label === 'string' ? x.label.slice(0, 200) : x.id,
      visible: x.visible !== false,
      placement: parsePlacement(x.placement),
      pinned: x.pinned === true,
      ...(x.locked === true ? { locked: true } : {}),
      ...(typeof x.file === 'string' && x.file ? { file: x.file.slice(0, 200) } : {}),
      ...(isObj(x.animation) && fin(x.animation.fps)
        ? {
            animation: {
              fps: Math.max(0, Math.min(60, x.animation.fps)),
              playing: x.animation.playing !== false,
            },
          }
        : {}),
      ...(() => {
        const web = parseWebItem(x.web);
        return web ? { web } : {};
      })(),
    });
  }
  return out.slice(0, 32);
}

/**
 * Mochi2D's item layout (`view.exportItemLayout()`) is kept as an opaque
 * object so pins survive a reload. Only its outer shape is checked here;
 * Mochi2D validates the rest when it is applied.
 */
export function parseItemLayout(v: unknown): unknown {
  if (!isObj(v) || typeof v.format !== 'string' || !Array.isArray(v.items)) return undefined;
  return JSON.parse(JSON.stringify(v)) as unknown;
}

/** A short random id for a new item. */
export function newItemId(existing: Iterable<string>): string {
  const taken = new Set(existing);
  for (;;) {
    const id = `item-${Math.random().toString(36).slice(2, 8)}`;
    if (!taken.has(id)) return id;
  }
}

/**
 * Item layouts saved before Mochi2D 0.4.0 have no id per entry; Mochi Studio
 * stored its item ids alongside (`mochiStudioIds`, in the same order). This
 * gives those entries their ids, so Mochi2D matches them by id.
 */
export function layoutWithIds<L extends { items: { id?: string }[] }>(layout: L): L {
  const ids = (layout as { mochiStudioIds?: unknown }).mochiStudioIds;
  if (!Array.isArray(ids) || !Array.isArray(layout.items)) return layout;
  return {
    ...layout,
    items: layout.items.map((e, i) =>
      e.id === undefined && typeof ids[i] === 'string' ? { ...e, id: ids[i] as string } : e,
    ),
  };
}
