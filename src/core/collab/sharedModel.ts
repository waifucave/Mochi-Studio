import { formatBytes, SHARED_MODEL_LIMITS, tooLargeDetail } from '../archiveLimits';

/**
 * The caps on a shared model (src/core/archiveLimits.ts), checked by both
 * sides: the sender shares a model's files only within them, and the
 * receiver checks an announcement against them before it sets aside any
 * memory for the files.
 */
export type SharedRefusal = { problem: 'too-large' | 'damaged'; detail: string };

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

/** What the receiver sees. */
export function refusalForReceiver(r: SharedRefusal): string {
  return r.problem === 'too-large'
    ? `Their model is larger than we accept, so it isn’t shared. ${r.detail}`
    : `Their model arrived damaged, so it isn’t shared. ${r.detail}`;
}

/** What the sender sees, beside the name of whoever refused it. */
export function refusalForSender(r: SharedRefusal): string {
  return r.problem === 'too-large'
    ? `Your model is larger than their app accepts, so they don’t have it. ${r.detail}`
    : `Your model reached them damaged, so they don’t have it. ${r.detail}`;
}
