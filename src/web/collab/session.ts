/**
 * A collaboration session in the app (docs/collaboration.md):
 * the signaling server's WebSocket, a WebRTC connection to each other
 * participant (a full mesh), and what goes over it.
 *
 * Each connection has three data channels, agreed in advance (negotiated
 * ids), so neither side waits for the other's:
 *
 * - `ctl` (JSON): the session's rate (from the host), each participant's
 *   model announcement, position, front stamps, expressions and motions;
 * - `state` (binary): parameter frames (src/core/collab/state.ts);
 * - `files` (binary): a shared model's files, in chunks encrypted with the
 *   session key (AES-GCM, the chunk's place as additional data).
 *
 * The newcomer offers to everyone already in; the others answer. Received
 * files stay in memory only, and are dropped when their sender leaves, is
 * removed, or the session ends.
 */
import {
  decryptBytes,
  decryptText,
  encryptBytes,
  encryptText,
  invitationCode,
  invitationLink,
  newDoor,
  passwordProof,
  newKnockKey,
  newSecret,
  sessionKeys,
  type Invitation,
  type SessionKeys,
} from '../../core/collab/crypto';
import {
  COLLAB_VERSION,
  HOST_GRACE_MS,
  signalingUrl,
  type IceServer,
  type Member,
  type ServerMessage,
} from '../../core/collab/protocol';
import {
  checkSharedAnnouncement,
  checkSharedTextures,
  refusalForReceiver,
  refusalForSender,
  sharedRoom,
  type SharedRefusal,
} from '../../core/collab/sharedModel';
import { frontStamp, type FrontStamp, type StagePlace } from '../../core/collab/stage';
import { SHARED_MODEL_LIMITS } from '../../core/archiveLimits';
import {
  decodeParams,
  encodeParams,
  ParamSender,
  RemoteParams,
  type ParamInfo,
} from '../../core/collab/state';

/** Chat: text only, this long at most, and this many kept on screen. */
export const CHAT_MAX_LENGTH = 500;
export const CHAT_KEPT = 200;
/** Messages a person may send in ten seconds (more from someone are dropped). */
export const CHAT_RATE = 5;

export interface ChatMessage {
  from: string;
  name: string;
  text: string;
  /** Milliseconds since the epoch, on this computer. */
  at: number;
  me: boolean;
}

/** The most a shared model (or item) may weigh (src/core/archiveLimits.ts). */
export const MAX_SHARED_BYTES = SHARED_MODEL_LIMITS.maxTotalBytes;
/** Plain bytes per encrypted file chunk. */
const CHUNK = 16 * 1024;
const FILES_KIND = 2;
/** Hold back while this much is waiting in a channel's buffer. */
const HIGH_WATER = 4 * 1024 * 1024;

export type SharingMode = 'video' | 'shared' | 'never';

/** What this app tells the others about its model. */
export interface ModelAnnouncement {
  t: 'model';
  serial: number;
  name: string;
  /** How others get it: its files (shared), or video only (the next round). */
  mode: 'shared' | 'video';
  table: ParamInfo[];
  neverSmoothed: string[];
  files: { path: string; size: number }[];
  bytes: number;
  /** Video only: the avatar picture's size, and how much of it the model's canvas fills. */
  video?: { width: number; height: number; fit: number };
}

/** What the session needs from the app. */
export interface CollabLocal {
  /** This app's model as announced, or undefined without a model. */
  announcement(serial: number): Promise<ModelAnnouncement | undefined>;
  /** The files of the model announced (for sharing). */
  readFile(path: string): Promise<Uint8Array>;
  /** The current parameter values (before physics). */
  params(): Readonly<Record<string, number>>;
  /** Where this app's avatar stands. */
  place(): StagePlace;
}

export interface Participant {
  id: string;
  name: string;
  host: boolean;
  /** This app. */
  me: boolean;
  connection: 'connecting' | 'connected' | 'failed' | 'closed';
  model?: ModelAnnouncement;
  params?: RemoteParams;
  place?: StagePlace;
  /** Shared model files received so far, and the files themselves once complete. */
  received: number;
  files?: Map<string, Uint8Array>;
  /** Shown on this screen (local only). */
  hidden: boolean;
  /**
   * Blocked on this screen (local only): hidden, and their events (expressions,
   * motions, and later pins and chat) are ignored. They aren't told.
   */
  blocked: boolean;
  /** Smoothing delay, ms (local only). */
  delayMs: number;
  error?: string;
  /** They refused the model this app shared with them, and why (for this app's list). */
  refusedYours?: string;
}

export interface Knock {
  id: string;
  name: string;
  /** False when the name did not decrypt: someone without the invitation's secret. */
  valid: boolean;
}

export type SessionStatus = 'connecting' | 'hosting' | 'waiting' | 'member' | 'ended';

