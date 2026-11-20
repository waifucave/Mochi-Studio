/**
 * Folders opened with the desktop app's native dialog. The page reads their
 * files from the app's bridge (`/disk/<id>/…`, with its host token); output
 * views read them from disk through the bridge too, so nothing is uploaded.
 */
import { RootedFileSet, fileSetFromZip, type ModelFileSet } from '../core/modelFiles';
import type { PointerSample } from '../core/mouseInput';
import type { WebItemSource } from '../core/webItems';
import type { SpoutConfig, SpoutState } from '../core/spout';
import type { VirtualCameraConfig, VirtualCameraState } from '../core/virtualCamera';

interface OpenedFolder {
  id: string;
  label: string;
  paths: string[];
  /** The folder's path on disk. */
  dir: string;
}

/** A recent model folder (the desktop app keeps the list). */
export interface RecentModel {
  path: string;
  label: string;
  openedAt: number;
  /** ok; missing (moved or deleted); no-model (no .model3.json in it any more). */
  state: 'ok' | 'missing' | 'no-model';
}

/** A zip opened with the app's file dialog: its bytes, read by the page. */
interface OpenedZip {
  zip: Uint8Array;
  label: string;
  dir: string;
}

interface DesktopApi {
  openFolder(): Promise<OpenedFolder | null>;
  openZip(): Promise<OpenedZip | null>;
  recentModels(): Promise<RecentModel[]>;
  openRecent(
    dir: string,
  ): Promise<OpenedFolder | OpenedZip | { error: 'missing' | 'no-model' | 'unknown' }>;
  forgetRecent(dir: string): Promise<RecentModel[]>;
  setGlobalHotkeys(accelerators: string[]): Promise<Record<string, boolean>>;
  onGlobalHotkey(fn: (accelerator: string) => void): void;
  /** The pointer anywhere on the screen (the mouse inputs), about 60 times a second. */
  watchPointer?(fn: (p: PointerSample) => void): void;
  /** Web items: a page rendered off screen per item, its frames as BGRA pixels. */
  startWebItem?(o: { id: string } & WebItemSource): Promise<{ ok?: true; error?: string }>;
  stopWebItem?(id: string): Promise<boolean>;
  onWebItemFrame?(
    fn: (id: string, frame: { width: number; height: number; data: Uint8Array }) => void,
  ): void;
  /** Screens and windows the light overlay can capture. */
  captureSources?(): Promise<Array<{ id: string; name: string; kind: 'screen' | 'window' }>>;
  /** The screens, for the mouse inputs' choice of screen. */
  listScreens?(): Promise<DesktopScreen[]>;
  /** The screen the mouse inputs are measured from (a display id); null: the main one. */
  setPointerScreen?(id: number | null): Promise<boolean>;
  /** Spout2 outputs: starts, changes and stops them; their state. */
  spoutConfigure?(c: SpoutConfig): Promise<SpoutState | null>;
  spoutState?(): Promise<SpoutState | null>;
  /** The virtual camera: starts, changes or stops it; its state. */
  virtualCameraConfigure?(c: VirtualCameraConfig): Promise<VirtualCameraState | null>;
  virtualCameraState?(): Promise<VirtualCameraState | null>;
  /** Errors of the app's main process and its bridge, for the log. */
  onMainError?(fn: (text: string) => void): void;
}

export interface DesktopScreen {
  id: number;
  label: string;
  primary: boolean;
  bounds: { x: number; y: number; width: number; height: number };
}

/** The path on disk each model opened in the desktop app came from (for stable model IDs). */
const sourcePaths = new WeakMap<object, string>();
export function desktopSourcePath(files: object): string | undefined {
  return sourcePaths.get(files);
}
function remember<T extends object>(files: T, path: string): T {
  sourcePaths.set(files, path);
  return files;
}

/** The desktop app's additions, or undefined in a browser. */
export function desktopApi(): DesktopApi | undefined {
  return (window as unknown as { mochiDesktop?: DesktopApi }).mochiDesktop;
}

