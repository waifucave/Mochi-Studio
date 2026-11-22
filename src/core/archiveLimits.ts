import type { ArchiveLimits } from 'mochi2d/headless';

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
 *   file and 500 files (the caps Mochi2D gives for phones), and 300 MB in
 *   all, the limit the collaboration has always had. The sender checks
 *   the same caps, so only a crafted announcement is refused.
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
  maxTotalBytes: 300 * MB,
  maxEntries: 500,
});

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

/** A picture's width and height from its header: PNG, JPEG, GIF or WebP; undefined if unknown. */
export function pictureSize(b: Uint8Array): { width: number; height: number } | undefined {
  const at = (i: number) => b[i] ?? 0;
  const u16be = (i: number) => (at(i) << 8) | at(i + 1);
  const u16le = (i: number) => at(i) | (at(i + 1) << 8);
  const u24le = (i: number) => at(i) | (at(i + 1) << 8) | (at(i + 2) << 16);
  const u32be = (i: number) =>
    ((at(i) << 24) >>> 0) + (at(i + 1) << 16) + (at(i + 2) << 8) + at(i + 3);
  const ascii = (i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));
  if (b.length >= 24 && at(0) === 0x89 && ascii(1, 3) === 'PNG' && ascii(12, 4) === 'IHDR')
    return { width: u32be(16), height: u32be(20) };
  if (b.length >= 10 && ascii(0, 3) === 'GIF') return { width: u16le(6), height: u16le(8) };
  if (b.length >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    const chunk = ascii(12, 4);
    if (chunk === 'VP8X') return { width: 1 + u24le(24), height: 1 + u24le(27) };
    if (chunk === 'VP8L') {
      const bits = at(21) | (at(22) << 8) | (at(23) << 16) | (at(24) << 24);
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
    }
    if (chunk === 'VP8 ') return { width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff };
    return undefined;
  }
  if (at(0) === 0xff && at(1) === 0xd8) {
    // JPEG: the first start-of-frame marker (SOF0 to SOF15, except DHT, JPG and DAC).
    let i = 2;
    while (i + 9 < b.length) {
      if (at(i) !== 0xff) return undefined;
      const marker = at(i + 1);
      if (marker === 0xff) {
        i++;
        continue;
      }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
        return { width: u16be(i + 7), height: u16be(i + 5) };
      if (marker === 0xd9 || marker === 0xda) return undefined;
      i += 2 + u16be(i + 2);
    }
  }
  return undefined;
}

/** Why a picture is refused before it is decoded, or undefined. */
export function pictureTooLarge(fileBytes: number, head?: Uint8Array): string | undefined {
  if (fileBytes > MAX_PICTURE_FILE_BYTES)
    return fileTooLargeMessage('This picture', fileBytes, MAX_PICTURE_FILE_BYTES);
  const size = head && pictureSize(head);
  if (size && size.width * size.height > MAX_PICTURE_PIXELS)
    return `This picture is larger than we accept. It is ${size.width.toLocaleString('en')} × ${size.height.toLocaleString('en')} pixels; the most is ${(MAX_PICTURE_PIXELS / 1e6).toFixed(0)} million pixels.`;
  return undefined;
}

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