export interface SessionOptions {
  server: string;
  nickname: string;
  local: CollabLocal;
  /** Connect through the relay only, so others never see this computer's address. */
  hideAddress: boolean;
  /**
   * A room password on top of the link: the host's, or the one
   * typed to join. It never leaves this app; a knock carries only a proof of
   * it, inside its encrypted nickname.
   */
  password?: string;
}

/** Events for the app: something changed (the UI redraws), and remote events for the avatars. */
export interface SessionListener {
  changed(): void;
  expression?(peer: string, file: string, on: boolean): void;
  motion?(peer: string, file: string): void;
  /** A participant's video track (their video-only avatar). */
  videoTrack?(peer: string, track: MediaStreamTrack): void;
  /** A participant's shared model files are all here (or were dropped: undefined). */
  modelFiles?(peer: string, files: Map<string, Uint8Array> | undefined): void;
}

class PeerLink {
  readonly pc: RTCPeerConnection;
  readonly ctl: RTCDataChannel;
  readonly state: RTCDataChannel;
  readonly files: RTCDataChannel;
  private pending: RTCIceCandidateInit[] = [];
  private session: CollabSession;
  readonly peer: string;
  /** The serial of this app's model that they refused: its files stop going to them. */
  refusedSerial: number | undefined;

  constructor(session: CollabSession, peer: string, config: RTCConfiguration, offer: boolean) {
    this.session = session;
    this.peer = peer;
    this.pc = new RTCPeerConnection(config);
    const ch = (label: string, id: number) => {
      const c = this.pc.createDataChannel(label, { negotiated: true, id, ordered: true });
      c.binaryType = 'arraybuffer';
      return c;
    };
    this.ctl = ch('ctl', 0);
    this.state = ch('state', 1);
    this.files = ch('files', 2);
    this.pc.onicecandidate = (e) =>
      session.signal(peer, { candidate: e.candidate ? e.candidate.toJSON() : null });
    this.pc.onconnectionstatechange = () => session.linkState(peer, this.pc.connectionState);
    // All three channels open, then the session starts talking (one may open after another).
    let open = 0;
    for (const c of [this.ctl, this.state, this.files])
      c.onopen = () => {
        if (++open === 3) session.linkOpen(peer);
      };
    this.ctl.onmessage = (e) => session.ctlMessage(peer, String(e.data));
    this.state.onmessage = (e) => session.stateMessage(peer, new Uint8Array(e.data as ArrayBuffer));
    this.files.onmessage = (e) =>
      void session.fileMessage(peer, new Uint8Array(e.data as ArrayBuffer));
    this.files.bufferedAmountLowThreshold = HIGH_WATER / 2;
    // One video transceiver from the start, both ways: a video-only avatar's track goes in
    // and out with replaceTrack, without negotiating again.
    if (offer) this.video = this.pc.addTransceiver('video', { direction: 'sendrecv' });
    this.pc.ontrack = (e) => session.remoteTrack(peer, e.track);
    if (offer) void this.offer();
  }

  /** The video transceiver (the answerer's comes with the offer). */
  video: RTCRtpTransceiver | undefined;

  setTrack(track: MediaStreamTrack | undefined): void {
    void this.video?.sender.replaceTrack(track ?? null).catch(() => undefined);
  }

  private async offer(): Promise<void> {
    await this.pc.setLocalDescription(await this.pc.createOffer());
    this.session.signal(this.peer, { description: this.pc.localDescription?.toJSON() });
  }

  async signal(data: {
    description?: RTCSessionDescriptionInit;
    candidate?: RTCIceCandidateInit | null;
  }) {
    if (data.description) {
      await this.pc.setRemoteDescription(data.description);
      if (data.description.type === 'offer') {
        this.video = this.pc.getTransceivers().find((t) => t.receiver.track.kind === 'video');
        if (this.video) this.video.direction = 'sendrecv';
        this.session.attachTrack(this);
        await this.pc.setLocalDescription(await this.pc.createAnswer());
        this.session.signal(this.peer, { description: this.pc.localDescription?.toJSON() });
      }
      for (const c of this.pending.splice(0))
        await this.pc.addIceCandidate(c).catch(() => undefined);
    } else if (data.candidate) {
      if (this.pc.remoteDescription)
        await this.pc.addIceCandidate(data.candidate).catch(() => undefined);
      else this.pending.push(data.candidate);
    }
  }

  send(ch: RTCDataChannel, data: string | Uint8Array): boolean {
    if (ch.readyState !== 'open') return false;
    try {
      if (typeof data === 'string') ch.send(data);
      else ch.send(data as Uint8Array<ArrayBuffer>);
      return true;
    } catch {
      return false;
    }
  }

