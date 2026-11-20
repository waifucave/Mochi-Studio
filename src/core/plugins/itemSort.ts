/**
 * `ItemSortRequest`: an item between the main
 * model's layers, and a model item split into a front and a back part, on
 * Mochi2D 0.10.0's `item.layer` and `item.split`.
 *
 * Mochi Studio's reading, where the protocol leaves it open:
 *
 * - an art-mesh order puts the part just in front of that art mesh of the
 *   main model (`{ above: id }`);
 * - `FullyInFront` and `FullyInBack` put it in front of or behind the whole
 *   model, the item's side;
 * - a part that is not inserted (`frontOn`, `backOn` false) is drawn with
 *   the rest of the item: an item without its front part inserted is drawn
 *   on its side of the model, and a model item without its back part
 *   inserted is drawn whole;
 * - `setSplitPoint: UseSpecialID` names no split point (the item is drawn
 *   whole), since the protocol has no special split IDs;
 * - the orders and the split point are kept, so a later request can leave
 *   them `Unchanged` and turn a part on or off;
 * - `loadedModelHadRequested…Layer` is true when the request set that order
 *   and the loaded main model has it (an art mesh it has, or a special
 *   ID). An art mesh the model lacks is still kept: another model may have
 *   it, and the part is then drawn on the item's side until one does.
 */
import { E } from './protocol';

/** A place in the main model's render order: just above or below one of its art meshes. */
export type MeshPlace = { above: string } | { below: string };
/** Where an item, or its back part, is drawn: in front of or behind the whole model, or at a mesh place. */
export type ItemDepth = 'front' | 'behind' | MeshPlace;

/** A model item drawn in two parts: its art mesh `mesh` and those after it at the item's place, the rest at `back`. */
export interface ItemSplitPlace {
  mesh: string;
  back: ItemDepth;
}

/** The orders a plugin set for an item, kept for "Unchanged". */
export interface SortState {
  /** Where the front part (the whole item unless it is split) goes, once inserted. */
  front?: ItemDepth;
  /** Where the back part goes (model items). */
  back?: ItemDepth;
  /** The item's own art mesh where it splits (model items). */
  splitAt?: string;
}

export interface SortContext {
  /** A model item, which has a back part and a split point (image items do not). */
  model: boolean;
  /** The item's own art meshes. */
  itemMeshes: readonly string[];
  /** The loaded main model's art meshes. */
  mainMeshes: readonly string[];
  /** The item's side of the model now, from its order. */
  side: 'front' | 'behind';
}

export type SortResult =
  | { errorID: number; message: string }
  | {
      state: SortState;
      /** Where the item (its front part) is drawn now. */
      layer: ItemDepth;
      /** The split, or null to draw the item whole. */
      split: ItemSplitPlace | null;
      loadedModelHadRequestedFrontLayer: boolean;
      loadedModelHadRequestedBackLayer: boolean;
    };

const SET_TYPES = ['Unchanged', 'UseArtMeshID', 'UseSpecialID'] as const;
type SetType = (typeof SET_TYPES)[number];

/** A set type, Unchanged when absent; undefined when invalid. */
function setType(v: unknown): SetType | undefined {
  if (v === undefined || v === null || v === '') return 'Unchanged';
  return SET_TYPES.find((t) => t === v);
}

export const isMeshPlace = (d: ItemDepth | undefined): d is MeshPlace =>
  typeof d === 'object' && d !== null;
export const placeMesh = (d: ItemDepth): string | undefined =>
  isMeshPlace(d) ? ('above' in d ? d.above : d.below) : undefined;

/** Applies an `ItemSortRequest` to an item's kept orders: the new state and where it is drawn, or an error. */
export function sortItem(
  d: Record<string, unknown>,
  prev: SortState,
  ctx: SortContext,
): SortResult {
  const front = setType(d.setFrontOrder);
  // Normal items ignore the back part and the split point, and their fields.
  const back = ctx.model ? setType(d.setBackOrder) : 'Unchanged';
  const split = ctx.model ? setType(d.setSplitPoint) : 'Unchanged';
  if (!front || !back || !split)
    return {
      errorID: E.sortInvalidSetType,
      message:
        'setSplitPoint, setFrontOrder and setBackOrder must be Unchanged, UseArtMeshID or UseSpecialID.',
    };
  const fo = d.withinModelOrderFront;
  const bo = d.withinModelOrderBack;
  if (
    (front === 'UseSpecialID' && fo !== 'FullyInFront' && fo !== 'FullyInBack') ||
    (front === 'UseArtMeshID' && (typeof fo !== 'string' || !fo))
  )
    return {
      errorID: E.sortInvalidFrontOrder,
      message: 'withinModelOrderFront must be an art-mesh ID, FullyInFront or FullyInBack.',
    };
  if (
    (back === 'UseSpecialID' && bo !== 'FullyInBack') ||
    (back === 'UseArtMeshID' && (typeof bo !== 'string' || !bo))
  )
    return {
      errorID: E.sortInvalidBackOrder,
      message: 'withinModelOrderBack must be an art-mesh ID or FullyInBack.',
    };
  if (
    split === 'UseArtMeshID' &&
    (typeof d.splitAt !== 'string' || !ctx.itemMeshes.includes(d.splitAt))
  )
    return {
      errorID: E.sortSplitNotFound,
      message: `The item has no art mesh "${String(d.splitAt)}".`,
    };

  const state: SortState = { ...prev };
  if (front === 'UseArtMeshID') state.front = { above: fo as string };
  else if (front === 'UseSpecialID') state.front = fo === 'FullyInFront' ? 'front' : 'behind';
  if (back === 'UseArtMeshID') state.back = { above: bo as string };
  else if (back === 'UseSpecialID') state.back = 'behind';
  if (split === 'UseArtMeshID') state.splitAt = d.splitAt as string;
  else if (split === 'UseSpecialID') delete state.splitAt;
  if (!ctx.model) {
    delete state.back;
    delete state.splitAt;
  }

  const has = (o: unknown): boolean =>
    o === 'FullyInFront' || o === 'FullyInBack' || ctx.mainMeshes.includes(String(o));
  return {
    state,
    layer: d.frontOn === true && state.front ? state.front : ctx.side,
    split:
      ctx.model && d.backOn === true && state.splitAt
        ? { mesh: state.splitAt, back: state.back ?? 'behind' }
        : null,
    loadedModelHadRequestedFrontLayer: front !== 'Unchanged' && has(fo),
    loadedModelHadRequestedBackLayer: back !== 'Unchanged' && has(bo),
  };
}

/** The kept orders of an item drawn at a place or split (after a reload, from the item layout). */
export function sortStateOf(
  layer: MeshPlace | null,
  split: { mesh: string; back: ItemDepth } | null,
): SortState {
  return {
    ...(layer ? { front: layer } : {}),
    ...(split ? { back: split.back, splitAt: split.mesh } : {}),
  };
}
