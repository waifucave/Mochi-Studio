import {
  fileSetFromFiles,
  fileSetFromZip,
  type FileLike,
  type ModelFileSet,
} from '../core/modelFiles';

/** Files picked or dropped, with their paths, before deciding what they are. */
export interface FileListing {
  label: string;
  files: Array<{ path: string; file: FileLike }>;
}

/** The listing of `<input type="file" webkitdirectory>`. */
export function listFolderInput(list: FileList): FileListing {
  const files = [...list];
  return {
    label: files[0]?.webkitRelativePath.split('/')[0] ?? 'folder',
    files: files.map((f) => ({ path: f.webkitRelativePath || f.name, file: f })),
  };
}

/** Files from `<input type="file" webkitdirectory>`. */
export async function fromFolderInput(list: FileList): Promise<ModelFileSet> {
  const l = listFolderInput(list);
  return fileSetFromFiles(l.label, l.files);
}

/**
 * A listing as a frame source (src/web/animatedItems.ts) when it is a folder
 * of PNG frames: two or more PNG files and no `.model3.json`.
 */
export function framesOf(
  l: FileListing,
): { label: string; paths(): string[]; read(path: string): Promise<Uint8Array> } | undefined {
  if (l.files.some((f) => /\.model3\.json$/i.test(f.path))) return undefined;
  if (l.files.filter((f) => /\.png$/i.test(f.path)).length < 2) return undefined;
  const byPath = new Map(l.files.map((f) => [f.path, f.file] as const));
  return {
    label: l.label,
    paths: () => [...byPath.keys()],
    read: async (p) => new Uint8Array(await byPath.get(p)!.arrayBuffer()),
  };
}

export async function fromZipFile(file: File): Promise<ModelFileSet> {
  return fileSetFromZip(file.name, new Uint8Array(await file.arrayBuffer()));
}

/** A dropped folder, zip or set of files. */
export async function fromDrop(dt: DataTransfer): Promise<ModelFileSet | undefined> {
  const single = dt.files.length === 1 ? dt.files[0] : undefined;
  if (single && /\.zip$/i.test(single.name)) return fromZipFile(single);
  const l = await listDrop(dt);
  return l ? fileSetFromFiles(l.label, l.files) : undefined;
}

/** The files of a drop (folders walked), or undefined when nothing came. */
export async function listDrop(dt: DataTransfer): Promise<FileListing | undefined> {
  const entries = [...dt.items]
    .map((i) => i.webkitGetAsEntry?.())
    .filter((e): e is FileSystemEntry => !!e);
  const collected: Array<{ path: string; file: FileLike }> = [];
  for (const e of entries) await walk(e, '', collected);
  return collected.length
    ? { label: entries[0]?.name ?? 'dropped files', files: collected }
    : undefined;
}

async function walk(
  entry: FileSystemEntry,
  prefix: string,
  out: Array<{ path: string; file: FileLike }>,
): Promise<void> {
  const path = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isFile) {
    const file = await new Promise<File>((res, rej) =>
      (entry as FileSystemFileEntry).file(res, rej),
    );
    out.push({ path, file });
  } else if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((res, rej) =>
        reader.readEntries(res, rej),
      );
      if (!batch.length) break;
      for (const e of batch) await walk(e, path, out);
    }
  }
}
