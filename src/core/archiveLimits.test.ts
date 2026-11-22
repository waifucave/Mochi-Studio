import { unzipSync } from 'fflate';
import { craftZip, crc32, zeros } from '../../test/support/craftedZip';
import { avifStart, pngDeclaring, tiffStart } from '../../test/support/craftedTexture';
import { describe, expect, it, vi } from 'vitest';
import { fromZipFile } from '../web/fileInput';
import {
  maxArchiveFileBytes,
  MODEL_ARCHIVE_LIMITS,
  MODEL_TEXTURE_LIMITS,
  SETTINGS_ARCHIVE_LIMITS,
  SHARED_HELD_BYTES,
  SHARED_MODEL_LIMITS,
  SHARED_TEXTURE_LIMITS,
} from './archiveLimits';
import { checkTextureSet, pictureRefusal } from './textureCaps';
import {
  checkSharedAnnouncement,
  checkSharedTextures,
  refusalForSender,
  sharedModelTooLarge,
  sharedRoom,
} from './collab/sharedModel';
import {
  FileLimitError,
  MocFormatError,
  TextureFormatError,
  TextureLimitError,
} from 'mochi2d/headless';
import {
  checkArchiveFileSize,
  describeLoadError,
  fileSetFromUrl,
  fileSetFromZip,
  ModelLoadError,
  openModel,
  type Fetcher,
} from './modelFiles';
import { defaultSettings, exportSettings, SettingsError } from './settings';
import { buildSettingsBundle, readSettingsExport, SETTINGS_ENTRY } from './settingsBundle';

// Building and reading archives of tens of MB takes seconds on a busy machine.
vi.setConfig({ testTimeout: 30_000 });

/** The caps on each path, tried with archives that lie (test/support/craftedZip.ts). */
const MB = 2 ** 20;
const enc = new TextEncoder();

const MANIFEST = enc.encode(
  JSON.stringify({ Version: 3, FileReferences: { Moc: 'm.moc3', Textures: ['t.png'] } }),
);
const manifestEntry = { name: 'm.model3.json', data: MANIFEST };

/** The error a promise rejects with. */
async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error('It did not fail.');
}
const problem = (e: Error) => (e as ModelLoadError).problem;

describe('the caps per path', () => {
  it('are Mochi2D’s caps for models from strangers, and tighter ones for a shared model', () => {
    expect(MODEL_ARCHIVE_LIMITS).toEqual({
      maxEntryBytes: 64 * MB,
      maxTotalBytes: 256 * MB,
      maxEntries: 2000,
    });
    expect(SETTINGS_ARCHIVE_LIMITS).toEqual(MODEL_ARCHIVE_LIMITS);
    expect(SHARED_MODEL_LIMITS).toEqual({
      maxEntryBytes: 32 * MB,
      maxTotalBytes: 160 * MB,
      maxEntries: 500,
    });
    expect(SHARED_TEXTURE_LIMITS).toEqual({
      maxSide: 8192,
      maxPixels: 67_108_864,
      maxTotalPixels: 67_108_864,
    });
    expect(MODEL_TEXTURE_LIMITS).toEqual({
      maxSide: 8192,
      maxPixels: 67_108_864,
      maxTotalPixels: 268_435_456,
    });
    expect(SHARED_HELD_BYTES).toBe(600 * MB);
  });
});

