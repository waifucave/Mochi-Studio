import { sourceFromZip } from 'mochi2d/headless';

const utf8 = new TextDecoder();
const strFromU8 = (d: Uint8Array): string => utf8.decode(d);

/**
 * A model's files, wherever they come from. Paths are relative to the
 * folder that holds the `.model3.json`, with forward slashes.
 */
export interface ModelFileSet {
  /** A short description of the source (folder name, zip name or URL). */
  readonly label: string;
  /** All known paths. A URL source only knows the files the manifest references. */
  paths(): string[];
  has(path: string): boolean;
  read(path: string): Promise<Uint8Array>;
}

export class ModelLoadError extends Error {}

/** When the chosen folder or zip holds no model settings file. */
export const NO_MANIFEST =
  'No .model3.json file found. Choose the model’s own folder (the one that holds the .model3.json file, next to the .moc3 file and the textures), or a zip of it.';

export function normalizePath(p: string): string {
  const parts: string[] = [];
  for (const seg of p.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

/** Picks the `.model3.json` nearest to the root (ties: alphabetical). */
export function findManifestPath(paths: readonly string[]): string | undefined {
  return paths
    .filter((p) => p.toLowerCase().endsWith('.model3.json'))
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))[0];
}

/**
 * A file set re-rooted at the manifest's folder, over any reader. Paths
 * resolve exactly first, then case-insensitively.
 */
export class RootedFileSet implements ModelFileSet {
  private files = new Map<string, string>();
  private lower = new Map<string, string>();
  /** The folder of the manifest, inside the given paths ('' at the top). */
  readonly root: string;

  constructor(
    readonly label: string,
    paths: Iterable<string>,
    private reader: (originalPath: string) => Promise<Uint8Array>,
  ) {
    const all = [...paths].map((p) => [normalizePath(p), p] as const);
    const manifest = findManifestPath(all.map(([p]) => p));
    if (!manifest) throw new ModelLoadError(NO_MANIFEST);
    const root = dirname(manifest);
    this.root = root;
    for (const [p, original] of all) {
      if (root && !p.startsWith(root + '/')) continue;
      const rel = root ? p.slice(root.length + 1) : p;
      this.files.set(rel, original);
      this.lower.set(rel.toLowerCase(), rel);
    }
  }

  private resolve(path: string): string | undefined {
    const n = normalizePath(path);
    return this.files.has(n) ? n : this.lower.get(n.toLowerCase());
  }

  paths(): string[] {
    return [...this.files.keys()];
  }
  has(path: string): boolean {
    return this.resolve(path) !== undefined;
  }
  async read(path: string): Promise<Uint8Array> {
    const r = this.resolve(path);
    if (r === undefined) throw new ModelLoadError(`Missing file: ${path}`);
    return this.reader(this.files.get(r)!);
  }
}

/** An in-memory file set, re-rooted at the manifest's folder. */
export class MemoryFileSet extends RootedFileSet {
  constructor(label: string, entries: Iterable<[string, Uint8Array]>) {
    const map = new Map(entries);
    super(label, map.keys(), async (p) => map.get(p)!);
  }
}

/**
 * Files from a zip archive, read with Mochi2D's zip reader. It decompresses
 * entries when they are read and decodes legacy file-name encodings (GBK,
 * Shift_JIS, EUC-KR, Big5, Info-ZIP Unicode paths).
 */
export function fileSetFromZip(label: string, data: Uint8Array): ModelFileSet {
  let source: ReturnType<typeof sourceFromZip>;
  try {
    source = sourceFromZip(label, data);
  } catch (e) {
    throw new ModelLoadError(`Not a readable zip file: ${(e as Error).message}`);
  }
  const paths = (source.list() ?? []).filter((p) => !p.endsWith('/') && !p.startsWith('__MACOSX/'));
  return new RootedFileSet(label, paths, (p) => source.read(p));
}

