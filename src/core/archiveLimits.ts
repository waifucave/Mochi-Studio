import type { ArchiveLimits, TextureLimits } from 'mochi2d/headless';

/**
 * How much an archive Mochi Studio did not make may take, per path
 * (Mochi2D's `ArchiveLimits`). The models measured by Mochi2D are at most
 * 17 MB a file, 77 MB in all and 44 files.
 *
 * - **A model or an item** chosen, dropped, opened in the desktop app or
 *   linked by URL: 64 MB a file, 256 MB in all, 2,000 files. Four times
 *   the largest file seen and three times the largest model, so no real
 *   model is refused, while a zip bomb stops at a size a computer holds.
 *   An item is a model (or a picture), so it gets the same caps.
 * - **A settings export:** the settings and the items' files, so the same
 *   per-file cap; and the same total, which the export checks too, so the
 *   app never writes a file it would refuse to read.
 * - **A shared model** from another participant: the tightest, 32 MB a
 *   file and 500 files (the caps Mochi2D gives for phones), and 160 MB in
 *   all: twice the largest model measured. Its textures may declare at
 *   most 8192 pixels a side and 64 Mi pixels together (one texture of
 *   8192 × 8192, or four of 4096 × 4096: 256 MB once decoded). And one app
 *   holds at most 600 MB of others' shared models at once. The sender
 *   checks the same caps, so only a crafted announcement is refused.
 *
 * Textures (Mochi2D's `TextureLimits`, read from each texture's header
 * before anything decodes it):
 *
 * - **A model or an item** of the person's own, a plugin's item, a dropped
 *   picture's item: 8192 a side, 2²⁶ pixels a texture (256 MB once
 *   decoded), 2²⁸ a model. Mochi2D gives these for apps that open models
 *   from strangers, and they fit every model it measured.
 * - **A shared model:** the same per texture, and 2²⁶ (67,108,864) pixels
 *   in all.
 *
 * An archive at its caps costs at most about twice its per-file cap at
 * once, and its total over its life.
 */
const MB = 2 ** 20;

export const MODEL_ARCHIVE_LIMITS: Readonly<Required<ArchiveLimits>> = Object.freeze({
  maxEntryBytes: 64 * MB,
  maxTotalBytes: 256 * MB,
  maxEntries: 2000,
});

export const SETTINGS_ARCHIVE_LIMITS: Readonly<Required<ArchiveLimits>> = MODEL_ARCHIVE_LIMITS;

export const SHARED_MODEL_LIMITS: Readonly<Required<ArchiveLimits>> = Object.freeze({
  maxEntryBytes: 32 * MB,
  maxTotalBytes: 160 * MB,
  maxEntries: 500,
});

/** The textures of a model or an item opened here (the person's own, a plugin's, a picture's). */
export const MODEL_TEXTURE_LIMITS: Readonly<Required<TextureLimits>> = Object.freeze({
  maxSide: 8192,
  maxPixels: 2 ** 26,
  maxTotalPixels: 2 ** 28,
});

/**
 * A shared model's textures: what the receiver checks before it shows the
 * model, what the sender checks before it shares it, and the caps the model
 * is then loaded with. One rule, Mochi2D's.
 */
export const SHARED_TEXTURE_LIMITS: Readonly<Required<TextureLimits>> = Object.freeze({
  maxSide: 8192,
  maxPixels: 2 ** 26,
  maxTotalPixels: 2 ** 26,
});

/** What one app holds of others' shared models at once, all participants together. */
export const SHARED_HELD_BYTES = 600 * MB;

/**
 * A plain settings file (JSON), or one inside a settings export: settings
 * are text, a few hundred KB even with expressions of their own.
 */
export const MAX_SETTINGS_JSON_BYTES = 16 * MB;

/**
 * A picture dropped on the stage: the file, and the pixels it decodes to
 * (64 million, 256 MB as RGBA: more than a 50-megapixel photo). Its
 * declared size is read from its header before the browser decodes it.
 */
export const MAX_PICTURE_FILE_BYTES = 64 * MB;
export const MAX_PICTURE_PIXELS = 64_000_000;

/**
 * The largest archive file read at all: its caps' total and a little more
 * for the zip's own records. A larger file is refused before it is read
 * into memory.
 */
export function maxArchiveFileBytes(caps: Readonly<Required<ArchiveLimits>>): number {
  return caps.maxTotalBytes + caps.maxEntries * 1024 + MB;
}

/** A size for people: "64 MB", "1.5 MB", "820 KB". */
export function formatBytes(n: number): string {
  if (n >= MB) {
    const v = n / MB;
    return `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10} MB`;
  }
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

export type ArchiveProblem = 'too-large' | 'damaged' | 'unsupported';

/** What a refusal says when one of the caps is passed. */
export function tooLargeDetail(
  kind: 'entry' | 'total' | 'entries',
  limit: number,
  size: number,
  path?: string,
): string {
  switch (kind) {
    case 'entry':
      return `${path ? `“${path}”` : 'One of its files'} is ${formatBytes(size)}; the most for one file is ${formatBytes(limit)}.`;
    case 'total':
      return `Its files come to more than the ${formatBytes(limit)} allowed in all.`;
    case 'entries':
      return `It has ${size.toLocaleString('en')} files; the most is ${limit.toLocaleString('en')}.`;
  }
}

/** The refusal of an archive file too large to read at all. */
export function fileTooLargeMessage(what: string, size: number, max: number): string {
  return `${what} is larger than we accept. The file is ${formatBytes(size)}; the most is ${formatBytes(max)}.`;
}