describe('a model zip, chosen, dropped or opened in the desktop app', () => {
  it('opens one within the caps', async () => {
    const zip = craftZip([manifestEntry, { name: 'm.moc3', data: new Uint8Array(100) }]);
    const m = await openModel(fileSetFromZip('ok.zip', zip));
    expect(m.manifest.moc).toBe('m.moc3');
    expect((await m.files.read('m.moc3')).length).toBe(100);
  });

  it('refuses a zip bomb as too large, before inflating it', async () => {
    const zip = craftZip([manifestEntry, { name: 't.png', deflated: zeros(65 * MB) }]);
    expect(zip.length).toBeLessThan(MB);
    const set = fileSetFromZip('bomb.zip', zip);
    const e = await rejection(set.read('t.png'));
    expect(e).toBeInstanceOf(ModelLoadError);
    expect(problem(e)).toBe('too-large');
    expect(e.message).toBe(
      'This model is larger than we accept. “t.png” is 65 MB; the most for one file is 64 MB.',
    );
  });

  it('refuses one whose files come to more than its total', async () => {
    // The total counts what is really inflated, each file once. With the real caps this
    // takes inflating 256 MB; smaller caps show the same in a moment.
    const caps = { maxEntryBytes: 4 * MB, maxTotalBytes: 10 * MB, maxEntries: 100 };
    const part = zeros(3 * MB);
    const zip = craftZip([
      manifestEntry,
      ...[0, 1, 2, 3].map((i) => ({ name: `t${i}.png`, deflated: part })),
    ]);
    const set = fileSetFromZip('many.zip', zip, caps);
    for (const i of [0, 1, 2]) expect((await set.read(`t${i}.png`)).length).toBe(3 * MB);
    // Reading one again doesn't count twice.
    await set.read('t0.png');
    const e = await rejection(set.read('t3.png'));
    expect(problem(e)).toBe('too-large');
    expect(e.message).toBe(
      'This model is larger than we accept. Its files come to more than the 10 MB allowed in all.',
    );
  });

  it('refuses one with more than 2,000 files when it is opened', () => {
    const zip = craftZip([
      manifestEntry,
      ...Array.from({ length: 2000 }, (_, i) => ({ name: `x/${i}`, data: new Uint8Array(1) })),
    ]);
    let e: Error | undefined;
    try {
      fileSetFromZip('crowded.zip', zip);
    } catch (x) {
      e = x as Error;
    }
    expect(problem(e!)).toBe('too-large');
    expect(e!.message).toBe(
      'This model is larger than we accept. It has 2,001 files; the most is 2,000.',
    );
  });

  it('calls damaged an entry that inflates past what it declares', async () => {
    const zip = craftZip([
      manifestEntry,
      { name: 'm.moc3', data: new Uint8Array(4 * MB), declaredSize: 1024 },
    ]);
    const e = await rejection(fileSetFromZip('liar.zip', zip).read('m.moc3'));
    expect(problem(e)).toBe('damaged');
    expect(e.message).toMatch(
      /^This model is a damaged zip, so it can’t be opened\. Download or copy it again\./,
    );
  });

  it('calls damaged an entry whose CRC-32 is wrong', async () => {
    const data = enc.encode('moc data');
    const zip = craftZip([manifestEntry, { name: 'm.moc3', data, crc: crc32(data) ^ 1 }]);
    const e = await rejection(fileSetFromZip('crc.zip', zip).read('m.moc3'));
    expect(problem(e)).toBe('damaged');
  });

  it('calls damaged what is not a zip at all', () => {
    let e: Error | undefined;
    try {
      fileSetFromZip('junk.zip', enc.encode('PK but not really a zip file'));
    } catch (x) {
      e = x as Error;
    }
    expect(problem(e!)).toBe('damaged');
  });

  it('refuses a zip file larger than the caps allow before reading it', () => {
    const max = maxArchiveFileBytes(MODEL_ARCHIVE_LIMITS);
    expect(() => checkArchiveFileSize(max)).not.toThrow();
    expect(() => checkArchiveFileSize(max + 1)).toThrow(
      /^This model is larger than we accept\. The file is 259 MB; the most is 259 MB\.$/,
    );
  });

  it('says “this item” for an item zip', async () => {
    const zip = craftZip([manifestEntry, { name: 't.png', deflated: zeros(65 * MB) }]);
    const file = new File([zip as Uint8Array<ArrayBuffer>], 'prop.zip');
    const e = await rejection((await fromZipFile(file, 'This item')).read('t.png'));
    expect(e.message).toMatch(/^This item is larger than we accept\./);
    const huge = { name: 'huge.zip', size: 300 * MB } as File;
    expect((await rejection(fromZipFile(huge, 'This item'))).message).toMatch(
      /^This item is larger than we accept\. The file is 300 MB/,
    );
  });
});

