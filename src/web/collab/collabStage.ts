/**
 * Collaboration in the studio: the session's link to this
 * app's model, and the other participants' avatars on this stage.
 *
 * - **Sends:** the parameters every frame (the session keeps to the host's
 *   rate), the position when it changes, expressions and motions as they
 *   happen, and the model's announcement when a model loads or its sharing
 *   changes.
 * - **Shows:** each participant whose shared model has arrived, as an item
 *   ("collab:<id>") placed where they stand on the shared stage, in the
 *   shared order (in front of this app's model or behind it), moving with
 *   their smoothed parameters. Hidden ones are hidden here only.
 */
import { checkSharedTextures, sharedModelTooLarge } from '../../core/collab/sharedModel';
import { COLLAB_ITEM_PREFIX, stageOrder, type StagePlace } from '../../core/collab/stage';
import { imageItemFiles } from '../../core/imageItem';
import { canvasPng, pngContext } from '../canvasPng';
import { MemoryFileSet } from '../../core/modelFiles';
import { AVATAR_FIT, AvatarVideoReceiver, AvatarVideoSender, avatarFrameSize } from './video';
import type { MochiRuntime } from '../mochiRuntime';
import type { Studio } from '../studio';
import {
  CollabSession,
  type CollabLocal,
  type ModelAnnouncement,
  type SessionListener,
} from './session';
import { parseInvitation } from '../../core/collab/crypto';
import { COLLAB_OFF, type CollabApi, type CollabState } from '../../core/collab/api';

