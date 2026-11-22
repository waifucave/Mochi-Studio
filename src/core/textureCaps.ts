import { readTextureHeader, TextureFormatError, type TextureLimits } from 'mochi2d/headless';
import { fileTooLargeMessage, MAX_PICTURE_FILE_BYTES, MAX_PICTURE_PIXELS } from './archiveLimits';

/**
 * Textures and pictures from their headers, with Mochi2D's header reader,
 * before anything decodes them: the caps are in src/core/archiveLimits.ts.
 * (Apart from it, so that the desktop app's main process, which uses those
 * caps, doesn't bundle Mochi2D.)
 */

/** Why a picture is refused before it is decoded (its file, then its header), or undefined. */
export function pictureRefusal(fileBytes: number, bytes?: Uint8Array): string | undefined {
  if (fileBytes > MAX_PICTURE_FILE_BYTES)
    return fileTooLargeMessage('This picture', fileBytes, MAX_PICTURE_FILE_BYTES);
  if (!bytes) return undefined;
  let size;
  try {
    size = readTextureHeader('picture', bytes);
  } catch (e) {
    if (!(e instanceof TextureFormatError)) throw e;
    const format = unreadPictureFormat(bytes);
    return format
      ? `This picture is ${article(format)} ${format} file, which we don’t open. Save it as PNG, JPEG or WebP and add it again.`
      : 'This picture can’t be read: it is damaged, or shorter than the size it declares.';
  }
  if (size.width * size.height > MAX_PICTURE_PIXELS)
    return `This picture is larger than we accept. It is ${size.width.toLocaleString('en')} × ${size.height.toLocaleString('en')} pixels; the most is ${(MAX_PICTURE_PIXELS / 1e6).toFixed(0)} million pixels.`;
  return undefined;
}

const article = (word: string) => (/^[AEIOU]/i.test(word) ? 'an' : 'a');

/**
 * A picture format browsers may show but whose size Mochi2D doesn't read
 * from its header, so it isn't opened: from the file's first bytes.
 */
export function unreadPictureFormat(b: Uint8Array): string | undefined {
  const ascii = (i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));
  if (b.length >= 12 && ascii(4, 4) === 'ftyp') {
    const brand = ascii(8, 4);
    if (/^avi[fs]$/.test(brand)) return 'AVIF';
    if (/^(hei[cfmsx]|hev[cmsx]|mif1|msf1)$/.test(brand)) return 'HEIF';
  }
  if (b.length >= 4 && (ascii(0, 4) === 'II*\0' || ascii(0, 4) === 'MM\0*')) return 'TIFF';
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0x0a) return 'JPEG XL';
  if (b.length >= 12 && ascii(4, 4) === 'JXL ') return 'JPEG XL';
  return undefined;
}

export type TextureProblem = 'too-large' | 'damaged' | 'unsupported';

/** What a refusal says about a texture past a cap (Mochi2D's `TextureLimitError`'s fields). */
export function textureTooLargeDetail(
  kind: 'side' | 'pixels' | 'total',
  limit: number,
  size: number,
  path: string,
  width: number,
  height: number,
): string {
  const n = (v: number) => v.toLocaleString('en');
  switch (kind) {
    case 'side':
      return `Its texture “${path}” is ${n(width)} × ${n(height)} pixels; the most is ${n(limit)} a side.`;
    case 'pixels':
      return `Its texture “${path}” is ${n(width)} × ${n(height)} pixels, ${n(width * height)} in all; the most for one texture is ${n(limit)}.`;
    case 'total':
      return `Its textures come to ${n(size)} pixels; the most in all is ${n(limit)}.`;
  }
}

/**
 * What a refusal says about a texture Mochi2D doesn't read (its
 * `TextureFormatError`): a format it doesn't open, named from the file's
 * first bytes, or a damaged or crafted file.
 */
export function textureFormatDetail(
  path: string,
  head?: Uint8Array,
): { problem: 'unsupported' | 'damaged'; detail: string } {
  const format = head && unreadPictureFormat(head);
  return format
    ? {
        problem: 'unsupported',
        detail: `Its texture “${path}” is ${article(format)} ${format} picture, which we don’t open. Save it as PNG and try again.`,
      }
    : {
        problem: 'damaged',
        detail: `Its texture “${path}” isn’t a picture we can read: it is damaged, or shorter than the size it declares.`,
      };
}

/**
 * Checks a model's textures against `limits` from their headers, as
 * Mochi2D's load does (each one's side and pixels, then all together),
 * before anything decodes them. Undefined when they pass.
 */
export function checkTextureSet(
  textures: ReadonlyArray<{ path: string; bytes: Uint8Array }>,
  limits: Readonly<Required<TextureLimits>>,
): { problem: TextureProblem; detail: string } | undefined {
  let total = 0;
  for (const { path, bytes } of textures) {
    let size;
    try {
      size = readTextureHeader(path, bytes);
    } catch (e) {
      if (e instanceof TextureFormatError) return textureFormatDetail(path, bytes);
      throw e;
    }
    const { width, height } = size;
    if (width > limits.maxSide || height > limits.maxSide)
      return {
        problem: 'too-large',
        detail: textureTooLargeDetail(
          'side',
          limits.maxSide,
          Math.max(width, height),
          path,
          width,
          height,
        ),
      };
    if (width * height > limits.maxPixels)
      return {
        problem: 'too-large',
        detail: textureTooLargeDetail(
          'pixels',
          limits.maxPixels,
          width * height,
          path,
          width,
          height,
        ),
      };
    total += width * height;
  }
  if (total > limits.maxTotalPixels)
    return {
      problem: 'too-large',
      detail: textureTooLargeDetail('total', limits.maxTotalPixels, total, '', 0, 0),
    };
  return undefined;
}