  /** Waits until the files channel has room. */
  async drain(): Promise<void> {
    while (this.files.readyState === 'open' && this.files.bufferedAmount > HIGH_WATER)
      await new Promise<void>((r) => {
        this.files.addEventListener('bufferedamountlow', () => r(), { once: true });
        setTimeout(r, 1000);
      });
  }

  close(): void {
    try {
      this.pc.close();
    } catch {
      // Closed already.
    }
  }
}

export class CollabSession {
  status: SessionStatus = 'connecting';
  /** Why the session ended, or what went wrong, for people. */
  message: string | undefined;
  room = '';
  you = '';
  hostId = '';
  locked = false;
  expires = 0;
  /** Updates a second (the host's choice). */
  rate = 30;
  /** The invitation link (host), once the room is open. */
  link: string | undefined;
  /** The door token of the current invitation (a new link has another). */
  private door = '';
  /** Knocks declined for a wrong password (host). */
  wrongPasswords = 0;

  /** The invitation as a code to read aloud (host). */
  get code(): string | undefined {
    return this.link ? invitationCode(this.room, this.secret, this.door) : undefined;
  }

  /** A new invitation: the old link and code stop working; people already in stay. */
  newLink(): void {
    if (!this.isHost) return;
    this.door = newDoor();
    this.send({ t: 'door', door: this.door });
    this.link = invitationLink(this.o.server, this.room, this.secret, this.door);
    this.knocks.clear();
    this.listener.changed();
  }
  /** Relay servers from the signaling server. */
  iceServers: IceServer[] = [];
  readonly participants = new Map<string, Participant>();
  /** This session's chat, on this computer only; gone when the session ends. */
  chat: ChatMessage[] = [];
  private chatTimes = new Map<string, number[]>();
  readonly knocks = new Map<string, Knock>();
  /** Front stamps of everyone, this app's included. */
  readonly stamps = new Map<string, FrontStamp>();
  hostAway = false;

  private ws: WebSocket;
  private keys: SessionKeys | undefined;
  private secret: string;
  private links = new Map<string, PeerLink>();
  private sender: ParamSender | undefined;
  private announced: ModelAnnouncement | undefined;
  private serial = 0;
  private lastSent = 0;
  /** For coming back after a dropped connection to the server. */
  private token = '';
  private o: SessionOptions;
  private listener: SessionListener;

  private constructor(o: SessionOptions, listener: SessionListener, secret: string, room: string) {
    this.o = o;
    this.listener = listener;
    this.secret = secret;
    this.room = room;
    this.ws = new WebSocket(signalingUrl(o.server, room));
  }

  /** Opens a room and hosts it. */
  static host(o: SessionOptions, l: SessionListener, max: number, rate: number): CollabSession {
    const s = new CollabSession(o, l, newSecret(), newRoomId());
    s.rate = rate;
    s.door = newDoor();
    s.wire(async () => {
      s.keys = await sessionKeys(s.secret, s.room);
      s.send({
        t: 'host',
        v: COLLAB_VERSION,
        room: s.room,
        name: await encryptText(s.keys.names, JSON.stringify({ n: o.nickname })),
        max,
        door: s.door,
      });
    });
    return s;
  }

  /** Knocks on a room from an invitation. */
  static join(o: SessionOptions, l: SessionListener, inv: Invitation): CollabSession {
    // A short code brings no server: the person's own setting.
    const s = new CollabSession({ ...o, server: inv.server ?? o.server }, l, inv.secret, inv.room);
    s.door = inv.door;
    s.wire(async () => {
      s.keys = await sessionKeys(inv.secret, inv.room);
      const p = o.password ? await passwordProof(o.password, inv.room) : undefined;
      s.send({
        t: 'knock',
        v: COLLAB_VERSION,
        room: inv.room,
        name: await encryptText(
          s.keys.names,
          JSON.stringify({ n: o.nickname, ...(p ? { p } : {}) }),
        ),
        key: knockKey(inv.room),
        door: inv.door,
      });
    });
    return s;
  }

  private wire(onOpen: () => Promise<void>): void {
    this.ws.onopen = () => void onOpen();
    this.ws.onmessage = (e) => {
      let m: ServerMessage;
      try {
        m = JSON.parse(String(e.data)) as ServerMessage;
      } catch {
        return;
      }
      void this.serverMessage(m);
    };
    this.ws.onerror = () => {
      if (this.status === 'connecting') this.end('The collaboration server could not be reached.');
    };
    this.ws.onclose = () => {
      if (this.status === 'ended') return;
      // In the room: come back within the grace (the WebRTC links stay up meanwhile).
      if (this.token && (this.status === 'hosting' || this.status === 'member')) this.reconnect();
      else this.end(this.message ?? 'The connection to the server closed.');
    };
  }

