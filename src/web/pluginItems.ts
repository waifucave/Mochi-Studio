/**
 * The plugin API's item requests:
 * list, load (also a plugin's own images), unload, move, pin and the
 * animation controls, on Mochi Studio's items.
 *
 * Mochi Studio's mapping, where the other app's items differ:
 *
 * - an instance is a Mochi Studio item, and `instanceID` its id;
 * - `fileName` is the file an item came from (a folder or zip name, or an
 *   image's file name). Loading a name copies an item that came from it, or
 *   loads a plugin's image again (until the page reloads);
 * - items a plugin loads are for this session only, until the person keeps
 *   them in the Items sheet;
 * - order slots −30 to 30 (0 is the model's): positive in front of the
 *   model, negative behind it, higher drawn on top;
 * - `size` 0.32 is an item at its own pixel size (scale 1), as an item
 *   added by hand.
 */
import { IMAGE_ITEM_MARKER, IMAGE_ITEM_TEXTURE, imageItemFiles } from '../core/imageItem';
import { Emitter } from '../core/events';
import { MemoryFileSet } from '../core/modelFiles';
import {
  allocateOrder,
  availableSpots,
  checkCustomImage,
  decodeBase64,
  ease,
  findTriangle,
  MAX_ITEMS,
  ORDER_MAX,
  ORDER_MIN,
  pageToWindow,
  parseItemLoad,
  parseMoveEntry,
  parsePinRequest,
  scaleToSize,
  sizeToScale,
  validCustomFileName,
  windowToPage,
  type FadeMode,
  type SniffedImage,
} from '../core/plugins/items';
import { E, type PluginAnswer, type PluginCaller } from '../core/plugins/protocol';
import { sortItem, sortStateOf, type SortState } from '../core/plugins/itemSort';
import type { ItemEntry } from '../core/items';
import type { MochiRuntime } from './mochiRuntime';
import { toPng } from './stageItems';
import { gifItem, isAnimatedGif } from './animatedItems';
import { animatedMarkerOf } from '../core/animatedItem';
import type { Studio } from './studio';

/** Questions about a plugin's image shown at once at most. */
const MAX_PROMPTS = 6;

export type PluginItemEvents = {
  /** Ask the person whether to show a plugin's image (answer with `answerPrompt`). */
  imagePrompt: {
    id: string;
    pluginName: string;
    url: string;
    width: number;
    height: number;
    seconds: number;
  };
  imagePromptEnd: { id: string };
};

interface ItemState {
  order: number;
  loadedBy?: { pluginId: string; session: string };
  unloadOnEnd: boolean;
  smoothing: number;
  /** Image items: the picture as loaded, to darken from. */
  source?: Blob;
  /** 1: as is; less darkens it (image items: a black overlay; model items: a gray tint). */
  brightness: number;
  /** The orders `ItemSortRequest` set, kept for "Unchanged" (rebuilt from the layout after a reload). */
  sort?: SortState;
}

interface Move {
  from: { x: number; y: number; scale: number; rotation: number };
  to: { x: number; y: number; scale: number; rotation: number };
  start: number;
  ms: number;
  mode: FadeMode;
  userCanStop: boolean;
}

interface CustomImage {
  bytes: Uint8Array;
  info: SniffedImage;
}

const round = (v: number, digits = 4): number => Number(v.toFixed(digits));
const fail = (errorID: number, message: string): PluginAnswer => ({ errorID, message });
const ok = (data: Record<string, unknown>): PluginAnswer => ({ data });