describe('a model from a URL', () => {
  /** A server of the given bodies; `length` says what Content-Length to send. */
  const serve =
    (files: Record<string, Uint8Array>, o: { length?: number; stream?: boolean } = {}): Fetcher =>
    async (url) => {
      const body = files[new URL(url).pathname];
      if (!body) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
      return {
        ok: true,
        status: 200,
        headers: { get: (h) => (h === 'content-length' && o.length ? String(o.length) : null) },
        body: o.stream
          ? new ReadableStream<Uint8Array>({
              start(c) {
                for (let at = 0; at < body.length; at += MB) c.enqueue(body.subarray(at, at + MB));
                c.close();
              },
            })
          : null,
        arrayBuffer: async () => body.slice().buffer,
      };
    };

  it('refuses a download whose declared length is too large, before reading it', async () => {
    const e = await rejection(
      fileSetFromUrl(
        'https://example.test/m.zip',
        serve({ '/m.zip': new Uint8Array(10) }, { length: 2 ** 31 }),
      ),
    );
    expect(problem(e)).toBe('too-large');
    expect(e.message).toMatch(/^This model is larger than we accept\. The file is 2048 MB/);
  });

  it('stops a file that streams in past the per-file cap', async () => {
    const files = {
      '/m/m.model3.json': MANIFEST,
      '/m/t.png': new Uint8Array(65 * MB),
    };
    const set = await fileSetFromUrl(
      'https://example.test/m/m.model3.json',
      serve(files, { stream: true }),
    );
    const e = await rejection(set.read('t.png'));
    expect(problem(e)).toBe('too-large');
    expect(e.message).toBe(
      'This model is larger than we accept. “t.png” is 65 MB; the most for one file is 64 MB.',
    );
  });

  it('stops when the files together pass 256 MB', async () => {
    const tex = new Uint8Array(60 * MB);
    const manifest = enc.encode(
      JSON.stringify({
        FileReferences: { Moc: 'm.moc3', Textures: ['0.png', '1.png', '2.png', '3.png', '4.png'] },
      }),
    );
    const files: Record<string, Uint8Array> = { '/m/m.model3.json': manifest };
    for (let i = 0; i < 5; i++) files[`/m/${i}.png`] = tex;
    const set = await fileSetFromUrl(
      'https://example.test/m/m.model3.json',
      serve(files, { stream: true }),
    );
    for (const i of [0, 1, 2, 3]) await set.read(`${i}.png`);
    const e = await rejection(set.read('4.png'));
    expect(problem(e)).toBe('too-large');
    expect(e.message).toMatch(/Its files come to more than the 256 MB allowed/);
  });

  it('applies the zip caps to a zip at a URL', async () => {
    const zip = craftZip([manifestEntry, { name: 't.png', deflated: zeros(65 * MB) }]);
    const set = await fileSetFromUrl('https://example.test/bomb.zip', serve({ '/bomb.zip': zip }));
    expect(problem(await rejection(set.read('t.png')))).toBe('too-large');
  });
});

describe('a settings file', () => {
  const withItem = exportSettings({
    ...defaultSettings('a.model3.json#1', []),
    items: [{ id: 'item-a', label: 'Hat', visible: true, pinned: true }],
  });
  const settings = enc.encode(withItem);

  it('refuses a zip bomb among the item files as too large', async () => {
    const zip = craftZip([
      { name: SETTINGS_ENTRY, data: settings },
      { name: 'items/item-a/hat.model3.json', data: enc.encode('{}') },
      { name: 'items/item-a/t.png', deflated: zeros(65 * MB) },
    ]);
    const e = await rejection(readSettingsExport(zip, 'k'));
    expect(e).toBeInstanceOf(SettingsError);
    expect(e.message).toBe(
      'This settings file is larger than we accept. “items/item-a/t.png” is 65 MB; the most for one file is 64 MB.',
    );
  });

  it('refuses too many entries, and damaged data, each in its own words', async () => {
    const crowded = craftZip([
      { name: SETTINGS_ENTRY, data: settings },
      ...Array.from({ length: 2000 }, (_, i) => ({
        name: `items/a/${i}`,
        data: new Uint8Array(1),
      })),
    ]);
    expect((await rejection(readSettingsExport(crowded, 'k'))).message).toBe(
      'This settings file is larger than we accept. It has 2,001 files; the most is 2,000.',
    );
    const crc = craftZip([{ name: SETTINGS_ENTRY, data: settings, crc: crc32(settings) ^ 1 }]);
    expect((await rejection(readSettingsExport(crc, 'k'))).message).toMatch(
      /^This settings file is a damaged zip, so it can’t be opened\./,
    );
    const liar = craftZip([
      { name: SETTINGS_ENTRY, data: new Uint8Array(4 * MB), declaredSize: 10 },
    ]);
    expect((await rejection(readSettingsExport(liar, 'k'))).message).toMatch(/damaged zip/);
  });

  it('refuses settings over 16 MB, plain or in a zip', async () => {
    const big = new Uint8Array(17 * MB).fill(0x20);
    expect((await rejection(readSettingsExport(big, 'k'))).message).toBe(
      'This settings file is larger than we accept. The file is 17 MB; the most is 16 MB.',
    );
    const zipped = craftZip([{ name: SETTINGS_ENTRY, data: big }]);
    expect((await rejection(readSettingsExport(zipped, 'k'))).message).toBe(
      'This settings file is larger than we accept. Its settings are 17 MB; the most is 16 MB.',
    );
  });

  it('never exports what it would refuse to import', () => {
    const files: Array<[string, Uint8Array]> = [['t.png', new Uint8Array(65 * MB)]];
    expect(() => buildSettingsBundle('{}', [{ id: 'a', files }])).toThrow(
      /too large to export with the settings .* Export without the item files\./,
    );
    // Within the caps, it reads back.
    const ok = buildSettingsBundle('{}', [{ id: 'a', files: [['t.png', new Uint8Array(10)]] }]);
    expect(Object.keys(unzipSync(ok))).toEqual([SETTINGS_ENTRY, 'items/a/t.png']);
  });
});