  /** Trying to get back to the server, since when (undefined: connected). */
  reconnectingSince: number | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  private reconnect(): void {
    const now = Date.now();
    this.reconnectingSince ??= now;
    if (now - this.reconnectingSince > HOST_GRACE_MS) {
      this.end('The connection to the server was lost.');
      return;
    }
    this.listener.changed();
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(
      () => {
        if (this.status === 'ended') return;
        this.ws = new WebSocket(signalingUrl(this.o.server, this.room));
        this.wire(async () => {
          this.send({ t: 'resume', v: COLLAB_VERSION, room: this.room, token: this.token });
        });
      },
      this.reconnectingSince === now ? 0 : 2000,
    );
  }

  /** For tests: drops the connection to the server, as a network hiccup would. */
  dropServerConnection(): void {
    this.ws.close();
  }

  send(m: unknown): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  get isHost(): boolean {
    return !!this.you && this.you === this.hostId;
  }

  /** A nickname from the server: encrypted JSON, `n` the name and `p` a password proof. */
  private async name(enc: string): Promise<{ name: string; valid: boolean; proof?: string }> {
    const text = this.keys ? await decryptText(this.keys.names, enc) : undefined;
    if (text === undefined) return { name: 'Unknown', valid: false };
    try {
      const j = JSON.parse(text) as { n?: unknown; p?: unknown };
      const name = typeof j.n === 'string' ? j.n.slice(0, 40) : 'Unknown';
      return { name, valid: true, ...(typeof j.p === 'string' ? { proof: j.p } : {}) };
    } catch {
      return { name: text.slice(0, 40), valid: true };
    }
  }

  private async serverMessage(m: ServerMessage): Promise<void> {
    switch (m.t) {
      case 'hosted': {
        this.room = m.room;
        this.you = m.you;
        this.hostId = m.you;
        this.token = m.token;
        this.expires = m.expires;
        this.link = invitationLink(this.o.server, m.room, this.secret, this.door);
        this.status = 'hosting';
        this.addMe();
        this.send({ t: 'relay' });
        break;
      }
      case 'waiting':
        this.you = m.you;
        this.status = 'waiting';
        break;
      case 'knocking': {
        const { name, valid, proof } = await this.name(m.name);
        // A wrong (or missing) password: declined at once; the host sees how often.
        if (
          valid &&
          this.o.password &&
          proof !== (await passwordProof(this.o.password, this.room))
        ) {
          this.wrongPasswords++;
          this.send({ t: 'decline', peer: m.peer });
          break;
        }
        this.knocks.set(m.peer, { id: m.peer, name, valid });
        break;
      }
      case 'knock-gone':
        this.knocks.delete(m.peer);
        break;
      case 'admitted': {
        this.you = m.you;
        this.hostId = m.host;
        this.expires = m.expires;
        this.token = m.token;
        this.status = 'member';
        this.addMe();
        for (const mem of m.members) await this.addParticipant(mem);
        // Relay servers first, then offers to everyone already in.
        this.send({ t: 'relay' });
        this.pendingOffers = m.members.map((x) => x.id);
        break;
      }
      case 'relay': {
        this.iceServers = m.iceServers;
        for (const id of this.pendingOffers.splice(0)) this.connect(id, true);
        break;
      }
      case 'joined':
        await this.addParticipant({ id: m.peer, name: m.name });
        // The newcomer offers; this app answers when its offer comes.
        break;
      case 'signal': {
        const d = m.data as Parameters<PeerLink['signal']>[0];
        if (!this.links.has(m.from) && d?.description?.type === 'offer')
          this.connect(m.from, false);
        await this.links
          .get(m.from)
          ?.signal(d)
          .catch(() => undefined);
        break;
      }
      case 'left':
        this.dropParticipant(m.peer);
        break;
      case 'locked':
        this.locked = m.locked;
        break;
      case 'host-away':
        this.hostAway = true;
        break;
      case 'host-back':
        this.hostAway = false;
        break;
      case 'refused':
        this.end(
          this.reconnectingSince !== undefined
            ? 'The session ended while the connection to the server was down.'
            : (REFUSALS[m.reason] ?? 'The host could not be reached.'),
        );
        return;
      case 'kicked':
        this.end('You were removed from the session.');
        return;
      case 'ended':
        this.end(
          m.reason === 'expired'
            ? 'The session reached its 12 hours.'
            : 'The host ended the session.',
        );
        return;
      case 'resumed':
        this.reconnectingSince = undefined;
        this.locked = m.locked;
        for (const k of m.knocks)
          if (!this.knocks.has(k.id))
            this.knocks.set(k.id, { id: k.id, ...(await this.name(k.name)) });
        // Anyone who left while this app was away.
        for (const id of [...this.participants.keys()])
          if (id !== this.you && !m.members.some((x) => x.id === id)) this.dropParticipant(id);
        break;
      case 'error':
        this.message = m.message;
        break;
    }
    this.listener.changed();
  }

