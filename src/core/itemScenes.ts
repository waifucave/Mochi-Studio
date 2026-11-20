/**
 * Item scenes: a named set of the
 * model's items, as they were placed when the scene was made. Turning a
 * scene on shows its items in their places; turning it off hides them. A
 * scene may belong to a group: turning one scene of a group on turns the
 * group's others off. A «Toggle Item Scene» hotkey does it, with a fade.
 */
import type { ItemPlacement } from './items';

export interface ItemSceneItem {
  id: string;
  /** Where the item was when the scene was made (it goes back there when the scene turns on). */
  placement?: ItemPlacement;
}

export interface ItemScene {
  id: string;
  name: string;
  /** Turning one scene of a group on turns the group's others off ('' or none: no group). */
  group?: string;
  items: ItemSceneItem[];
}

/** The longest fade, and the longest a scene stays on by itself (an hour). */
export const MAX_SCENE_FADE_S = 10;
export const MAX_SCENE_SECONDS = 3600;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function parsePlacement(v: unknown): ItemPlacement | undefined {
  if (!isObj(v) || !fin(v.x) || !fin(v.y) || !fin(v.scale) || !fin(v.rotation)) return undefined;
  return {
    x: v.x,
    y: v.y,
    scale: Math.max(0.001, Math.min(1000, v.scale)),
    rotation: v.rotation,
    front: v.front !== false,
    ...(v.mirror === true ? { mirror: true } : {}),
  };
}

/** Validates the stored scenes (invalid ones dropped). */
export function parseItemScenes(raw: unknown): ItemScene[] {
  if (!Array.isArray(raw)) return [];
  const out: ItemScene[] = [];
  const ids = new Set<string>();
  for (const v of raw.slice(0, 200)) {
    if (!isObj(v) || typeof v.id !== 'string' || !v.id || ids.has(v.id)) continue;
    if (!Array.isArray(v.items)) continue;
    ids.add(v.id);
    const items: ItemSceneItem[] = [];
    for (const i of v.items.slice(0, 500)) {
      if (!isObj(i) || typeof i.id !== 'string' || !i.id) continue;
      const placement = parsePlacement(i.placement);
      items.push({ id: i.id.slice(0, 100), ...(placement ? { placement } : {}) });
    }
    const group = typeof v.group === 'string' ? v.group.trim().slice(0, 64) : '';
    out.push({
      id: v.id.slice(0, 50),
      name: typeof v.name === 'string' && v.name.trim() ? v.name.trim().slice(0, 100) : 'Scene',
      ...(group ? { group } : {}),
      items,
    });
  }
  return out;
}

export function newSceneId(taken: Iterable<string>): string {
  const t = new Set(taken);
  for (let i = 1; ; i++) if (!t.has(`scene${i}`)) return `scene${i}`;
}

/** What turning a scene on or off does: the scenes on afterwards, and the items to show and hide. */
export interface SceneChange {
  active: Set<string>;
  show: ItemSceneItem[];
  hide: string[];
}

/**
 * Turns a scene on or off. On: its items show, and the other scenes of its
 * group turn off (their items hide, unless a scene still on holds them).
 * Off: its items hide, unless another scene still on holds them.
 */
export function toggleScene(
  scenes: readonly ItemScene[],
  active: ReadonlySet<string>,
  id: string,
  on: boolean,
): SceneChange {
  const scene = scenes.find((s) => s.id === id);
  const now = new Set([...active].filter((a) => scenes.some((s) => s.id === a)));
  if (!scene) return { active: now, show: [], hide: [] };
  const off: ItemScene[] = [];
  if (on) {
    now.add(id);
    if (scene.group)
      for (const s of scenes)
        if (s.id !== id && s.group === scene.group && now.delete(s.id)) off.push(s);
  } else if (now.delete(id)) off.push(scene);
  const held = new Set(
    scenes.filter((s) => now.has(s.id)).flatMap((s) => s.items.map((i) => i.id)),
  );
  const hide = [
    ...new Set(off.flatMap((s) => s.items.map((i) => i.id)).filter((i) => !held.has(i))),
  ];
  return { active: now, show: on ? scene.items : [], hide };
}