/** Minimal shape of a browser `File` from a folder picker or drag and drop. */
export interface FileLike {
  name: string;
  webkitRelativePath?: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** Files from a folder picker (`<input webkitdirectory>`) or a dropped folder. */
export async function fileSetFromFiles(
  label: string,
  files: Iterable<{ path: string; file: FileLike }>,
): Promise<MemoryFileSet> {
  const entries: Array<[string, Uint8Array]> = [];
  for (const { path, file } of files)
    entries.push([path, new Uint8Array(await file.arrayBuffer())]);
  return new MemoryFileSet(label, entries);
}

export type Fetcher = (
  url: string,
) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;

/**
 * Files from a URL pointing at a `.model3.json` (or a `.zip`). Referenced
 * files are fetched relative to it, on demand.
 */
export async function fileSetFromUrl(url: string, fetcher: Fetcher = fetch): Promise<ModelFileSet> {
  const res = await fetcher(url);
  if (!res.ok) throw new ModelLoadError(`Could not fetch ${url} (HTTP ${res.status}).`);
  const data = new Uint8Array(await res.arrayBuffer());
  const pathname = new URL(url, 'http://x/').pathname;
  if (pathname.toLowerCase().endsWith('.zip') || (data[0] === 0x50 && data[1] === 0x4b)) {
    return fileSetFromZip(url, data);
  }
  const manifestName = decodeURIComponent(pathname.split('/').pop() || 'model.model3.json');
  const manifest = parseManifest(strFromU8(data), manifestName);
  // Reads in flight are shared too: the app reads every file for output views while
  // the renderer loads the same files.
  const cache = new Map<string, Promise<Uint8Array>>([[manifestName, Promise.resolve(data)]]);
  const known = new Set([manifestName, ...referencedFiles(manifest)]);
  return {
    label: url,
    paths: () => [...known],
    has: (p) => known.has(normalizePath(p)),
    read(p) {
      const n = normalizePath(p);
      let hit = cache.get(n);
      if (!hit) {
        hit = (async () => {
          const r = await fetcher(
            new URL(n.split('/').map(encodeURIComponent).join('/'), url).href,
          );
          if (!r.ok) throw new ModelLoadError(`Could not fetch ${n} (HTTP ${r.status}).`);
          return new Uint8Array(await r.arrayBuffer());
        })();
        cache.set(n, hit);
        hit.catch(() => cache.delete(n));
      }
      return hit;
    },
  };
}

// ---------------------------------------------------------------------------
// Manifest (.model3.json): only the file references and groups Mochi Studio
// needs for its UI. Rendering is Mochi2D's job.

export interface ExpressionEntry {
  name: string;
  file: string;
}

export interface MotionEntry {
  group: string;
  index: number;
  file: string;
  /** A display name: the file name without folder and extension. */
  name: string;
}

export interface ModelManifest {
  /** The manifest's own file name. */
  file: string;
  moc: string;
  textures: string[];
  physics?: string;
  pose?: string;
  displayInfo?: string;
  expressions: ExpressionEntry[];
  motions: MotionEntry[];
  /** Parameter-group ids by name, e.g. EyeBlink, LipSync. */
  groups: Record<string, string[]>;
  /** True when expressions or motions were found by scanning the folder. */
  discovered: { expressions: boolean; motions: boolean };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const baseName = (p: string): string =>
  (p.split('/').pop() ?? p).replace(/\.(exp3|motion3)\.json$/i, '');

export function parseManifest(json: string, file: string): ModelManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(json.replace(/^﻿/, ''));
  } catch {
    throw new ModelLoadError(`${file} is not valid JSON.`);
  }
  if (!isObj(raw) || !isObj(raw.FileReferences))
    throw new ModelLoadError(`${file} has no FileReferences.`);
  const fr = raw.FileReferences;
  if (typeof fr.Moc !== 'string')
    throw new ModelLoadError(`${file} does not reference a .moc3 file.`);
  const strOrU = (v: unknown): string | undefined =>
    typeof v === 'string' ? normalizePath(v) : undefined;

  const expressions: ExpressionEntry[] = [];
  if (Array.isArray(fr.Expressions))
    for (const e of fr.Expressions)
      if (isObj(e) && typeof e.File === 'string')
        expressions.push({
          name: typeof e.Name === 'string' ? e.Name : baseName(e.File),
          file: normalizePath(e.File),
        });

  const motions: MotionEntry[] = [];
  if (isObj(fr.Motions))
    for (const [group, list] of Object.entries(fr.Motions)) {
      if (!Array.isArray(list)) continue;
      list.forEach((m, index) => {
        if (isObj(m) && typeof m.File === 'string')
          motions.push({ group, index, file: normalizePath(m.File), name: baseName(m.File) });
      });
    }

