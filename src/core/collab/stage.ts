/**
 * The shared stage (docs/collaboration.md, section 2): where each
 * participant's avatar stands, and the front-to-back order.
 *
 * - **Positions** travel in canvas heights from the canvas centre (y down),
 *   as Mochi Studio keeps its own model's (SceneTransform), plus the model's
 *   height on screen in canvas heights, so every window shows the same stage
 *   at its own size.
 * - **The order** is shared without a referee: bringing an avatar to the
 *   front stamps it with a Lamport clock (one more than any stamp seen, then
 *   the participant's id), and everyone sorts by the stamps, so all apps agree
 *   once the messages have arrived.
 */

/** Item ids of collaborators' avatars: never saved with the model's items. */
export const COLLAB_ITEM_PREFIX = 'collab:';

export interface StagePlace {
  x: number;
  y: number;
  /** The model's canvas rectangle on screen, in canvas heights. */
  height: number;
  /** Degrees, clockwise on screen. */
  rotation: number;
}

export interface FrontStamp {
  clock: number;
  id: string;
}

export const compareStamps = (a: FrontStamp, b: FrontStamp): number =>
  a.clock - b.clock || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Ids from the back to the front. */
export function stageOrder(stamps: ReadonlyMap<string, FrontStamp>): string[] {
  return [...stamps.entries()].sort((a, b) => compareStamps(a[1], b[1])).map(([id]) => id);
}

/** A stamp that puts `id` in front of every stamp seen. */
export function frontStamp(stamps: ReadonlyMap<string, FrontStamp>, id: string): FrontStamp {
  let clock = 0;
  for (const s of stamps.values()) clock = Math.max(clock, s.clock);
  return { clock: clock + 1, id };
}