  private pendingOffers: string[] = [];

  private addMe(): void {
    this.participants.set(this.you, {
      id: this.you,
      name: this.o.nickname,
      host: this.isHost,
      me: true,
      connection: 'connected',
      received: 0,
      hidden: false,
      blocked: false,
      delayMs: 50,
    });
    this.stamps.set(this.you, { clock: 0, id: this.you });
  }

  private async addParticipant(m: Member): Promise<void> {
    const { name } = await this.name(m.name);
    this.participants.set(m.id, {
      id: m.id,
      name,
      host: m.id === this.hostId,
      me: false,
      connection: 'connecting',
      received: 0,
      hidden: false,
      blocked: false,
      delayMs: 50,
    });
    if (!this.stamps.has(m.id)) this.stamps.set(m.id, { clock: 0, id: m.id });
  }

  private connect(peer: string, offer: boolean): void {
    if (this.links.has(peer)) return;
    const relayOnly = this.o.hideAddress;
    const hasRelay = this.iceServers.some((s) => s.urls.some((u) => /^turns?:/.test(u)));
    const p = this.participants.get(peer);
    if (relayOnly && !hasRelay && p) {
      p.connection = 'failed';
      p.error =
        'This server offers no relay, so the connection can’t hide your address. Switch off “Hide my address” to connect directly.';
      this.listener.changed();
      return;
    }
    const link = new PeerLink(
      this,
      peer,
      {
        iceServers: this.iceServers as RTCIceServer[],
        iceTransportPolicy: relayOnly ? 'relay' : 'all',
      },
      offer,
    );
    this.links.set(peer, link);
    if (offer) this.attachTrack(link);
  }

  /** The RTCConfiguration used for a participant (for tests and diagnostics). */
  linkConfig(peer: string): RTCConfiguration | undefined {
    return this.links.get(peer)?.pc.getConfiguration();
  }

  private localTrack: MediaStreamTrack | undefined;

  /** This app's video-only avatar (or none), to everyone. */
  setVideoTrack(track: MediaStreamTrack | undefined): void {
    this.localTrack = track;
    for (const l of this.links.values()) l.setTrack(track);
  }

  attachTrack(l: PeerLink): void {
    l.setTrack(this.localTrack);
  }

  remoteTrack(peer: string, track: MediaStreamTrack): void {
    this.listener.videoTrack?.(peer, track);
  }

  signal(peer: string, data: unknown): void {
    this.send({ t: 'signal', to: peer, data });
  }

  linkState(peer: string, s: RTCPeerConnectionState): void {
    const p = this.participants.get(peer);
    if (!p) return;
    p.connection =
      s === 'connected'
        ? 'connected'
        : s === 'failed'
          ? 'failed'
          : s === 'closed'
            ? 'closed'
            : 'connecting';
    if (s === 'failed') p.error = 'The connection failed (a network that needs a relay?).';
    this.listener.changed();
  }

  /** A data connection is up: say who we are and what we show. */
  linkOpen(peer: string): void {
    const l = this.links.get(peer);
    if (!l) return;
    if (this.isHost) l.send(l.ctl, JSON.stringify({ t: 'session', rate: this.rate }));
    l.send(l.ctl, JSON.stringify({ t: 'front', stamp: this.stamps.get(this.you) }));
    void this.announceTo(peer);
  }

  /** This app's model changed (or its sharing): tell everyone. */
  async announce(): Promise<void> {
    this.serial++;
    for (const p of this.participants.values()) p.refusedYours = undefined;
    this.announced = await this.o.local.announcement(this.serial);
    this.sender = this.announced ? new ParamSender(this.announced.table) : undefined;
    for (const peer of this.links.keys()) await this.announceTo(peer);
  }

  private async announceTo(peer: string): Promise<void> {
    const l = this.links.get(peer);
    if (!l) return;
    if (!this.announced && !this.serial) {
      this.serial = 1;
      this.announced = await this.o.local.announcement(this.serial);
      this.sender = this.announced ? new ParamSender(this.announced.table) : undefined;
    }
    const a = this.announced;
    l.send(l.ctl, JSON.stringify(a ?? { t: 'model', serial: this.serial, none: true }));
    l.send(l.ctl, JSON.stringify({ t: 'place', ...this.o.local.place() }));
    if (a && this.sender) {
      // Everything once, then only changes.
      const full = new ParamSender(a.table).frame(this.o.local.params(), true);
      l.send(l.state, encodeParams(Math.round(performance.now()), full));
      if (a.mode === 'shared') void this.sendFiles(l, a);
    }
  }