  const groups: Record<string, string[]> = {};
  if (Array.isArray(raw.Groups))
    for (const g of raw.Groups)
      if (isObj(g) && typeof g.Name === 'string' && Array.isArray(g.Ids))
        groups[g.Name] = g.Ids.filter((x): x is string => typeof x === 'string');

  return {
    file,
    moc: normalizePath(fr.Moc),
    textures: Array.isArray(fr.Textures)
      ? fr.Textures.filter((t): t is string => typeof t === 'string').map(normalizePath)
      : [],
    physics: strOrU(fr.Physics),
    pose: strOrU(fr.Pose),
    displayInfo: strOrU(fr.DisplayInfo),
    expressions,
    motions,
    groups,
    discovered: { expressions: false, motions: false },
  };
}

export function referencedFiles(m: ModelManifest): string[] {
  return [
    m.moc,
    ...m.textures,
    ...[m.physics, m.pose, m.displayInfo].filter((x): x is string => !!x),
    ...m.expressions.map((e) => e.file),
    ...m.motions.map((x) => x.file),
  ];
}

/**
 * Many models ship expression and motion files that their manifest does not
 * list. When the manifest lists none, Mochi Studio offers the ones found in
 * the folder: expressions by file name, motions in a group named "".
 */
export function discoverUnlisted(m: ModelManifest, paths: readonly string[]): ModelManifest {
  const out = { ...m, discovered: { ...m.discovered } };
  const sorted = [...paths].sort((a, b) => a.localeCompare(b));
  if (m.expressions.length === 0) {
    const found = sorted.filter((p) => p.toLowerCase().endsWith('.exp3.json'));
    if (found.length) {
      out.expressions = found.map((file) => ({ name: baseName(file), file }));
      out.discovered.expressions = true;
    }
  }
  if (m.motions.length === 0) {
    const found = sorted.filter((p) => p.toLowerCase().endsWith('.motion3.json'));
    if (found.length) {
      out.motions = found.map((file, index) => ({ group: '', index, file, name: baseName(file) }));
      out.discovered.motions = true;
    }
  }
  return out;
}

export interface LoadedModelFiles {
  files: ModelFileSet;
  manifest: ModelManifest;
  /** Stable key for per-model settings: manifest file name + content hash. */
  key: string;
  /** Referenced files the set does not contain (a load will likely fail). */
  missing: string[];
}

/** FNV-1a, 32 bit, as hex. */
export function fnv1a(data: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    h ^= data[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export async function openModel(files: ModelFileSet): Promise<LoadedModelFiles> {
  const manifestPath = findManifestPath(files.paths());
  if (!manifestPath) throw new ModelLoadError(NO_MANIFEST);
  const bytes = await files.read(manifestPath);
  const manifest = discoverUnlisted(parseManifest(strFromU8(bytes), manifestPath), files.paths());
  const missing = referencedFiles(manifest).filter((p) => !files.has(p));
  return { files, manifest, key: `${manifestPath}#${fnv1a(bytes)}`, missing };
}

/** Parameter ids from the display-info file (`.cdi3.json`), if the model has one. */
export async function readDisplayParameters(
  files: ModelFileSet,
  m: ModelManifest,
): Promise<Array<{ id: string; name: string }>> {
  if (!m.displayInfo || !files.has(m.displayInfo)) return [];
  try {
    const raw: unknown = JSON.parse(strFromU8(await files.read(m.displayInfo)).replace(/^﻿/, ''));
    if (!isObj(raw) || !Array.isArray(raw.Parameters)) return [];
    return raw.Parameters.filter((p): p is Obj => isObj(p) && typeof p.Id === 'string').map(
      (p) => ({
        id: p.Id as string,
        name: typeof p.Name === 'string' ? p.Name : (p.Id as string),
      }),
    );
  } catch {
    return [];
  }
}

/** A motion file's duration in seconds and loop flag, from its `Meta` block. */
export async function readMotionMeta(
  files: ModelFileSet,
  file: string,
): Promise<{ duration: number; loop: boolean } | undefined> {
  try {
    const raw: unknown = JSON.parse(strFromU8(await files.read(file)).replace(/^﻿/, ''));
    if (!isObj(raw) || !isObj(raw.Meta)) return undefined;
    const d = raw.Meta.Duration;
    return { duration: typeof d === 'number' ? d : 0, loop: raw.Meta.Loop === true };
  } catch {
    return undefined;
  }
}