describe('a shared model’s announcement', () => {
  const ok = [
    { path: 'm.model3.json', size: 1000 },
    { path: 'm.moc3', size: 2 * MB },
  ];

  it('lets through a model within the caps, and the sender shares only such models', () => {
    expect(checkSharedAnnouncement(ok, 1000 + 2 * MB)).toBeUndefined();
    expect(sharedModelTooLarge(ok)).toBeUndefined();
    expect(sharedModelTooLarge([{ path: 't.png', size: 33 * MB }])).toEqual({
      problem: 'too-large',
      detail: '“t.png” is 33 MB; the most for one file is 32 MB.',
    });
  });

  it('refuses sizes that don’t add up before anything is set aside', () => {
    expect(checkSharedAnnouncement([{ path: 'a', size: 30 * MB }], 1)?.problem).toBe('damaged');
    expect(checkSharedAnnouncement([{ path: 'a', size: 2 ** 53 }], 2 ** 53)?.problem).toBe(
      'damaged',
    );
    expect(checkSharedAnnouncement([{ path: '', size: 1 }], 1)?.problem).toBe('damaged');
    expect(checkSharedAnnouncement([{ path: 'a', size: '1' }], 1)?.problem).toBe('damaged');
    expect(checkSharedAnnouncement([null], 0)?.problem).toBe('damaged');
    expect(checkSharedAnnouncement(undefined, 0)?.problem).toBe('damaged');
  });

  it('refuses one over the caps as too large', () => {
    const many = Array.from({ length: 501 }, (_, i) => ({ path: `${i}`, size: 1 }));
    expect(checkSharedAnnouncement(many, 501)).toEqual({
      problem: 'too-large',
      detail: 'It has 501 files; the most is 500.',
    });
    const heavy = Array.from({ length: 10 }, (_, i) => ({ path: `${i}`, size: 17 * MB }));
    expect(checkSharedAnnouncement(heavy, 170 * MB)?.detail).toBe(
      'Its files come to 170 MB; the most in all is 160 MB.',
    );
  });

  it('fits beside the others’ models up to 600 MB, and says why not past it', () => {
    expect(sharedRoom(440 * MB, 160 * MB)).toBeUndefined();
    expect(sharedRoom(450 * MB, 160 * MB)).toEqual({
      problem: 'no-room',
      detail:
        'This app holds 450 MB of others’ models already, and 600 MB at most; this one is 160 MB. It comes when there is room.',
    });
    expect(refusalForSender(sharedRoom(450 * MB, 160 * MB)!)).toBe(
      'Their app has no room for your model now. It goes to them by itself when there is room.',
    );
  });
});