export class DiskFileSet extends RootedFileSet {
  /**
   * Files read once: loading read each file two or three
   * times over the bridge (for output views, for Mochi2D, for the physics
   * facts). The bytes are the ones output views keep anyway.
   */
  private readonly cache: Map<string, Promise<Uint8Array>>;

  constructor(
    readonly folderId: string,
    label: string,
    paths: string[],
    private bridgeHttp: string,
    private token: string,
  ) {
    const cache = new Map<string, Promise<Uint8Array>>();
    super(label, paths, (p) => {
      let hit = cache.get(p);
      if (!hit) {
        hit = (async () => {
          const r = await fetch(
            `${bridgeHttp}/disk/${folderId}/${p.split('/').map(encodeURIComponent).join('/')}`,
            { headers: { authorization: `Bearer ${token}` } },
          );
          if (!r.ok) throw new Error(`Could not read ${p} (HTTP ${r.status}).`);
          return new Uint8Array(await r.arrayBuffer());
        })();
        cache.set(p, hit);
        // A failed read is tried again next time.
        hit.catch(() => cache.delete(p));
      }
      return hit;
    });
    this.cache = cache;
  }

  /**
   * Writes an expression file (`.exp3.json`, the only kind the bridge
   * accepts) into the model folder; `path` is relative to the model's folder.
   */
  async write(path: string, data: Uint8Array): Promise<void> {
    const full = this.root ? `${this.root}/${path}` : path;
    this.cache.delete(full);
    this.cache.delete(path);
    const r = await fetch(
      `${this.bridgeHttp}/disk/${this.folderId}/${full.split('/').map(encodeURIComponent).join('/')}`,
      {
        method: 'PUT',
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: data as Uint8Array<ArrayBuffer>,
      },
    );
    if (!r.ok)
      throw new Error(
        r.status === 409
          ? `Could not save ${path}: a folder of that name is in the way.`
          : `Could not save ${path} into the model folder (HTTP ${r.status}).`,
      );
  }
}

/** Opens the native folder dialog; undefined when cancelled. */
export async function openDiskFolder(
  bridgeHttp: string,
  token: string,
): Promise<DiskFileSet | undefined> {
  const api = desktopApi();
  if (!api) return undefined;
  const f = await api.openFolder();
  return f
    ? remember(new DiskFileSet(f.id, f.label, f.paths, bridgeHttp, token), f.dir)
    : undefined;
}

/** Why a recent folder cannot be opened, for people. */
export function recentProblem(r: { label: string; path: string }, state: string): string {
  const how = /\.zip$/i.test(r.path) ? 'Open zip…' : 'Open folder…';
  return state === 'no-model'
    ? `“${r.label}” no longer holds a model (no .model3.json file in ${r.path}). Open the model’s folder again with Open folder….`
    : `“${r.label}” is no longer at ${r.path}: it may have been moved, renamed or deleted, or its drive is not connected. Open it from its new place with ${how}, or remove it from the list.`;
}

/** Reopens a recent folder; throws with a message saying what to do when it has moved or gone. */
export async function openRecentFolder(
  r: RecentModel,
  bridgeHttp: string,
  token: string,
): Promise<ModelFileSet> {
  const api = desktopApi();
  if (!api) throw new Error('Recent models are part of the desktop app.');
  const f = await api.openRecent(r.path);
  if ('error' in f) throw new Error(recentProblem(r, f.error));
  if ('zip' in f) return remember(fileSetFromZip(f.label, f.zip), f.dir);
  return remember(new DiskFileSet(f.id, f.label, f.paths, bridgeHttp, token), f.dir);
}

/** Opens a zip with the app's file dialog (remembered as a recent model); undefined when cancelled. */
export async function openDesktopZip(): Promise<ModelFileSet | undefined> {
  const f = await desktopApi()?.openZip();
  return f ? remember(fileSetFromZip(f.label, f.zip), f.dir) : undefined;
}