async function sha256(b: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', b as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

const MIME = { PNG: 'image/png', JPG: 'image/jpeg', GIF: 'image/gif' } as const;

export class PluginItems {
  readonly events = new Emitter<PluginItemEvents>();
  private state = new Map<string, ItemState>();
  private custom = new Map<string, CustomImage>();
  /** Images each plugin's person accepted, by SHA-256. */
  private whitelist = new Map<string, Set<string>>();
  private prompts = new Map<string, { session: string; answer: (ok: boolean) => void }>();
  private moves = new Map<string, Move>();
  private fades = new Map<string, { start: number; ms: number }>();

  constructor(
    private studio: Studio,
    private runtime: MochiRuntime,
    private canvas: HTMLCanvasElement,
    private modelId: () => string,
  ) {
    // Grabbing an item stops a move the plugin allowed the person to stop.
    canvas.addEventListener(
      'pointerdown',
      (e) => {
        const id = this.runtime.itemAt(e.clientX, e.clientY);
        if (id && this.moves.get(id)?.userCanStop) {
          this.moves.delete(id);
          this.studio.commitItems();
        }
      },
      { capture: true },
    );
  }

  // --- state ---------------------------------------------------------------------

  /** Every item has a state: items added by hand get the first free slot on their side. */
  private sync(): void {
    const all = this.studio.items;
    for (const id of [...this.state.keys()])
      if (!all.some((i) => i.id === id)) this.state.delete(id);
    // In drawing order (as restored from the item layout), so the slots keep it: in front of
    // the model from the bottom up (1, 2 …), behind it from the top down (−1, −2 …).
    const drawn = this.runtime.itemOrder();
    const at = (id: string): number => drawn.indexOf(id);
    const inFront = (id: string): boolean => this.studio.itemPlacement(id)?.front ?? true;
    const items = [
      ...all.filter((i) => inFront(i.id)).sort((a, b) => at(a.id) - at(b.id)),
      ...all.filter((i) => !inFront(i.id)).sort((a, b) => at(b.id) - at(a.id)),
    ];
    for (const i of items) {
      const front = inFront(i.id);
      const known = this.state.get(i.id);
      // Moved to the other side of the model by hand: a slot on that side.
      if (known && known.order > 0 === front) continue;
      if (known) this.state.delete(i.id);
      const taken = [...this.state.values()].map((s) => s.order);
      const slot = front
        ? availableSpots(taken).find((o) => o > 0)
        : availableSpots(taken)
            .filter((o) => o < 0)
            .at(-1);
      this.state.set(i.id, {
        unloadOnEnd: false,
        smoothing: 0,
        brightness: 1,
        ...known,
        order: slot ?? (front ? ORDER_MAX : ORDER_MIN),
      });
    }
  }

  /** Draws the items by their order (higher on top), each on its side of the model. */
  private restack(): void {
    const sorted = [...this.state].sort((a, b) => a[1].order - b[1].order);
    for (const [id, s] of sorted) this.runtime.placeItem(id, { front: s.order > 0 });
    this.runtime.stackItems(sorted.map(([id]) => id));
  }

  private rect(): { left: number; top: number; width: number; height: number } {
    const r = this.canvas.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width || 1, height: r.height || 1 };
  }

  private modelRotation(): number {
    return this.studio.settings?.transform.rotation ?? 0;
  }

  /** An item's place in the protocol's terms: window coordinates, size, clockwise degrees. */
  private position(id: string): { x: number; y: number; size: number; rotation: number } {
    const p = this.studio.itemPlacement(id);
    if (!p) return { x: 0, y: 0, size: 0, rotation: 0 };
    const page = this.runtime.modelToPage(p.x, p.y);
    const w = page ? pageToWindow(page.x, page.y, this.rect()) : { x: 0, y: 0 };
    return {
      x: w.x,
      y: w.y,
      size: scaleToSize(p.scale),
      rotation: this.modelRotation() - p.rotation,
    };
  }

  /** The placement for a protocol position. */
  private placementFor(
    x: number,
    y: number,
    size: number,
    rotation: number,
  ): { x: number; y: number; scale: number; rotation: number } | undefined {
    const page = windowToPage(x, y, this.rect());
    const m = this.runtime.pageToModel(page.x, page.y);
    if (!m) return undefined;
    return { x: m.x, y: m.y, scale: sizeToScale(size), rotation: this.modelRotation() - rotation };
  }

  private isImage(id: string): boolean {
    return (
      this.state.get(id)?.source !== undefined ||
      /\.(png|jpe?g|gif|webp)$/i.test(this.entry(id)?.file ?? '')
    );
  }

  private entry(id: string): ItemEntry | undefined {
    return this.studio.items.find((i) => i.id === id);
  }

  private typeOf(e: ItemEntry): string {
    const f = (e.file ?? '').toLowerCase();
    if (this.studio.itemAnimation(e.id)) return f.endsWith('.gif') ? 'GIF' : 'AnimationFolder';
    if (!this.isImage(e.id)) return 'Live2D';
    return f.endsWith('.gif') ? 'GIF' : /\.jpe?g$/.test(f) ? 'JPG' : 'PNG';
  }

  // --- ItemListRequest -------------------------------------------------------------

  list(d: Record<string, unknown>): PluginAnswer {
    this.sync();
    const items = this.studio.items;
    const byName =
      typeof d.onlyItemsWithFileName === 'string' && d.onlyItemsWithFileName
        ? d.onlyItemsWithFileName
        : undefined;
    const byId =
      typeof d.onlyItemsWithInstanceID === 'string' && d.onlyItemsWithInstanceID
        ? d.onlyItemsWithInstanceID
        : undefined;
    const pick = items.filter((i) => (!byName || i.file === byName) && (!byId || i.id === byId));
    const files = new Map<string, { type: string; count: number }>();
    for (const i of items) {
      const f = i.file ?? i.label;
      const cur = files.get(f) ?? { type: this.typeOf(i), count: 0 };
      cur.count++;
      files.set(f, cur);
    }
    for (const [name, c] of this.custom)
      if (!files.has(name)) files.set(name, { type: c.info.type, count: 0 });
    return ok({
      itemsInSceneCount: items.length,
      totalItemsAllowedCount: MAX_ITEMS,
      canLoadItemsRightNow: !!this.studio.model,
      availableSpots:
        d.includeAvailableSpots === true
          ? availableSpots([...this.state.values()].map((s) => s.order))
          : [],
      itemInstancesInScene:
        d.includeItemInstancesInScene === true
          ? pick.map((i) => {
              const s = this.state.get(i.id)!;
              const pin = this.runtime.itemPin(i.id);
              return {
                fileName: i.file ?? i.label,
                instanceID: i.id,
                order: s.order,
                type: this.typeOf(i),
                censored: false,
                flipped: this.studio.isItemMirrored(i.id),
                locked: !!i.locked,
                smoothing: s.smoothing,
                framerate: this.studio.itemAnimation(i.id)?.fps ?? 0,
                frameCount: this.studio.itemAnimation(i.id)?.frames ?? (this.isImage(i.id) ? 1 : 0),
                currentFrame: this.studio.itemAnimation(i.id)?.frame ?? 0,
                pinnedToModel: !!pin,
                pinnedModelID: pin ? this.modelId() : '',
                pinnedArtMeshID: pin?.drawable ?? '',
                groupName: '',
                sceneName: '',
                fromWorkshop: false,
              };
            })
          : [],
      availableItemFiles:
        d.includeAvailableItemFiles === true
          ? [...files]
              .filter(([n]) => !byName || n === byName)
              .map(([fileName, f]) => ({ fileName, type: f.type, loadedCount: f.count }))
          : [],
    });
  }

  // --- ItemLoadRequest -------------------------------------------------------------

  async load(caller: PluginCaller, d: Record<string, unknown>): Promise<PluginAnswer> {
    const s = this.studio;
    if (!s.model || !s.settings)
      return fail(E.itemCannotLoad, 'Load a model first: items belong to a model.');
    const r = parseItemLoad(d);
    if ('errorID' in r) return r;
    this.sync();
    if (s.items.length >= MAX_ITEMS) return fail(E.itemSceneFull, `At most ${MAX_ITEMS} items.`);
    const order = allocateOrder(
      r.order,
      [...this.state.values()].map((x) => x.order),
      r.failIfOrderTaken,
    );
    if (typeof order !== 'number') return order;

    // Where the picture or model comes from.
    let image: { blob: Blob; name: string; file: string } | undefined;
    let copy: Array<[string, Uint8Array]> | undefined;
    let fileName = r.fileName;
    if (r.custom) {
      if (!caller.permissions.includes('LoadCustomImagesAsItems'))
        return fail(
          E.noPermission,
          'Ask for the LoadCustomImagesAsItems permission first (PermissionRequest).',
        );
      if (!validCustomFileName(r.fileName))
        return fail(
          E.itemInvalidValues,
          'fileName must be 8 to 32 letters, digits and hyphens, ending in .png, .jpg or .gif.',
        );
      const bytes = decodeBase64(r.custom.base64);
      const info = checkCustomImage(bytes);
      if ('errorID' in info) return info;
      const hash = await sha256(bytes!);
      const known = this.whitelist.get(caller.id)?.has(hash) ?? false;
      if (r.custom.askFirst && !(known && r.custom.skipIfWhitelisted)) {
        if (this.prompts.size >= MAX_PROMPTS)
          return fail(E.itemTooManyPrompts, 'Too many images are waiting for the person already.');
        const yes = await this.ask(caller, bytes!, info, r.custom.askTimer);
        if (!yes) return fail(E.itemImageRejected, 'The person did not want this image shown.');
        let set = this.whitelist.get(caller.id);
        if (!set) this.whitelist.set(caller.id, (set = new Set()));
        set.add(hash);
      }
      // Mochi Studio's own name for the image, which loads it again this session.
      fileName = `plugin-${hash.slice(0, 16)}.${info.type.toLowerCase()}`;
      this.custom.set(fileName, { bytes: bytes!, info });
      image = {
        blob: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: MIME[info.type] }),
        name: r.fileName.replace(/\.\w+$/, ''),
        file: fileName,
      };
    } else if (this.custom.has(r.fileName)) {
      const c = this.custom.get(r.fileName)!;
      image = {
        blob: new Blob([c.bytes as Uint8Array<ArrayBuffer>], { type: MIME[c.info.type] }),
        name: r.fileName.replace(/\.\w+$/, ''),
        file: r.fileName,
      };
    } else {
      const from = s.items.find((i) => (i.file ?? i.label) === r.fileName);
      if (!from)
        return fail(
          E.itemFileNotFound,
          `No item file "${r.fileName}". ItemListRequest lists them.`,
        );
      const files = await s.itemFilesOf(from.id);
      if (!files)
        return fail(E.itemFileNotFound, `The files of "${r.fileName}" are not available.`);
      const tex = files.find(([p]) => p === IMAGE_ITEM_TEXTURE)?.[1];
      if (files.some(([p]) => p === IMAGE_ITEM_MARKER) && tex && !animatedMarkerOf(files))
        image = {
          blob: new Blob([tex as Uint8Array<ArrayBuffer>], { type: 'image/png' }),
          name: from.label,
          file: r.fileName,
        };
      else copy = files;
    }

    const placement = this.placementFor(r.positionX, r.positionY, r.size, r.rotation);
    if (!placement) return fail(E.itemCannotLoad, 'The stage is not ready.');
    let id: string;
    let source: Blob | undefined;
    try {
      const gif =
        image?.blob.type === 'image/gif'
          ? new Uint8Array(await image.blob.arrayBuffer())
          : undefined;
      if (image && gif && isAnimatedGif(gif)) {
        // An animated GIF: an animated item, its frames decoded by Mochi Studio.
        const build = await gifItem(gif, image.name).catch(() => {
          throw new Error('decode');
        });
        id = await s.addItem(new MemoryFileSet(image.name, build.files), {
          file: image.file,
          temporary: true,
          placement: { ...placement, front: order > 0, mirror: r.flipped },
        });
      } else if (image) {
        const { png, width, height } = await toPng(image.blob, false).catch(() => {
          throw new Error('decode');
        });
        source = image.blob;
        id = await s.addItem(
          new MemoryFileSet(
            image.name,
            imageItemFiles(png, width, height, { name: image.name, flipped: false }),
          ),
          {
            file: image.file,
            temporary: true,
            placement: { ...placement, front: order > 0, mirror: r.flipped },
          },
        );
      } else
        id = await s.addItem(new MemoryFileSet(r.fileName, copy!), {
          file: r.fileName,
          temporary: true,
          placement: { ...placement, front: order > 0, mirror: r.flipped },
        });
    } catch (e) {
      return (e as Error).message === 'decode'
        ? fail(E.itemInvalidImage, 'The image could not be decoded.')
        : fail(E.itemCannotLoad, `The item could not be loaded: ${(e as Error).message}`);
    }
    this.state.set(id, {
      order,
      loadedBy: { pluginId: caller.id, session: caller.session },
      unloadOnEnd: r.unloadWhenPluginDisconnects,
      smoothing: r.smoothing,
      ...(source ? { source } : {}),
      brightness: 1,
    });
    if (r.locked) s.setItemLocked(id, true);
    if (r.fadeTime > 0) {
      this.runtime.setItemOpacity(id, 0);
      this.fades.set(id, { start: performance.now(), ms: r.fadeTime * 1000 });
      this.studio.postItemLayout();
    }
    this.restack();
    return ok({ instanceID: id, fileName });
  }

  /** Asks the person about a plugin's image; resolves false on Deny or when the timer runs out. */
  private ask(
    caller: PluginCaller,
    bytes: Uint8Array,
    info: SniffedImage,
    seconds: number,
  ): Promise<boolean> {
    const id = crypto.randomUUID();
    const url = URL.createObjectURL(
      new Blob([bytes as Uint8Array<ArrayBuffer>], { type: MIME[info.type] }),
    );
    return new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const answer = (yes: boolean): void => {
        if (!this.prompts.has(id)) return;
        this.prompts.delete(id);
        if (timer) clearTimeout(timer);
        URL.revokeObjectURL(url);
        this.events.emit('imagePromptEnd', { id });
        resolve(yes);
      };
      this.prompts.set(id, { session: caller.session, answer });
      if (seconds > 0) timer = setTimeout(() => answer(false), seconds * 1000);
      this.events.emit('imagePrompt', {
        id,
        pluginName: caller.name,
        url,
        width: info.width,
        height: info.height,
        seconds: seconds > 0 ? seconds : 0,
      });
    });
  }

  /** The person's answer to an image question. */
  answerPrompt(id: string, yes: boolean): void {
    this.prompts.get(id)?.answer(yes);
  }

  // --- ItemUnloadRequest -----------------------------------------------------------

  unload(caller: PluginCaller, d: Record<string, unknown>): PluginAnswer {
    this.sync();
    const strings = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    const ids = new Set(strings(d.instanceIDs));
    const files = new Set(strings(d.fileNames));
    const others = d.allowUnloadingItemsLoadedByUserOrOtherPlugins !== false;
    const mine = (id: string): boolean => this.state.get(id)?.loadedBy?.pluginId === caller.id;
    const gone = this.studio.items.filter((i) => {
      if (d.unloadAllInScene === true) return true;
      const wanted =
        (d.unloadAllLoadedByThisPlugin === true && mine(i.id)) ||
        ids.has(i.id) ||
        files.has(i.file ?? i.label);
      return wanted && (others || mine(i.id));
    });
    for (const i of gone) this.remove(i.id);
    return ok({
      unloadedItems: gone.map((i) => ({ instanceID: i.id, fileName: i.file ?? i.label })),
    });
  }

  private remove(id: string): void {
    this.moves.delete(id);
    this.fades.delete(id);
    this.state.delete(id);
    this.studio.removeItem(id);
  }

  /** A plugin's session ended: its questions are answered no, and items it asked to remove go. */
  sessionEnded(session: string): void {
    for (const p of [...this.prompts.values()]) if (p.session === session) p.answer(false);
    for (const [id, s] of [...this.state])
      if (s.unloadOnEnd && s.loadedBy?.session === session) this.remove(id);
  }

  // --- ItemMoveRequest -------------------------------------------------------------

  move(d: Record<string, unknown>): PluginAnswer {
    this.sync();
    const list = Array.isArray(d.itemsToMove) ? d.itemsToMove.slice(0, 64) : [];
    // Duplicate IDs: the last entry wins.
    const entries = new Map<string, ReturnType<typeof parseMoveEntry>>();
    for (const e of list) {
      const p = parseMoveEntry(e);
      entries.set(p.id, p);
    }
    const now = performance.now();
    let restacked = false;
    const moved = [...entries.values()].map((e) => {
      const res = (errorID: number): Record<string, unknown> => ({
        itemInstanceID: e.id,
        success: errorID === -1,
        errorID,
      });
      if ('errorID' in e) return res(e.errorID);
      const st = this.state.get(e.id);
      const cur = this.studio.itemPlacement(e.id);
      if (!st || !cur) return res(E.itemMoveNotFound);
      if (e.order !== undefined && e.order !== st.order) {
        const taken = [...this.state].some(([id, s]) => id !== e.id && s.order === e.order);
        if (taken || e.order === 0 || e.order < ORDER_MIN || e.order > ORDER_MAX)
          return res(E.itemMoveOrder);
        st.order = e.order;
        this.restack();
        restacked = true;
      }
      // Every item flips now (Mochi2D 0.7.0's mirror), keeping its place and pin.
      if (e.flip !== undefined && e.flip !== this.studio.isItemMirrored(e.id))
        this.studio.setItemMirror(e.id, e.flip);
      const p = this.position(e.id);
      const target = this.placementFor(
        e.positionX ?? p.x,
        e.positionY ?? p.y,
        e.size ?? p.size,
        e.rotation ?? p.rotation,
      );
      if (!target) return res(E.itemMoveNotFound);
      if (e.positionX === undefined && e.positionY === undefined) {
        target.x = cur.x;
        target.y = cur.y;
      }
      if (
        e.size === undefined &&
        e.positionX === undefined &&
        e.positionY === undefined &&
        e.rotation === undefined
      )
        return res(-1);
      const from = { x: cur.x, y: cur.y, scale: cur.scale, rotation: cur.rotation };
      this.moves.set(e.id, {
        from,
        to: target,
        start: now,
        ms: e.seconds * 1000,
        mode: e.fadeMode,
        userCanStop: e.userCanStop,
      });
      if (e.seconds === 0) this.tick(now);
      return res(-1);
    });
    // A new order is saved (with the item layout) and sent to output views at once.
    if (restacked) this.studio.commitItems();
    return ok({ movedItems: moved });
  }

  /** Regenerates an image item's picture, darkened by a black overlay. */
  private async redraw(id: string, change: { brightness: number }): Promise<void> {
    const st = this.state.get(id);
    const e = this.entry(id);
    if (!st || !e) return;
    if (!st.source) {
      // An image item added by hand: its picture now is where changes start from.
      const tex = (await this.studio.itemFilesOf(id))?.find(([p]) => p === IMAGE_ITEM_TEXTURE)?.[1];
      if (!tex) return;
      st.source = new Blob([tex as Uint8Array<ArrayBuffer>], { type: 'image/png' });
    }
    st.brightness = change.brightness;
    const { png, width, height } = await toPng(st.source, false, 1 - st.brightness);
    await this.studio.replaceItemFiles(
      id,
      imageItemFiles(png, width, height, { name: e.label, flipped: false }),
    );
  }

  /** Each frame: moves and fades (output views follow them as they go). */
  tick(now: number): void {
    const animating = this.moves.size > 0 || this.fades.size > 0;
    for (const [id, m] of this.moves) {
      const t = m.ms > 0 ? (now - m.start) / m.ms : 1;
      const k = ease(m.mode, t);
      const mix = (a: number, b: number): number => a + (b - a) * k;
      this.runtime.placeItem(id, {
        x: mix(m.from.x, m.to.x),
        y: mix(m.from.y, m.to.y),
        scale: Math.max(0.001, mix(m.from.scale, m.to.scale)),
        rotation: mix(m.from.rotation, m.to.rotation),
      });
      if (t >= 1) {
        this.moves.delete(id);
        this.studio.commitItems();
      }
    }
    for (const [id, f] of this.fades) {
      const t = Math.min(1, (now - f.start) / f.ms);
      this.runtime.setItemOpacity(id, t);
      if (t >= 1) {
        this.fades.delete(id);
        this.studio.commitItems();
      }
    }
    if (animating) this.studio.postItemLayout();
  }

  // --- ItemPinRequest --------------------------------------------------------------

  pin(d: Record<string, unknown>): PluginAnswer {
    this.sync();
    const wanted = typeof d.itemInstanceID === 'string' ? d.itemInstanceID : '';
    const e = this.entry(wanted);
    if (!e || !this.state.has(wanted))
      return fail(E.pinItemNotLoaded, 'No item has this instance ID.');
    const r = parsePinRequest(d);
    if ('errorID' in r) return r;
    const reply = (): PluginAnswer =>
      ok({
        isPinned: !!this.runtime.itemPin(r.id),
        itemInstanceID: r.id,
        itemFileName: e.file ?? e.label,
      });
    this.moves.delete(r.id);
    if (!r.pin) {
      this.studio.pinItem(r.id, false);
      return reply();
    }
    if (r.modelID && r.modelID.toLowerCase() !== this.modelId())
      return fail(E.pinModelNotFound, 'modelID is not the loaded model.');
    const meshes = this.runtime.artMeshIds();
    const mesh = r.artMeshID || meshes[Math.floor(Math.random() * meshes.length)];
    const tris = mesh ? this.runtime.meshTriangles(mesh) : undefined;
    if (!mesh || !tris || tris.length < 3)
      return fail(E.pinMeshNotFound, `The model has no art mesh "${r.artMeshID}".`);
    const count = Math.floor(tris.length / 3);
    let triangle: number;
    let weights: number[];
    if (r.vertexType === 'Provided') {
      triangle = findTriangle(tris, r.vertices);
      if (triangle < 0)
        return fail(
          E.pinInvalidPosition,
          'The three vertices are not a triangle of that art mesh.',
        );
      // The weights follow the given vertices; Mochi2D wants them in the triangle's own order.
      const own = [tris[triangle * 3]!, tris[triangle * 3 + 1]!, tris[triangle * 3 + 2]!];
      weights = own.map((v) => r.weights[r.vertices.indexOf(v)]!);
    } else if (r.vertexType === 'Center') {
      triangle = Math.floor(count / 2);
      weights = [1 / 3, 1 / 3, 1 / 3];
    } else {
      triangle = Math.floor(Math.random() * count);
      const a = Math.random();
      const b = Math.random() * (1 - a);
      weights = [a, b, 1 - a - b];
    }
    // Size and angle first: Mochi2D keeps the angle relative to the model's pose when pinning.
    const cur = this.studio.itemPlacement(r.id)!;
    const size =
      r.sizeMode === 'RelativeToCurrentItemSize' ? scaleToSize(cur.scale) + r.size : r.size;
    const rotation =
      r.angleMode === 'RelativeToWorld'
        ? this.modelRotation() - r.angle
        : r.angleMode === 'RelativeToCurrentItemRotation'
          ? cur.rotation - r.angle
          : -r.angle; // relative to the model (or its pinned triangle, which turns with it)
    this.runtime.placeItem(r.id, {
      rotation,
      ...(size > 0 ? { scale: sizeToScale(Math.min(1, size)) } : {}),
    });
    const pinned = this.runtime.pinItemTo(r.id, mesh, triangle, weights);
    this.studio.commitItems();
    if (!pinned) return fail(E.pinMeshNotFound, `The item could not be pinned to "${mesh}".`);
    return reply();
  }

  // --- ItemAnimationControlRequest -------------------------------------------------

  animation(d: Record<string, unknown>): PluginAnswer {
    this.sync();
    const id = typeof d.itemInstanceID === 'string' ? d.itemInstanceID : '';
    if (!this.state.has(id)) return fail(E.itemAnimNotFound, 'No item has this instance ID.');
    const anim = this.studio.itemAnimation(id);
    const image = this.isImage(id) || !!anim;
    const set = (k: string): number | undefined => {
      const v = d[k];
      return typeof v === 'number' && Number.isFinite(v) && v !== -1 ? v : undefined;
    };
    let autoStop: number[] | undefined;
    if (d.setAutoStopFrames === true) {
      const f = d.autoStopFrames;
      if (Array.isArray(f) && f.length > 1024)
        return fail(E.itemAnimTooManyStopFrames, 'At most 1024 auto-stop frames.');
      if (
        !Array.isArray(f) ||
        f.some((x) => !Number.isInteger(x) || x < 0 || (anim && x >= anim.frames))
      )
        return fail(
          E.itemAnimInvalidStopFrames,
          anim
            ? `autoStopFrames must be frame numbers from 0 to ${anim.frames - 1}.`
            : 'autoStopFrames must be frame numbers.',
        );
      autoStop = f as number[];
    }
    const framerate = set('framerate');
    const frame = set('frame');
    const frameControls =
      framerate !== undefined ||
      frame !== undefined ||
      d.setAutoStopFrames === true ||
      d.setAnimationPlayState === true;
    if (frameControls && !anim)
      // Still pictures have no frames (a one-frame GIF included), and model items have none.
      return image
        ? fail(E.itemAnimStill, 'This item is a still image: it has no frames to control.')
        : fail(E.itemAnimUnsupported, 'Model items have no frame controls.');
    if (anim && frameControls) {
      if (frame !== undefined && (!Number.isInteger(frame) || frame < 0 || frame >= anim.frames))
        return fail(
          E.itemAnimInvalidStopFrames,
          `frame must be a frame number from 0 to ${anim.frames - 1}.`,
        );
      this.studio.setItemAnimation(id, {
        // The protocol allows 0.1–120 frames per second; Mochi Studio plays up to 60.
        ...(framerate !== undefined ? { fps: Math.max(0.1, Math.min(120, framerate)) } : {}),
        ...(frame !== undefined ? { frame } : {}),
        ...(autoStop ? { autoStop } : {}),
        ...(d.setAnimationPlayState === true ? { playing: d.animationPlayState === true } : {}),
      });
    }
    const opacity = set('opacity');
    if (opacity !== undefined) {
      this.runtime.setItemOpacity(id, opacity);
      this.fades.delete(id);
      this.studio.commitItems();
    }
    const brightness = set('brightness');
    if (brightness !== undefined) {
      const b = Math.max(0, Math.min(1, brightness));
      // Still pictures: a black overlay drawn into the picture; animated and
      // model items: a gray tint over all their art meshes (Mochi2D 0.7.0).
      if (image && !anim) void this.redraw(id, { brightness: b });
      else {
        this.state.get(id)!.brightness = b;
        this.studio.setItemTint(id, b >= 1 ? undefined : [b, b, b, 1]);
      }
    }
    const now = this.studio.itemAnimation(id);
    return ok({ frame: now?.frame ?? 0, animationPlaying: now?.playing ?? false });
  }

  // --- ItemSortRequest --------------------------------------------------------------

  /**
   * An item between the main model's layers, and a model item split into a
   * front and a back part (Mochi2D 0.10.0; src/core/plugins/itemSort.ts has
   * the reading). The places are drawn at once, saved with the item layout
   * and sent to output views.
   */
  sort(
    d: Record<string, unknown>,
    head: { modelLoaded: boolean; modelID: string; modelName: string },
  ): PluginAnswer {
    this.sync();
    const id = typeof d.itemInstanceID === 'string' ? d.itemInstanceID : '';
    const st = this.state.get(id);
    if (!st) return fail(E.sortItemNotFound, 'No item has this instance ID.');
    const now = this.runtime.itemSort(id);
    const r = sortItem(d, st.sort ?? sortStateOf(now?.layer ?? null, now?.split ?? null), {
      model: !this.isImage(id) && !this.studio.itemAnimation(id),
      itemMeshes: this.runtime.itemArtMeshIds(id),
      mainMeshes: this.runtime.artMeshIds(),
      side: st.order > 0 ? 'front' : 'behind',
    });
    if ('errorID' in r) return fail(r.errorID, r.message);
    st.sort = r.state;
    // Fully in front or behind: a slot on that side.
    if (r.layer === 'front' || r.layer === 'behind') {
      const inFront = r.layer === 'front';
      if (st.order > 0 !== inFront) {
        const taken = [...this.state.values()].map((x) => x.order);
        const slot = inFront
          ? availableSpots(taken).find((o) => o > 0)
          : availableSpots(taken)
              .filter((o) => o < 0)
              .at(-1);
        if (slot !== undefined) st.order = slot;
      }
    }
    this.runtime.setItemSort(id, r.layer, r.split);
    this.restack();
    this.studio.commitItems();
    return ok({
      itemInstanceID: id,
      modelLoaded: head.modelLoaded,
      modelID: head.modelID,
      modelName: head.modelName,
      loadedModelHadRequestedFrontLayer: r.loadedModelHadRequestedFrontLayer,
      loadedModelHadRequestedBackLayer: r.loadedModelHadRequestedBackLayer,
    });
  }

  /** The item's protocol position (for ItemEvent). */
  itemPosition(id: string): { x: number; y: number } {
    const p = this.position(id);
    return { x: round(p.x), y: round(p.y) };
  }
}