  private async sendFiles(l: PeerLink, a: ModelAnnouncement): Promise<void> {
    const keys = this.keys;
    if (!keys) return;
    for (let i = 0; i < a.files.length; i++) {
      const data = await this.o.local.readFile(a.files[i]!.path);
      for (let off = 0; off < data.length || (off === 0 && data.length === 0); off += CHUNK) {
        if (
          this.announced?.serial !== a.serial ||
          l.files.readyState !== 'open' ||
          l.refusedSerial === a.serial
        )
          return;
        const plain = data.subarray(off, off + CHUNK);
        const enc = await encryptBytes(keys.files, plain, chunkAad(a.serial, i, off));
        const packet = new Uint8Array(11 + enc.length);
        const d = new DataView(packet.buffer);
        d.setUint8(0, FILES_KIND);
        d.setUint32(1, a.serial);
        d.setUint16(5, i);
        d.setUint32(7, off);
        packet.set(enc, 11);
        await l.drain();
        l.send(l.files, packet);
        if (data.length === 0) break;
      }
    }
  }

  ctlMessage(peer: string, text: string): void {
    const p = this.participants.get(peer);
    if (!p) return;
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (m.t) {
      case 'session':
        if (peer === this.hostId && typeof m.rate === 'number')
          this.rate = Math.max(10, Math.min(60, Math.round(m.rate)));
        break;
      case 'model': {
        this.dropFiles(p);
        if (m.none) {
          p.model = undefined;
          p.params = undefined;
          break;
        }
        const a = m as unknown as ModelAnnouncement;
        if (!Array.isArray(a.table)) break;
        if (!Array.isArray(a.files)) {
          // Not an announcement this app can use; a shared one is refused in so many words.
          const refused = a.mode === 'shared' && checkSharedAnnouncement(a.files, a.bytes);
          if (refused) this.refuse(p, a.serial, refused);
          break;
        }
        p.model = a;
        p.params = new RemoteParams(a.table, a.neverSmoothed ?? []);
        p.error = undefined;
        if (a.mode === 'shared') {
          // Checked before any memory is set aside for the files: the caps, then the room
          // left beside the others' models.
          const refused =
            checkSharedAnnouncement(a.files, a.bytes) ?? sharedRoom(this.heldBytes(), a.bytes);
          if (refused) {
            this.refuse(p, a.serial, refused);
            // Without room, it waits: it comes when another model goes.
            if (refused.problem === 'no-room') this.waiting.set(peer, a.serial);
          } else this.receive(p, a);
        }
        break;
      }
      case 'refused': {
        // They didn't take the model this app shared: say so beside their name.
        const problem =
          m.problem === 'too-large' || m.problem === 'no-room' ? m.problem : 'damaged';
        if (m.serial !== this.announced?.serial || this.announced?.mode !== 'shared') break;
        p.refusedYours = refusalForSender({
          problem,
          detail: typeof m.detail === 'string' ? m.detail.slice(0, 300) : '',
        });
        const l = this.links.get(peer);
        if (l) l.refusedSerial = this.announced.serial;
        break;
      }
      case 'resend': {
        // They have room now: the files go again.
        const a = this.announced;
        const l = this.links.get(peer);
        if (!a || a.mode !== 'shared' || m.serial !== a.serial || !l) break;
        p.refusedYours = undefined;
        l.refusedSerial = undefined;
        void this.sendFiles(l, a);
        break;
      }
      case 'place':
        p.place = {
          x: num(m.x),
          y: num(m.y),
          height: num(m.height, 1),
          rotation: num(m.rotation),
        };
        break;
      case 'front': {
        const s = m.stamp as FrontStamp | undefined;
        if (s && typeof s.clock === 'number' && s.id === peer) this.stamps.set(peer, s);
        break;
      }
      case 'chat':
        if (typeof m.text !== 'string' || p.blocked || !this.chatAllowed(peer)) return;
        this.addChat(peer, p.name, m.text, false);
        break;
      case 'expr':
        if (typeof m.file === 'string' && !p.blocked)
          this.listener.expression?.(peer, m.file, m.on === true);
        return;
      case 'motion':
        if (typeof m.file === 'string' && !p.blocked) this.listener.motion?.(peer, m.file);
        return;
    }
    this.listener.changed();
  }

  stateMessage(peer: string, b: Uint8Array): void {
    const p = this.participants.get(peer);
    const f = decodeParams(b);
    if (!p?.params || !f) return;
    p.params.push(f.time, performance.now(), f.entries);
  }

  private incoming = new Map<string, { serial: number; data: Uint8Array[]; left: number }>();
  /** Bytes set aside for each participant's shared model: arriving, checked or shown. */
  private held = new Map<string, number>();
  /** Shared models refused for want of room, by participant, oldest first: their serial. */
  private waiting = new Map<string, number>();

  /** What this app holds of the others' shared models, all together. */
  heldBytes(): number {
    let n = 0;
    for (const b of this.held.values()) n += b;
    return n;
  }

