import type { PhysicsValues } from './physicsTuning';
import type { Background } from './background';
import type { MotionRef } from './hotkeys';
import type { SceneTransform } from './scene';

/**
 * Messages between the control window and clean output views. The output
 * view runs its own renderer and is driven entirely by these messages, so
 * the transport can be a BroadcastChannel (same browser profile) now, and a
 * WebSocket through the local bridge later (milestone 2).
 */
export type SyncMessage =
  /** Output -> control: a new output view asks for the full state. */
  /** `avatar`: the collaboration's own video avatar page, not a view people see. */
  | { type: 'hello'; viewId: string; avatar?: boolean }
  /** Output -> control: the view is closing. */
  | { type: 'bye'; viewId: string }
  /** Control -> output: the model's files. Sent on hello, and on a load while views are known. */
  | { type: 'model'; key: string; label: string; files: Array<[string, Uint8Array]> }
  /**
   * Control -> output: a model is loaded, but no view is known to this window
   * (none, or only ones open before it loaded). A view without that model
   * answers with hello and gets it; one that has it says it is ready.
   */
  | { type: 'modelAvailable'; key: string }
  /**
   * Control -> output over the bridge: the model's file list only. The view
   * reads each file from the bridge's /files when it needs it, so large
   * models never travel in one message.
   */
  | { type: 'modelRemote'; key: string; label: string; paths: string[]; sizes?: number[] }
  /** Output -> control: how loading goes in a view (shown in the Output tab, not in the view). */
  | {
      type: 'viewStatus';
      viewId: string;
      state: 'loading' | 'ready' | 'failed';
      loaded: number;
      total: number;
      /** Milliseconds since loading started. */
      ms: number;
      message?: string;
    }
  /** Output -> control: an error in the view, for the window's log. */
  | { type: 'viewLog'; viewId: string; text: string }
  | { type: 'unload' }
  /** Control -> output: the look of the stage. */
  | { type: 'stage'; background: Background; transform: SceneTransform; fpsCap: number }
  /**
   * Control -> output: parameter values that changed, and parameters no
   * longer driven (back to their defaults). The mouth arrives already mixed
   * with lip sync: output views never open the microphone.
   */
  | { type: 'params'; values: Record<string, number>; removed?: string[] }
  | { type: 'expression'; name: string; on: boolean; fade?: number }
  | { type: 'motion'; motion: MotionRef; mode: 'once' | 'hold' }
  | { type: 'item'; item: string; visible: boolean }
  /** Control -> output: the items and their files. Sent when the set changes and on hello. */
  | {
      type: 'items';
      items: Array<{
        id: string;
        label: string;
        visible: boolean;
        files: Array<[string, Uint8Array]>;
      }>;
    }
  | { type: 'stopMotions' }
  /** Control -> output: a sound to move the mouth with (output views do not play it). */
  | { type: 'speak'; audio: Uint8Array }
  /** Control -> output: automatic blinking is on while no face is tracked. */
  | { type: 'effects'; eyeBlink: boolean }
  | {
      type: 'itemsRemote';
      items: Array<{
        id: string;
        label: string;
        visible: boolean;
        paths: string[];
        sizes?: number[];
      }>;
    }
  /** Control -> output: where the items are (Mochi2D's item layout). */
  | { type: 'itemLayout'; layout: unknown }
  /** Control -> output: the expressions and items that are on, for late joiners. */
  | { type: 'toggles'; expressions: string[]; items: string[] }
  /** Control -> output: the idle motion (undefined: none). */
  | { type: 'idle'; file?: string | undefined }
  /**
   * Control -> output: idle weights that changed (tracking wins over the idle
   * animation); with `all`, every weight below 1, replacing the view's.
   */
  | { type: 'idleWeights'; weights: Record<string, number>; all?: boolean }
  /** Control -> output: the frame each animated item shows (those that changed, or all on hello). */
  | { type: 'itemFrames'; frames: Array<[string, number]> }
  /**
   * Control -> output: physics strength and wind in Mochi2D's values (the
   * person's settings with any plugin overrides; src/core/physicsTuning.ts).
   */
  | { type: 'physics'; values: PhysicsValues }
  /** Control -> output: a web item's latest frame, as a WebP image in base64. */
  | { type: 'itemTexture'; id: string; webp: string }
  /** Control -> output: the collaborators' avatars this frame, back to front. */
  | {
      type: 'collabFrame';
      avatars: Array<{
        id: string;
        visible: boolean;
        front: boolean;
        params?: Record<string, number>;
        place: { x: number; y: number; height: number; rotation: number };
        /** Placed by hand in the control window: this placement, in the main model's units. */
        placement?: {
          x: number;
          y: number;
          scale: number;
          rotation: number;
          front: boolean;
          mirror?: boolean;
        };
      }>;
    }
  /** Control -> output: the display light overlay's multiply color (RGB 0–1), or null when off. */
  | {
      type: 'light';
      rgb: number[] | null;
      items: boolean;
      /** Art mesh ID → how much of the light it takes, 0 to 1 (missing: 1). */
      strengths?: Record<string, number>;
    }
  /**
   * Control -> output: expressions made or changed in the expression editor
   * (each replaces the model's file of that path, or is a new expression).
   */
  | { type: 'ownExpressions'; list: Array<{ name: string; file: string; json: string }> }
  /** Control -> output: every tint, the main model's by art-mesh ID and one per item (RGBA 0–1). */
  | {
      type: 'tints';
      model: Array<[string, number[]]>;
      items: Array<[string, number[]]>;
    };

