import {
  formatBytes,
  pictureSize,
  SHARED_HELD_BYTES,
  SHARED_MODEL_LIMITS,
  SHARED_TEXTURE_LIMITS,
  tooLargeDetail,
} from '../archiveLimits';
import { MemoryFileSet, openModel } from '../modelFiles';

/**
 * The caps on a shared model (src/core/archiveLimits.ts), checked by both
 * sides: the sender shares a model's files only within them, and the
 * receiver checks an announcement against them before it sets aside any
 * memory for the files.
 */
export type SharedRefusal = { problem: 'too-large' | 'damaged' | 'no-room'; detail: string };

export const MAX_SHARED_PATH = 1024;

/** Why a model's files can't be shared (its sizes, as the sender reads them), or undefined. */
export function sharedModelTooLarge(
  files: ReadonlyArray<{ path: string; size: number }>,
  caps = SHARED_MODEL_LIMITS,
): SharedRefusal | undefined {
  if (files.length > caps.maxEntries)
    return {
      problem: 'too-large',
      detail: tooLargeDetail('entries', caps.maxEntries, files.length),
    };
  const largest = files.reduce((a, f) => (f.size > a.size ? f : a), { path: '', size: 0 });
  if (largest.size > caps.maxEntryBytes)
    return {
      problem: 'too-large',
      detail: tooLargeDetail('entry', caps.maxEntryBytes, largest.size, largest.path),
    };
  const total = files.reduce((a, f) => a + f.size, 0);
  if (total > caps.maxTotalBytes)
    return {
      problem: 'too-large',
      detail: `Its files come to ${formatBytes(total)}; the most in all is ${formatBytes(caps.maxTotalBytes)}.`,
    };
  return undefined;
}

/**
 * Checks a received announcement's file list: a list of paths and whole,
 * non-negative sizes, no path twice, adding up to the announced total, and
 * within the caps. Undefined when it may be received.
 */
export function checkSharedAnnouncement(
  files: unknown,
  bytes: unknown,
  caps = SHARED_MODEL_LIMITS,
): SharedRefusal | undefined {
  const damaged = (detail: string): SharedRefusal => ({ problem: 'damaged', detail });
  if (!Array.isArray(files)) return damaged('Its list of files is missing.');
  // The count first: a long list is refused before it is looked through.
  if (files.length > caps.maxEntries)
    return {
      problem: 'too-large',
      detail: tooLargeDetail('entries', caps.maxEntries, files.length),
    };
  const seen = new Set<string>();
  const list: { path: string; size: number }[] = [];
  for (const f of files as unknown[]) {
    const { path, size } = (f ?? {}) as { path?: unknown; size?: unknown };
    if (typeof path !== 'string' || !path || path.length > MAX_SHARED_PATH)
      return damaged('A file in its list has no usable name.');
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0)
      return damaged(`“${path}” has no usable size.`);
    if (seen.has(path)) return damaged(`“${path}” is listed twice.`);
    seen.add(path);
    list.push({ path, size });
  }
  const tooLarge = sharedModelTooLarge(list, caps);
  if (tooLarge) return tooLarge;
  const total = list.reduce((a, f) => a + f.size, 0);
  if (bytes !== total) return damaged('Its sizes don’t add up to its total.');
  return undefined;
}

const millions = (n: number) => `${Math.round(n / 1e6).toLocaleString('en')} million`;

/**
 * Checks a shared model's textures by their headers, before anything
 * decodes them: each at most 8192 pixels a side, all together at most
 * 64 Mi pixels. The files are the model's, by path; undefined when they
 * may be shown. (Mochi2D will check this itself; until then, the app does
 * on this path, where the model comes from someone else's computer.)
 */
export async function checkSharedTextures(
  files: ReadonlyMap<string, Uint8Array>,
  limits = SHARED_TEXTURE_LIMITS,
): Promise<SharedRefusal | undefined> {
  let model;
  try {
    model = await openModel(new MemoryFileSet('shared', files));
  } catch (e) {
    return { problem: 'damaged', detail: (e as Error).message };
  }
  let pixels = 0;
  for (const t of model.manifest.textures) {
    if (!model.files.has(t)) continue; // the load says what is missing
    const size = pictureSize(await model.files.read(t));
    if (!size)
      return { problem: 'damaged', detail: `Its texture “${t}” isn’t a picture we can read.` };
    if (size.width > limits.maxSide || size.height > limits.maxSide)
      return {
        problem: 'too-large',
        detail: `Its texture “${t}” is ${size.width.toLocaleString('en')} × ${size.height.toLocaleString('en')} pixels; the most is ${limits.maxSide.toLocaleString('en')} a side.`,
      };
    pixels += size.width * size.height;
  }
  if (pixels > limits.maxPixels)
    return {
      problem: 'too-large',
      detail: `Its textures come to ${millions(pixels)} pixels; the most in all is ${millions(limits.maxPixels)}.`,
    };
  return undefined;
}

/**
 * Whether another shared model fits beside those this app holds already
 * (`held`, bytes, all participants together), or why not.
 */
export function sharedRoom(
  held: number,
  bytes: number,
  max = SHARED_HELD_BYTES,
): SharedRefusal | undefined {
  if (held + bytes <= max) return undefined;
  return {
    problem: 'no-room',
    detail: `This app holds ${formatBytes(held)} of others’ models already, and ${formatBytes(max)} at most; this one is ${formatBytes(bytes)}. It comes when there is room.`,
  };
}

/** What the receiver sees. */
export function refusalForReceiver(r: SharedRefusal): string {
  switch (r.problem) {
    case 'too-large':
      return `Their model is larger than we accept, so it isn’t shared. ${r.detail}`;
    case 'damaged':
      return `Their model arrived damaged, so it isn’t shared. ${r.detail}`;
    case 'no-room':
      return `There is no room for their model now. ${r.detail}`;
  }
}

/** What the sender sees, beside the name of whoever refused it. */
export function refusalForSender(r: SharedRefusal): string {
  switch (r.problem) {
    case 'too-large':
      return `Your model is larger than their app accepts, so they don’t have it. ${r.detail}`;
    case 'damaged':
      return `Your model reached them damaged, so they don’t have it. ${r.detail}`;
    case 'no-room':
      return 'Their app has no room for your model now. It goes to them by itself when there is room.';
  }
}