  /** Sets memory aside for a participant's shared model, and takes its files as they come. */
  private receive(p: Participant, a: ModelAnnouncement): void {
    this.held.set(p.id, a.bytes);
    this.incoming.set(p.id, {
      serial: a.serial,
      data: a.files.map((f) => new Uint8Array(f.size)),
      left: a.bytes,
    });
    if (a.bytes === 0) this.filesDone(p);
  }

  /** Room was freed: models that waited for it come, oldest first, as many as fit. */
  private admitWaiting(): void {
    for (const [peer, serial] of [...this.waiting]) {
      const p = this.participants.get(peer);
      const a = p?.model;
      if (!p || !a || a.mode !== 'shared' || a.serial !== serial) {
        this.waiting.delete(peer);
        continue;
      }
      if (sharedRoom(this.heldBytes(), a.bytes)) continue;
      this.waiting.delete(peer);
      p.error = undefined;
      this.receive(p, a);
      const l = this.links.get(peer);
      l?.send(l.ctl, JSON.stringify({ t: 'resend', serial }));
    }
    this.listener.changed();
  }

  /** A shared model set aside or shown no longer is: its room goes to those waiting. */
  private release(peer: string): void {
    if (this.held.delete(peer)) this.admitWaiting();
  }

  async fileMessage(peer: string, b: Uint8Array): Promise<void> {
    const p = this.participants.get(peer);
    const inc = this.incoming.get(peer);
    if (!p || !inc || !this.keys || b.length < 11 || b[0] !== FILES_KIND) return;
    const d = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const serial = d.getUint32(1);
    const i = d.getUint16(5);
    const off = d.getUint32(7);
    if (serial !== inc.serial || !inc.data[i]) return;
    const plain = await decryptBytes(this.keys.files, b.subarray(11), chunkAad(serial, i, off));
    if (!plain || off + plain.length > inc.data[i]!.length) {
      this.incoming.delete(peer);
      this.refuse(p, serial, {
        problem: 'damaged',
        detail: `A piece of “${p.model?.files[i]?.path ?? 'a file'}” didn’t match.`,
      });
      this.release(peer);
      this.listener.changed();
      return;
    }
    inc.data[i]!.set(plain, off);
    inc.left -= plain.length;
    p.received += plain.length;
    if (inc.left <= 0 && this.incoming.get(peer) === inc) this.filesDone(p);
    else if (p.received % (CHUNK * 64) < CHUNK) this.listener.changed();
  }

  /** Refuses a participant's shared model: tells this app's list, and them. */
  private refuse(p: Participant, serial: number, r: SharedRefusal): void {
    p.error = refusalForReceiver(r);
    const l = this.links.get(p.id);
    l?.send(l.ctl, JSON.stringify({ t: 'refused', serial, problem: r.problem, detail: r.detail }));
  }

  private filesDone(p: Participant): void {
    const inc = this.incoming.get(p.id);
    const a = p.model;
    if (!inc || !a) return;
    this.incoming.delete(p.id);
    const files = new Map(a.files.map((f, i) => [f.path, inc.data[i]!]));
    // The textures' headers, before anything decodes them.
    this.checking.set(p.id, a.serial);
    void checkSharedTextures(files).then((refused) => {
      if (this.checking.get(p.id) !== a.serial || p.model !== a) return;
      this.checking.delete(p.id);
      if (refused) {
        this.refuse(p, a.serial, refused);
        this.release(p.id);
      } else {
        p.files = files;
        this.listener.modelFiles?.(p.id, p.files);
      }
      this.listener.changed();
    });
  }
  /** Shared models whose textures are being checked: their serial. */
  private checking = new Map<string, number>();

  /** Memory only: the files go, and the avatar with them; their room goes to those waiting. */
  private dropFiles(p: Participant): void {
    this.incoming.delete(p.id);
    this.checking.delete(p.id);
    this.waiting.delete(p.id);
    p.received = 0;
    if (p.files) {
      p.files = undefined;
      this.listener.modelFiles?.(p.id, undefined);
    }
    this.release(p.id);
  }

  private dropParticipant(peer: string): void {
    const p = this.participants.get(peer);
    this.links.get(peer)?.close();
    this.links.delete(peer);
    this.stamps.delete(peer);
    this.knocks.delete(peer);
    if (p) this.dropFiles(p);
    this.participants.delete(peer);
  }

  // --- every frame ------------------------------------------------------------

  /** Sends this frame's parameters when the rate says so. */
  tick(now: number): void {
    if (!this.sender || !this.links.size || now - this.lastSent < 1000 / this.rate - 1) return;
    this.lastSent = now;
    const entries = this.sender.frame(this.o.local.params());
    if (!entries.length) return;
    const b = encodeParams(Math.round(now), entries);
    for (const l of this.links.values()) l.send(l.state, b);
  }

