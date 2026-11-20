/**
 * Building animated items in the browser: an animated GIF (our
 * own decoder, src/core/gif.ts) or a folder of PNG frames (the browser's
 * decoder) is drawn frame by frame into texture atlases, which become the
 * item model's textures (src/core/animatedItem.ts).
 */
import {
  animatedItemFiles,
  DEFAULT_FOLDER_FPS,
  fpsFromDelays,
  MAX_DECODED_PIXELS,
  MAX_FRAMES,
  naturalCompare,
  planAtlas,
  varyingDelays,
  type AnimatedMarker,
} from '../core/animatedItem';
import { gifFrames, gifInfo } from '../core/gif';
import { canvasPng, pngContext } from './canvasPng';
/** Files to make an item of: a model file set, or a folder that has no model in it. */
export interface FrameSource {
  label: string;
  paths(): string[];
  read(path: string): Promise<Uint8Array>;
}

/** The largest GIF screen decoded (each side). */
const MAX_GIF_SIDE = 4096;

export interface AnimatedItemBuild {
  files: Array<[string, Uint8Array]>;
  frames: number;
  fps: number;
}

/** Lets the page draw now and then while many frames are decoded. */
const breathe = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Draws `count` frames into atlases with `draw(i, ctx, x, y, w, h)`, and encodes them as PNG. */
async function atlases(
  width: number,
  height: number,
  count: number,
  draw: (
    i: number,
    g: OffscreenCanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
  ) => Promise<void> | void,
): Promise<{ pngs: Uint8Array[]; layout: ReturnType<typeof planAtlas> }> {
  const layout = planAtlas(width, height, count);
  const canvases = layout.atlases.map((a) => new OffscreenCanvas(a.width, a.height));
  const ctxs = canvases.map((c) => {
    const g = pngContext(c);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    return g;
  });
  for (let i = 0; i < count; i++) {
    const f = layout.frames[i]!;
    await draw(i, ctxs[f.texture]!, f.x, f.y, layout.cellWidth, layout.cellHeight);
    if (i % 16 === 15) await breathe();
  }
  const pngs = await Promise.all(canvases.map(canvasPng));
  return { pngs, layout };
}

/** Whether these bytes are a GIF with more than one frame. */
export function isAnimatedGif(bytes: Uint8Array): boolean {
  return (gifInfo(bytes)?.frames ?? 0) > 1;
}

/** An animated item from a GIF with two or more frames (throws with a plain reason otherwise). */
export async function gifItem(bytes: Uint8Array, name: string): Promise<AnimatedItemBuild> {
  const info = gifInfo(bytes);
  if (!info) throw new Error('This is not a GIF file.');
  if (info.frames < 2) throw new Error('This GIF has only one frame.');
  if (info.frames > MAX_FRAMES) throw new Error(`A GIF may have at most ${MAX_FRAMES} frames.`);
  if (info.width > MAX_GIF_SIDE || info.height > MAX_GIF_SIDE)
    throw new Error(`A GIF may be at most ${MAX_GIF_SIDE} pixels a side.`);
  if (info.width * info.height * info.frames > MAX_DECODED_PIXELS)
    throw new Error('This GIF is too large to animate (too many frames for its size).');
  const screen = new OffscreenCanvas(info.width, info.height);
  const sg = screen.getContext('2d')!;
  const frames = gifFrames(bytes);
  const { pngs, layout } = await atlases(
    info.width,
    info.height,
    info.frames,
    (_i, g, x, y, w, h) => {
      const f = frames.next();
      if (f.done) return;
      sg.putImageData(new ImageData(f.value.rgba, info.width, info.height), 0, 0);
      g.drawImage(screen, 0, 0, info.width, info.height, x, y, w, h);
    },
  );
  const fps = fpsFromDelays(info.delays);
  const delays = varyingDelays(info.delays);
  const marker: AnimatedMarker = {
    name,
    flipped: false,
    source: 'gif',
    frames: info.frames,
    fps,
    ...(delays ? { delays } : {}),
  };
  return {
    files: animatedItemFiles(pngs, info.width, info.height, layout, marker),
    frames: info.frames,
    fps,
  };
}

/** The PNG frames of a folder that is not a model, in natural order; undefined for a model folder. */
export function framePaths(files: FrameSource): string[] | undefined {
  const paths = files.paths();
  if (paths.some((p) => /\.model3\.json$/i.test(p))) return undefined;
  const pngs = paths.filter((p) => /\.png$/i.test(p) && !/(^|\/)\./.test(p));
  return pngs.length ? pngs.sort(naturalCompare) : undefined;
}

/** An animated item from a folder of PNG frames, all shown at the first frame's size. */
export async function frameFolderItem(
  files: FrameSource,
  paths: readonly string[],
  name: string,
): Promise<AnimatedItemBuild> {
  if (paths.length < 2) throw new Error('A frame folder needs two or more PNG files.');
  if (paths.length > MAX_FRAMES)
    throw new Error(`A frame folder may have at most ${MAX_FRAMES} frames.`);
  const bitmap = async (p: string): Promise<ImageBitmap> =>
    createImageBitmap(
      new Blob([(await files.read(p)) as Uint8Array<ArrayBuffer>], { type: 'image/png' }),
    );
  const first = await bitmap(paths[0]!);
  const { width, height } = first;
  first.close();
  if (width * height * paths.length > MAX_DECODED_PIXELS)
    throw new Error('These frames are too large to animate (too many for their size).');
  const { pngs, layout } = await atlases(width, height, paths.length, async (i, g, x, y, w, h) => {
    const bmp = await bitmap(paths[i]!);
    g.drawImage(bmp, 0, 0, bmp.width, bmp.height, x, y, w, h);
    bmp.close();
  });
  const marker: AnimatedMarker = {
    name,
    flipped: false,
    source: 'folder',
    frames: paths.length,
    fps: DEFAULT_FOLDER_FPS,
  };
  return {
    files: animatedItemFiles(pngs, width, height, layout, marker),
    frames: paths.length,
    fps: DEFAULT_FOLDER_FPS,
  };
}