describe('a shared model’s textures', () => {
  const png = (w: number, h: number) => pngDeclaring(w, h);
  const model = (...textures: Uint8Array[]) =>
    new Map<string, Uint8Array>([
      [
        'M/m.model3.json',
        enc.encode(
          JSON.stringify({
            FileReferences: { Moc: 'm.moc3', Textures: textures.map((_, i) => `t/${i}.png`) },
          }),
        ),
      ],
      ['M/m.moc3', new Uint8Array(10)],
      ...textures.map((t, i) => [`M/t/${i}.png`, t] as [string, Uint8Array]),
    ]);

  it('lets through textures up to 8192 a side and 67,108,864 pixels in all', async () => {
    expect(await checkSharedTextures(model(png(8192, 8192)))).toBeUndefined();
    expect(
      await checkSharedTextures(
        model(png(4096, 4096), png(4096, 4096), png(4096, 4096), png(4096, 4096)),
      ),
    ).toBeUndefined();
  });

  it('refuses a texture over 8192 a side, by its header', async () => {
    expect(await checkSharedTextures(model(png(16384, 64)))).toEqual({
      problem: 'too-large',
      detail: 'Its texture “t/0.png” is 16,384 × 64 pixels; the most is 8,192 a side.',
    });
  });

  it('refuses textures that come to more than 67,108,864 pixels together', async () => {
    expect(await checkSharedTextures(model(png(8192, 8192), png(1024, 1024)))).toEqual({
      problem: 'too-large',
      detail: 'Its textures come to 68,157,440 pixels; the most in all is 67,108,864.',
    });
  });

  it('calls damaged a lying texture, one that is no picture, or a model without settings', async () => {
    expect(await checkSharedTextures(model(pngDeclaring(30000, 30000, true)))).toEqual({
      problem: 'damaged',
      detail:
        'Its texture “t/0.png” isn’t a picture we can read: it is damaged, or shorter than the size it declares.',
    });
    expect((await checkSharedTextures(model(enc.encode('not a png'))))?.problem).toBe('damaged');
    expect((await checkSharedTextures(new Map([['x.bin', new Uint8Array(1)]])))?.problem).toBe(
      'damaged',
    );
  });

  it('names a format it doesn’t open', async () => {
    expect(await checkSharedTextures(model(avifStart()))).toEqual({
      problem: 'unsupported',
      detail:
        'Its texture “t/0.png” is an AVIF picture, which we don’t open. Save it as PNG and try again.',
    });
    expect((await checkSharedTextures(model(tiffStart())))?.detail).toMatch(/is a TIFF picture/);
  });
});

describe('the texture caps of a model or an item opened here', () => {
  const set = (...t: Uint8Array[]) => t.map((bytes, i) => ({ path: `t${i}.png`, bytes }));
  it('lets through 8192 a side, and up to 268,435,456 pixels a model', () => {
    expect(
      checkTextureSet(set(...Array(4).fill(pngDeclaring(8192, 8192))), MODEL_TEXTURE_LIMITS),
    ).toBeUndefined();
  });
  it('refuses more, and names the cap', () => {
    expect(
      checkTextureSet(set(...Array(5).fill(pngDeclaring(8192, 8192))), MODEL_TEXTURE_LIMITS)
        ?.detail,
    ).toBe('Its textures come to 335,544,320 pixels; the most in all is 268,435,456.');
    expect(checkTextureSet(set(pngDeclaring(8193, 16)), MODEL_TEXTURE_LIMITS)?.detail).toBe(
      'Its texture “t0.png” is 8,193 × 16 pixels; the most is 8,192 a side.',
    );
  });
});