  /** Where this app's avatar stands now (sent when it changes). */
  sendPlace(place: StagePlace): void {
    this.broadcastCtl({ t: 'place', ...place });
  }

  expression(file: string, on: boolean): void {
    this.broadcastCtl({ t: 'expr', file, on });
  }

  motion(file: string): void {
    this.broadcastCtl({ t: 'motion', file });
  }

  /** Sends a chat message to everyone; false when it is empty, too long or too many. */
  sendChat(text: string): boolean {
    const t = text.trim();
    if (!t || t.length > CHAT_MAX_LENGTH || !this.chatAllowed(this.you)) return false;
    this.broadcastCtl({ t: 'chat', text: t });
    this.addChat(this.you, this.o.nickname, t, true);
    return true;
  }

  private chatAllowed(peer: string): boolean {
    const now = Date.now();
    const times = (this.chatTimes.get(peer) ?? []).filter((x) => now - x < 10_000);
    if (times.length >= CHAT_RATE) return false;
    times.push(now);
    this.chatTimes.set(peer, times);
    return true;
  }

  private addChat(from: string, name: string, text: string, me: boolean): void {
    const clean = text
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
      .trim()
      .slice(0, CHAT_MAX_LENGTH);
    if (!clean) return;
    this.chat.push({ from, name, text: clean, at: Date.now(), me });
    if (this.chat.length > CHAT_KEPT) this.chat.splice(0, this.chat.length - CHAT_KEPT);
    this.listener.changed();
  }

  /** This app's avatar to the front, for everyone. */
  bringToFront(): void {
    const s = frontStamp(this.stamps, this.you);
    this.stamps.set(this.you, s);
    this.broadcastCtl({ t: 'front', stamp: s });
    this.listener.changed();
  }

  private broadcastCtl(m: unknown): void {
    const text = JSON.stringify(m);
    for (const l of this.links.values()) l.send(l.ctl, text);
  }

  // --- the host's door ----------------------------------------------------------

  admit(peer: string): void {
    this.knocks.delete(peer);
    this.send({ t: 'admit', peer });
    this.listener.changed();
  }

  decline(peer: string): void {
    this.knocks.delete(peer);
    this.send({ t: 'decline', peer });
    this.listener.changed();
  }

  kick(peer: string): void {
    this.send({ t: 'kick', peer });
  }

  lock(locked: boolean): void {
    this.send({ t: 'lock', locked });
  }

  // --- this screen only -------------------------------------------------------

  setHidden(peer: string, hidden: boolean): void {
    const p = this.participants.get(peer);
    if (p) p.hidden = hidden;
    this.listener.changed();
  }

  setBlocked(peer: string, blocked: boolean): void {
    const p = this.participants.get(peer);
    if (!p || p.me) return;
    p.blocked = blocked;
    p.hidden = blocked;
    this.listener.changed();
  }

  setDelay(peer: string, ms: number): void {
    const p = this.participants.get(peer);
    if (p) p.delayMs = Math.max(0, Math.min(1000, Math.round(ms)));
    this.listener.changed();
  }

  leave(): void {
    this.send({ t: 'leave' });
    this.end('You left the session.');
  }

  private end(message: string): void {
    if (this.status === 'ended') return;
    this.status = 'ended';
    this.message = message;
    for (const peer of [...this.participants.keys()]) this.dropParticipant(peer);
    this.knocks.clear();
    // Nothing of the chat is kept after the session.
    this.chat = [];
    this.chatTimes.clear();
    try {
      this.ws.close();
    } catch {
      // Closed already.
    }
    this.listener.changed();
  }
}

const REFUSALS: Record<string, string> = {
  locked: 'The session is locked: the host lets no one else in.',
  full: 'The session is full.',
  'no-room': 'That session has ended, or the link is wrong.',
  'old-link': 'That invitation was replaced by a new one: ask the host for the new link.',
  kicked: 'The host removed you from this session.',
  declined: 'The host didn’t let you in.',
  version: 'This version of Mochi Studio can’t join that session (update both apps).',
  busy: 'The server has too many connections from your address just now. Try again in a minute.',
};

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

const chunkAad = (serial: number, file: number, offset: number) =>
  new TextEncoder().encode(`mochi-collab file ${serial}:${file}:${offset}`);

/** This app's knock key for a room, kept for the tab's life (a kicked key stays refused). */
function knockKey(room: string): string {
  const k = `mochi-collab-key:${room}`;
  try {
    const have = sessionStorage.getItem(k);
    if (have) return have;
    const key = newKnockKey();
    sessionStorage.setItem(k, key);
    return key;
  } catch {
    return newKnockKey();
  }
}

/** A new room id: 72 random bits, hex. */
function newRoomId(): string {
  const b = globalThis.crypto.getRandomValues(new Uint8Array(9));
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}