/** The model's `.vtube.json` list of parameters never smoothed. */
async function neverSmoothed(studio: Studio): Promise<string[]> {
  const files = studio.model?.files;
  const path = files?.paths().find((p) => /\.vtube\.json$/i.test(p));
  if (!files || !path) return [];
  try {
    const j = JSON.parse(new TextDecoder().decode(await files.read(path))) as {
      ParameterCustomization?: { ParametersExcludedFromVNetSmoothing?: unknown };
    };
    const list = j.ParameterCustomization?.ParametersExcludedFromVNetSmoothing;
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export class CollabStage implements CollabApi {
  session: CollabSession | undefined;
  /** Why sharing fell back to video, for the UI. */
  sharingNote: string | undefined;
  readonly listeners = new Set<() => void>();
  private studio: Studio;
  private runtime: MochiRuntime;
  private lastPlace = '';
  private loaded = new Set<string>();
  private loading = new Map<string, Promise<void>>();
  private expressions = new Set<string>();
  private offs: (() => void)[] = [];
  /** This app's video-only avatar, while it sends one. */
  sender: AvatarVideoSender | undefined;
  /** The avatars on this stage, for output views too. */
  readonly avatars = new Map<
    string,
    {
      kind: 'shared' | 'video';
      label: string;
      files: Array<[string, Uint8Array]>;
      /** How much of the item's canvas the model's canvas fills. */
      fit: number;
      receiver?: AvatarVideoReceiver;
      serial: number;
    }
  >();
  private tracks = new Map<string, MediaStreamTrack>();
  private texturesSent = new Map<string, number>();

  constructor(studio: Studio, runtime: MochiRuntime) {
    this.studio = studio;
    this.runtime = runtime;
  }

  private changed(): void {
    for (const l of this.listeners) l();
  }

  private local(): CollabLocal {
    const studio = this.studio;
    return {
      announcement: async (serial): Promise<ModelAnnouncement | undefined> => {
        const m = studio.model;
        if (!m || !studio.settings) return undefined;
        const files = m.files.paths().sort();
        const data = await Promise.all(files.map((p) => m.files.read(p)));
        const sizes = data.map((d) => d.length);
        const bytes = sizes.reduce((a, b) => a + b, 0);
        let mode: 'shared' | 'video' =
          studio.settings.collabSharing === 'shared' ? 'shared' : 'video';
        this.sharingNote = undefined;
        // Within the caps the others check (src/core/collab/sharedModel.ts).
        const tooLarge =
          mode === 'shared'
            ? (sharedModelTooLarge(files.map((path, i) => ({ path, size: sizes[i]! }))) ??
              (await checkSharedTextures(new Map(files.map((path, i) => [path, data[i]!])))))
            : undefined;
        if (tooLarge) {
          mode = 'video';
          this.sharingNote =
            tooLarge.problem === 'too-large'
              ? `This model is too large to share, so others get it as video only. ${tooLarge.detail}`
              : `This model can’t be shared as files, so others get it as video only. ${tooLarge.detail}`;
        }
        let video: ModelAnnouncement['video'];
        if (mode === 'video') {
          const size = avatarFrameSize(this.runtime.modelAspect() ?? 1, this.place().height);
          this.videoSize = size;
          video = { ...size, fit: AVATAR_FIT };
        } else this.videoSize = undefined;
        this.syncVideoSender();
        return {
          t: 'model',
          serial,
          ...(video ? { video } : {}),
          name: studio.settings.displayName ?? m.manifest.file.replace(/\.model3\.json$/i, ''),
          mode,
          table: studio.parameters.map((p) => ({ id: p.id, min: p.min ?? 0, max: p.max ?? 1 })),
          neverSmoothed: await neverSmoothed(studio),
          files: mode === 'shared' ? files.map((path, i) => ({ path, size: sizes[i]! })) : [],
          bytes: mode === 'shared' ? bytes : 0,
        };
      },
      readFile: (path) => {
        const f = studio.model?.files;
        if (!f) throw new Error('No model.');
        return f.read(path);
      },
      params: () => studio.lastParams,
      place: () => this.place(),
      peers: (count) => {
        this.peerCount = count;
        this.syncVideoSender();
      },
    };
  }

  /** The video avatar's size while this app shares as video, and the connections it has. */
  private videoSize: { width: number; height: number } | undefined;
  private peerCount = 0;

  /**
   * The video avatar's page runs only while this app shares as video and has someone to send
   * it to: it starts with the first connection (while it is being made, so that its first
   * frames come about when the connection opens) and stops when the last one goes.
   */
  private syncVideoSender(): void {
    const size = this.peerCount > 0 ? this.videoSize : undefined;
    if (!size) {
      if (!this.sender) return;
      this.sender.stop();
      this.sender = undefined;
      this.session?.setVideoTrack(undefined);
      return;
    }
    if (this.sender?.size.width === size.width && this.sender.size.height === size.height) return;
    this.sender?.stop();
    this.sender = new AvatarVideoSender(size, new URL('output.html', location.href).href);
    this.session?.setVideoTrack(this.sender.track);
  }

  private place(): StagePlace {
    const t = this.studio.settings?.transform ?? { x: 0, y: 0, zoom: 1, rotation: 0 };
    return {
      x: t.x,
      y: t.y,
      height: this.runtime.stageHeight() ?? 0.95 * t.zoom,
      rotation: t.rotation,
    };
  }

  private listener(): SessionListener {
    return {
      changed: () => this.changed(),
      expression: (peer, file, on) => this.runtime.setItemExpression(itemId(peer), file, on),
      motion: (peer, file) => this.runtime.startItemMotion(itemId(peer), file),
      modelFiles: (peer, files) => void this.modelFiles(peer, files),
      videoTrack: (peer, track) => {
        this.tracks.set(peer, track);
      },
    };
  }

  private options() {
    const c = this.studio.app.collab;
    return {
      server: c.server,
      nickname: c.nickname || 'Guest',
      local: this.local(),
      hideAddress: c.hideAddress,
    };
  }

  private startHosting(password?: string): void {
    this.stop();
    const c = this.studio.app.collab;
    this.session = CollabSession.host(
      { ...this.options(), ...(password ? { password } : {}) },
      this.listener(),
      c.size,
      c.rate,
    );
    this.attach();
  }

  /** Joins from a pasted invitation link or code; false when it is neither. */
  join(link: string, password?: string): boolean {
    const inv = parseInvitation(link);
    if (!inv) return false;
    this.stop();
    this.session = CollabSession.join(
      { ...this.options(), ...(password ? { password } : {}) },
      this.listener(),
      inv,
    );
    this.attach();
    return true;
  }

  private attach(): void {
    const hook = (now: number, draw: boolean) => this.frame(now, draw);
    this.studio.frameHooks.add(hook);
    this.studio.extraViewItems = () =>
      [...this.avatars.entries()].map(([peer, a]) => ({
        id: itemId(peer),
        label: a.label,
        visible: !this.session?.participants.get(peer)?.hidden,
        files: a.files,
      }));
    this.expressions = new Set(this.studio.activeExpressions);
    this.offs = [
      () => this.studio.frameHooks.delete(hook),
      this.studio.events.on('modelLoaded', () => void this.session?.announce()),
      this.studio.events.on('expressionsChanged', ({ expressions }) =>
        this.sendExpressions(expressions),
      ),
      this.runtime.on('motionStarted', ({ file, idle }) => {
        if (!idle) this.session?.motion(file);
      }),
    ];
    this.changed();
  }

  private sendExpressions(names: string[]): void {
    const now = new Set(names);
    const file = (n: string) =>
      this.studio.model?.manifest.expressions.find((e) => e.name === n)?.file ?? n;
    for (const n of now) if (!this.expressions.has(n)) this.session?.expression(file(n), true);
    for (const n of this.expressions) if (!now.has(n)) this.session?.expression(file(n), false);
    this.expressions = now;
  }

  // --- this screen's own arrangement ------------------------------

  /** Participants placed here by hand (dragged, or pinned to this app's model). */
  readonly placedHere = new Map<string, { pinned: boolean }>();
  /** This screen's own order, back to front (undefined: the shared one). */
  localOrder: string[] | undefined;

  /** Back to front, on this screen: the shared order, or this screen's own. */
  order(): string[] {
    const s = this.session;
    if (!s) return [];
    const shared = stageOrder(s.stamps);
    if (!this.localOrder) return shared;
    const mine = this.localOrder.filter((id) => s.stamps.has(id));
    return [...mine, ...shared.filter((id) => !mine.includes(id))];
  }

  /**
   * Places a participant's avatar here by hand: it stays where it is (and
   * where it is dragged) instead of where they stand; `pinned` also pins it
   * to this app's model. Off: back to where they stand.
   */
  placeHere(peer: string, on: boolean, pinned = false): void {
    const id = itemId(peer);
    if (!on) {
      if (this.placedHere.get(peer)?.pinned) this.runtime.pinItem(id, false);
      this.placedHere.delete(peer);
    } else {
      this.placedHere.set(peer, { pinned });
      this.runtime.pinItem(id, pinned);
    }
    this.changed();
  }

  /** This screen's own order (back to front), or the shared one again (undefined). */
  setLocalOrder(order: string[] | undefined): void {
    this.localOrder = order ? [...new Set(order)] : undefined;
    this.changed();
  }

  /** Moves someone one step toward the front (+1) or the back (−1) in this screen's own order. */
  moveInOrder(peer: string, step: 1 | -1): void {
    const o = this.order();
    const i = o.indexOf(peer);
    const j = i + step;
    if (i < 0 || j < 0 || j >= o.length) return;
    [o[i], o[j]] = [o[j]!, o[i]!];
    this.setLocalOrder(o);
  }

  // --- for agents (src/core/collab/api.ts) --------------------------------------

  state(): CollabState {
    const s = this.session;
    if (!s) return COLLAB_OFF;
    return {
      status: s.status,
      ...(s.message ? { message: s.message } : {}),
      isHost: s.isHost,
      locked: s.locked,
      reconnecting: s.reconnectingSince !== undefined,
      people: [...s.participants.values()].map((p) => ({
        id: p.id,
        name: p.name,
        host: p.host,
        me: p.me,
        connection: p.connection,
        model: p.model ? p.model.mode : 'none',
        hidden: p.hidden,
        blocked: p.blocked,
        placedHere: this.placedHere.has(p.id),
        pinnedHere: this.placedHere.get(p.id)?.pinned ?? false,
        ...(p.error ? { error: p.error } : {}),
        ...(p.refusedYours ? { refusedYours: p.refusedYours } : {}),
      })),
      knocks: [...s.knocks.values()].map((k) => ({ ...k })),
      wrongPasswords: s.wrongPasswords,
      order: this.order(),
      localOrder: !!this.localOrder,
      chat: s.chat.slice(-50).map(({ name, text, at, me }) => ({ name, text, at, me })),
    };
  }

  /** Hosts, and resolves with the invitation once the server has the room. */
  async host(o: { password?: string } = {}): Promise<{ invitation: string; code: string }> {
    this.startHosting(o.password);
    const s = this.session!;
    const until = Date.now() + 15_000;
    while (!s.link) {
      if (s.status === 'ended') throw new Error(s.message ?? 'The session could not start.');
      if (Date.now() > until) throw new Error('The collaboration server didn’t answer.');
      await new Promise((r) => setTimeout(r, 50));
    }
    return { invitation: s.link, code: s.code ?? '' };
  }

  newLink(): { invitation: string; code: string } | undefined {
    const s = this.session;
    if (!s?.isHost) return undefined;
    s.newLink();
    return s.link ? { invitation: s.link, code: s.code ?? '' } : undefined;
  }

  chat(text: string): boolean {
    return this.session?.sendChat(text) ?? false;
  }

  admit(peer: string): void {
    this.session?.admit(peer);
  }
  decline(peer: string): void {
    this.session?.decline(peer);
  }
  remove(peer: string): void {
    this.session?.kick(peer);
  }
  lock(locked: boolean): void {
    this.session?.lock(locked);
  }
  hide(peer: string, hidden: boolean): void {
    this.session?.setHidden(peer, hidden);
  }
  block(peer: string, blocked: boolean): void {
    this.session?.setBlocked(peer, blocked);
  }

  /** The model's sharing changed: announce again. */
  reannounce(): void {
    void this.session?.announce();
  }

  leave(): void {
    this.session?.leave();
    this.stop();
  }

  private stop(): void {
    for (const off of this.offs.splice(0)) off();
    for (const peer of [...this.avatars.keys()]) this.removeAvatar(peer);
    for (const id of this.loaded) this.runtime.removeItem(id);
    this.loaded.clear();
    this.tracks.clear();
    this.placedHere.clear();
    this.localOrder = undefined;
    this.sender?.stop();
    this.sender = undefined;
    this.peerCount = 0;
    this.videoSize = undefined;
    this.studio.extraViewItems = undefined;
    this.studio.refreshViewItems();
  }

  private removeAvatar(peer: string): void {
    this.placedHere.delete(peer);
    const a = this.avatars.get(peer);
    a?.receiver?.stop();
    this.lastPicture.get(itemId(peer))?.close();
    this.lastPicture.delete(itemId(peer));
    this.avatars.delete(peer);
    this.runtime.removeItem(itemId(peer));
    this.loaded.delete(itemId(peer));
    this.studio.refreshViewItems();
  }

  /** A video-only participant: an image item of the avatar's size, its texture from their video. */
  private async addVideoAvatar(peer: string): Promise<void> {
    const s = this.session;
    const p = s?.participants.get(peer);
    const track = this.tracks.get(peer);
    const v = p?.model?.video;
    if (!p?.model || !track || !v) return;
    const id = itemId(peer);
    const serial = p.model.serial;
    this.avatars.set(peer, { kind: 'video', label: p.name, files: [], fit: v.fit, serial });
    let files: Array<[string, Uint8Array]>;
    try {
      // A transparent picture of the avatar's size: the texture its video replaces.
      const c = new OffscreenCanvas(v.width, v.height);
      pngContext(c);
      const png = await canvasPng(c);
      files = imageItemFiles(png, v.width, v.height, { name: p.name, flipped: false });
      await this.runtime.addItem(id, new MemoryFileSet(p.name, files), { visible: !p.hidden });
    } catch (e) {
      p.error = `Their avatar could not be shown: ${(e as Error).message}`;
      this.avatars.delete(peer);
      return;
    }
    if (this.avatars.get(peer)?.serial !== serial) return;
    let receiver: AvatarVideoReceiver;
    try {
      receiver = new AvatarVideoReceiver(track, v);
    } catch (e) {
      p.error = `Their video could not be shown: ${(e as Error).message}`;
      this.runtime.removeItem(id);
      this.changed();
      return;
    }
    this.loaded.add(id);
    this.avatars.set(peer, { kind: 'video', label: p.name, files, fit: v.fit, receiver, serial });
    this.studio.refreshViewItems();
    this.changed();
  }

  private async modelFiles(
    peer: string,
    files: Map<string, Uint8Array> | undefined,
  ): Promise<void> {
    const id = itemId(peer);
    await this.loading.get(id);
    if (!files) {
      this.removeAvatar(peer);
      this.changed();
      return;
    }
    const p = this.session?.participants.get(peer);
    const load = this.runtime
      .addItem(id, new MemoryFileSet(p?.model?.name ?? 'Collaborator', files), {
        visible: !p?.hidden,
      })
      .then(() => {
        // Gone while it loaded: remove it again.
        const q = this.session?.participants.get(peer);
        if (!q?.files) this.runtime.removeItem(id);
        else {
          this.loaded.add(id);
          this.avatars.set(peer, {
            kind: 'shared',
            label: q.name,
            files: [...files.entries()],
            fit: 1,
            serial: q.model?.serial ?? 0,
          });
          this.studio.refreshViewItems();
        }
      })
      .catch((e: Error) => {
        if (p) p.error = `Their model could not be shown: ${e.message}`;
      })
      .finally(() => {
        this.loading.delete(id);
        this.changed();
      });
    this.loading.set(id, load);
    await load;
  }

  private frame(now: number, draw = true): void {
    const s = this.session;
    if (!s) return;
    if (s.status === 'ended') {
      this.stop();
      return;
    }
    s.tick(now);
    this.sender?.step(now);
    // Video-only participants: their avatar once their track and announcement are here;
    // gone (or changed) ones away.
    for (const [peer, p] of s.participants) {
      if (p.me) continue;
      const a = this.avatars.get(peer);
      const wantsVideo = p.model?.mode === 'video' && !!p.model.video && this.tracks.has(peer);
      if (a && (a.serial !== p.model?.serial || (a.kind === 'video') !== wantsVideo)) {
        if (a.kind === 'video' || !p.files) this.removeAvatar(peer);
      }
      if (wantsVideo && !this.avatars.has(peer)) void this.addVideoAvatar(peer);
    }
    for (const peer of [...this.avatars.keys()])
      if (!s.participants.has(peer)) this.removeAvatar(peer);
    const place = this.place();
    const key = JSON.stringify(place);
    if (key !== this.lastPlace) {
      this.lastPlace = key;
      s.sendPlace(place);
    }
    // Back to front; those after this app's own model are drawn in front of it.
    const order = this.order();
    const mine = order.indexOf(s.you);
    const front: string[] = [];
    const behind: string[] = [];
    const views: Extract<Parameters<Studio['postToViews']>[0], { type: 'collabFrame' }>['avatars'] =
      [];
    for (const [k, peer] of order.entries()) {
      const p = s.participants.get(peer);
      const id = itemId(peer);
      const a = this.avatars.get(peer);
      if (!p || p.me || !a || !this.loaded.has(id)) continue;
      const visible = !p.hidden;
      this.runtime.setItemVisible(id, visible);
      const at = p.place ?? { x: 0, y: 0, height: 0.95, rotation: 0 };
      // The item's canvas is the avatar picture, which the model's canvas fills to `fit`.
      const place = { ...at, height: at.height / a.fit };
      const params = a.kind === 'shared' && p.params ? p.params.sample(now, p.delayMs) : undefined;
      // Placed here (dragged, or pinned to this app's model): where it is, not where they stand.
      const here = this.placedHere.has(peer);
      const placement = here ? this.runtime.items().find((i) => i.id === id)?.placement : undefined;
      views.push({
        id,
        visible,
        front: k > mine,
        place,
        ...(placement ? { placement: { ...placement, front: k > mine } } : {}),
        ...(params ? { params } : {}),
      });
      if (!visible) continue;
      // One avatar's trouble never stops the others.
      try {
        if (params) this.runtime.setItemParameters(id, params);
        if (a.receiver) void this.videoFrame(id, a.receiver, now, draw).catch(() => undefined);
        if (!here) this.runtime.placeItemOnStage(id, { ...place, front: k > mine });
        else if (placement && placement.front !== k > mine)
          this.runtime.placeItem(id, { front: k > mine });
      } catch (e) {
        p.error = `Their avatar: ${(e as Error).message}`;
      }
      (k > mine ? front : behind).push(id);
    }
    this.runtime.raiseItems([...behind, ...front]);
    if (views.length) this.studio.postToViews({ type: 'collabFrame', avatars: views });
  }

  /** A video avatar's newest picture: its texture here, and (at most 10 a second) in output views. */
  private async videoFrame(
    id: string,
    r: AvatarVideoReceiver,
    now: number,
    draw: boolean,
  ): Promise<void> {
    // Output views get a picture at most 10 times a second, one encoding at a time (a slow
    // encoder must not pile them up).
    const forViews =
      this.studio.hasViews &&
      !this.encoding.has(id) &&
      now - (this.texturesSent.get(id) ?? 0) >= 1000 / VIEW_TEXTURE_FPS;
    // Each picture is a copy from the graphics card, which waits for it. A window that isn't
    // drawn (minimized) makes one only for its output views: with every page of a test on one
    // software GPU, recombining 30 frames a second that nobody saw stalled the pages.
    if (!draw && !forViews) return;
    const bmp = await r.next();
    if (!bmp) return;
    this.runtime.updateItemTexture(id, bmp);
    // The texture has the new picture (or will, at the next frame): the one before is done.
    this.lastPicture.get(id)?.close();
    this.lastPicture.set(id, bmp);
    if (!forViews) return;
    this.texturesSent.set(id, now);
    this.encoding.add(id);
    try {
      await this.postTexture(id, bmp);
    } finally {
      this.encoding.delete(id);
    }
  }

  private encoding = new Set<string>();
  /** Each video avatar's latest picture, closed when the next one replaces it. */
  private lastPicture = new Map<string, ImageBitmap>();

  private async postTexture(id: string, bmp: ImageBitmap): Promise<void> {
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    c.getContext('2d')!.drawImage(bmp, 0, 0);
    const bytes = new Uint8Array(
      await (await c.convertToBlob({ type: 'image/webp', quality: 0.8 })).arrayBuffer(),
    );
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000)
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    this.studio.postToViews({ type: 'itemTexture', id, webp: btoa(bin) });
  }
}

const itemId = (peer: string) => `${COLLAB_ITEM_PREFIX}${peer}`;

/** Video avatars' pictures to output views, a second (as WebP). */
const VIEW_TEXTURE_FPS = 10;