describe('a picture dropped on the stage', () => {
  /** A PNG signature and IHDR declaring any size (the pixels themselves never come). */
  const png = (w: number, h: number) => {
    const b = new Uint8Array(33);
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13], 0);
    b.set(enc.encode('IHDR'), 12);
    new DataView(b.buffer).setUint32(16, w);
    new DataView(b.buffer).setUint32(20, h);
    return b;
  };
  /** A JPEG's start and frame header, padded to a length that can hold the size it declares. */
  const jpeg = (w: number, h: number) => {
    const head = [0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8];
    head.push(h >> 8, h & 255, w >> 8, w & 255, 3);
    const b = new Uint8Array(head.length + Math.ceil((w * h) / 64 / 4) + 64);
    b.set(head);
    return b;
  };
  const webp = (w: number, h: number) => {
    const b = new Uint8Array(30);
    b.set(enc.encode('RIFF'), 0);
    b.set(enc.encode('WEBPVP8X'), 8);
    const v = new DataView(b.buffer);
    v.setUint16(24, (w - 1) & 0xffff, true);
    b[26] = (w - 1) >> 16;
    v.setUint16(27, (h - 1) & 0xffff, true);
    b[29] = (h - 1) >> 16;
    return b;
  };
  const gif = (w: number, h: number) => {
    const b = new Uint8Array(13);
    b.set(enc.encode('GIF89a'), 0);
    new DataView(b.buffer).setUint16(6, w, true);
    new DataView(b.buffer).setUint16(8, h, true);
    return b;
  };

  it('reads the declared size of PNG, JPEG, GIF and WebP, and refuses past 64 million pixels', () => {
    expect(pictureRefusal(1000, pngDeclaring(8000, 6000))).toBeUndefined();
    expect(pictureRefusal(1000, pngDeclaring(30000, 20000))).toBe(
      'This picture is larger than we accept. It is 30,000 × 20,000 pixels; the most is 64 million pixels.',
    );
    expect(pictureRefusal(1000, jpeg(4000, 3000))).toBeUndefined();
    expect(pictureRefusal(1000, jpeg(12000, 9000))).toMatch(/12,000 × 9,000 pixels/);
    expect(pictureRefusal(1000, gif(640, 480))).toBeUndefined();
    expect(pictureRefusal(1000, webp(16383, 16383))).toMatch(/16,383 × 16,383 pixels/);
  });

  it('refuses a lying picture, one it can’t read, a format it doesn’t open, or a file over 64 MB', () => {
    expect(pictureRefusal(1000, pngDeclaring(30000, 30000, true))).toBe(
      'This picture can’t be read: it is damaged, or shorter than the size it declares.',
    );
    expect(pictureRefusal(1000, enc.encode('not a picture'))).toBe(
      'This picture can’t be read: it is damaged, or shorter than the size it declares.',
    );
    expect(pictureRefusal(1000, avifStart())).toBe(
      'This picture is an AVIF file, which we don’t open. Save it as PNG, JPEG or WebP and add it again.',
    );
    expect(pictureRefusal(65 * MB)).toBe(
      'This picture is larger than we accept. The file is 65 MB; the most is 64 MB.',
    );
  });
});

describe('Mochi2D’s refusals, said plainly', () => {
  it('a texture past a cap', () => {
    expect(
      describeLoadError(
        new TextureLimitError('t/a.png', 'side', 8192, 9000, 9000, 10),
        'This model',
      ),
    ).toEqual({
      problem: 'too-large',
      message:
        'This model is larger than we accept. Its texture “t/a.png” is 9,000 × 10 pixels; the most is 8,192 a side.',
    });
    expect(
      describeLoadError(
        new TextureLimitError('t/b.png', 'total', 2 ** 26, 68_157_440, 1024, 1024),
        'Their model',
      )?.message,
    ).toBe(
      'Their model is larger than we accept. Its textures come to 68,157,440 pixels; the most in all is 67,108,864.',
    );
  });

  it('a texture in a format it doesn’t open, or a damaged one', () => {
    const e = new TextureFormatError('t/a.png', 'x');
    expect(describeLoadError(e, 'This model', () => avifStart())).toEqual({
      problem: 'unsupported',
      message:
        'This model can’t be opened. Its texture “t/a.png” is an AVIF picture, which we don’t open. Save it as PNG and try again.',
    });
    expect(describeLoadError(e, 'This item', () => pngDeclaring(9, 9, true))).toEqual({
      problem: 'damaged',
      message:
        'This item can’t be opened. Its texture “t/a.png” isn’t a picture we can read: it is damaged, or shorter than the size it declares. Download or copy it again.',
    });
  });

  it('a file past a cap, a damaged .moc3, and anything else left alone', () => {
    expect(
      describeLoadError(new FileLimitError('m.moc3', 'file', 64 * MB, 70 * MB), 'This model')
        ?.message,
    ).toBe(
      'This model is larger than we accept. “m.moc3” is 70 MB; the most for one file is 64 MB.',
    );
    expect(describeLoadError(new MocFormatError('bad'), 'This model')?.problem).toBe('damaged');
    expect(describeLoadError(new Error('other'), 'This model')).toBeUndefined();
  });
});