export interface SyncTransport {
  post(msg: SyncMessage): void;
  onMessage(fn: (msg: SyncMessage) => void): () => void;
  close(): void;
}

export const SYNC_CHANNEL = 'mochi-studio-output';

/** Posts to every transport and hears from all of them. */
export function combineTransports(...ts: SyncTransport[]): SyncTransport {
  return {
    post: (m) => ts.forEach((t) => t.post(m)),
    onMessage(fn) {
      const offs = ts.map((t) => t.onMessage(fn));
      return () => offs.forEach((o) => o());
    },
    close: () => ts.forEach((t) => t.close()),
  };
}

/** Minimal BroadcastChannel shape, so this module needs no DOM types at run time. */
interface ChannelLike {
  postMessage(m: unknown): void;
  addEventListener(t: 'message', fn: (e: { data: unknown }) => void): void;
  removeEventListener(t: 'message', fn: (e: { data: unknown }) => void): void;
  close(): void;
}

export function channelTransport(channel: ChannelLike): SyncTransport {
  return {
    post: (m) => channel.postMessage(m),
    onMessage(fn) {
      const h = (e: { data: unknown }): void => {
        if (isSyncMessage(e.data)) fn(e.data);
      };
      channel.addEventListener('message', h);
      return () => channel.removeEventListener('message', h);
    },
    close: () => channel.close(),
  };
}

const TYPES = new Set([
  'hello',
  'bye',
  'model',
  'modelAvailable',
  'unload',
  'stage',
  'params',
  'expression',
  'motion',
  'item',
  'items',
  'modelRemote',
  'viewStatus',
  'viewLog',
  'itemsRemote',
  'itemLayout',
  'effects',
  'stopMotions',
  'speak',
  'toggles',
  'idle',
  'idleWeights',
  'tints',
  'itemFrames',
  'itemTexture',
  'collabFrame',
  'physics',
  'light',
  'ownExpressions',
]);
export function isSyncMessage(v: unknown): v is SyncMessage {
  return typeof v === 'object' && v !== null && TYPES.has((v as { type?: string }).type ?? '');
}

/**
 * Coalesces parameter updates: only values that changed by more than
 * `epsilon` since the last send are included, plus the keys that are gone.
 */
export class ParamDiffer {
  private last = new Map<string, number>();
  constructor(private epsilon = 1e-4) {}

  /** The changed values, and the keys that disappeared; undefined when nothing changed. */
  diff(
    values: Record<string, number>,
  ): { values: Record<string, number>; removed: string[] } | undefined {
    const out: Record<string, number> = {};
    let any = false;
    for (const [k, v] of Object.entries(values)) {
      const p = this.last.get(k);
      if (p === undefined || Math.abs(p - v) > this.epsilon) {
        out[k] = v;
        this.last.set(k, v);
        any = true;
      }
    }
    const removed = [...this.last.keys()].filter((k) => !(k in values));
    for (const k of removed) this.last.delete(k);
    return any || removed.length ? { values: out, removed } : undefined;
  }

  reset(): void {
    this.last.clear();
  }
}
