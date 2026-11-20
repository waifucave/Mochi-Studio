/**
 * Items on the stage, with the familiar mouse conventions:
 *
 * - drop an item on the model to pin it (the log names the art mesh);
 * - double-click an item to lock it (a locked item cannot be dragged);
 * - Ctrl+click (Command+click on macOS) flips an unlocked item (Mochi2D's mirror);
 * - drag an item to the trash target, or off the window, to remove it;
 * - image files dropped on the stage become items.
 *
 * Double-clicking (or double-tapping) the stage elsewhere opens the main menu.
 */
import { imageItemFiles } from '../core/imageItem';
import { canvasPng, pngContext } from './canvasPng';
import { gifItem, isAnimatedGif } from './animatedItems';
import { MemoryFileSet } from '../core/modelFiles';
import type { MochiRuntime } from './mochiRuntime';
import type { Studio } from './studio';

export interface StageItemDeps {
  studio: Studio;
  runtime: MochiRuntime;
  stage: HTMLElement;
  trash: HTMLElement;
  notify(message: string, kind?: 'info' | 'error'): void;
  log(message: string, kind?: 'info' | 'error'): void;
  openMenu(): void;
  itemsLocked(): boolean;
}

const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp)$/;
const IMAGE_NAMES = /\.(png|jpe?g|gif|webp)$/i;
/** The largest texture side an image item gets. */
const MAX_SIDE = 2048;

export function isImageFile(f: File): boolean {
  return IMAGE_TYPES.test(f.type) || IMAGE_NAMES.test(f.name);
}

/**
 * Decodes an image (the browser's decoder; a GIF's first frame) and encodes
 * it as PNG, mirrored if asked, darkened by a black overlay of `dark` (0–1),
 * at most 2048 pixels a side.
 */
export async function toPng(
  blob: Blob,
  mirror: boolean,
  dark = 0,
): Promise<{ png: Uint8Array; width: number; height: number }> {
  const bmp = await createImageBitmap(blob);
  const k = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const width = Math.max(1, Math.round(bmp.width * k));
  const height = Math.max(1, Math.round(bmp.height * k));
  const c = new OffscreenCanvas(width, height);
  const g = pngContext(c);
  if (mirror) {
    g.translate(width, 0);
    g.scale(-1, 1);
  }
  g.drawImage(bmp, 0, 0, width, height);
  bmp.close();
  if (dark > 0) {
    // Black over the picture, keeping its transparency.
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-atop';
    g.fillStyle = `rgba(0, 0, 0, ${Math.min(1, dark)})`;
    g.fillRect(0, 0, width, height);
  }
  return { png: await canvasPng(c), width, height };
}

/** Adds an image file as an item (in the middle of the stage, ready to be pinned). */
export async function addImageItem(studio: Studio, file: File): Promise<string> {
  const name = file.name.replace(IMAGE_NAMES, '') || 'Image';
  // An animated GIF becomes an animated item; a still one, a picture.
  if (/\.gif$/i.test(file.name) || file.type === 'image/gif') {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (isAnimatedGif(bytes))
      return studio.addItem(new MemoryFileSet(name, (await gifItem(bytes, name)).files), {
        file: file.name,
      });
  }
  const { png, width, height } = await toPng(file, false);
  return studio.addItem(
    new MemoryFileSet(name, imageItemFiles(png, width, height, { name, flipped: false })),
    { file: file.name },
  );
}

/**
 * Flips an item horizontally about its anchor, image or model alike
 * (Mochi2D 0.7.0's `mirror`: its pin, hit tests and dragging follow).
 * Returns whether it is mirrored now.
 */
export function flipItem(studio: Studio, id: string): boolean {
  const on = !studio.isItemMirrored(id);
  studio.setItemMirror(id, on);
  return on;
}

export function installStageItems(d: StageItemDeps): void {
  const { studio, runtime, stage, trash } = d;
  const label = (id: string): string => studio.items.find((i) => i.id === id)?.label ?? id;
  const locked = (id: string): boolean =>
    d.itemsLocked() || !!studio.items.find((i) => i.id === id)?.locked;
  let drag: { id: string; over: boolean; out: boolean } | undefined;

  // Before Mochi2D's own item dragging (capture): locked items stay, Ctrl+click flips.
  stage.addEventListener(
    'pointerdown',
    (e) => {
      if (e.button !== 0) return;
      const id = runtime.itemAt(e.clientX, e.clientY);
      if (!id) return;
      if (locked(id)) {
        e.stopPropagation();
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        e.stopPropagation();
        flipItem(studio, id);
        d.notify(`Flipped “${label(id)}”.`);
        return;
      }
      drag = { id, over: false, out: false };
      trash.hidden = false;
      trash.dataset.over = 'false';
    },
    { capture: true },
  );
  addEventListener('pointermove', (e) => {
    if (!drag) return;
    const r = trash.getBoundingClientRect();
    drag.over =
      e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    drag.out =
      e.clientX <= 0 ||
      e.clientY <= 0 ||
      e.clientX >= innerWidth - 1 ||
      e.clientY >= innerHeight - 1;
    trash.dataset.over = String(drag.over || drag.out);
  });
  const end = (): void => {
    const g = drag;
    drag = undefined;
    trash.hidden = true;
    if (!g) return;
    if (g.over || g.out) {
      const name = label(g.id);
      studio.removeItem(g.id);
      d.notify(`Removed “${name}”.`);
      return;
    }
    // Dropped on the model: pinned there. Elsewhere: free.
    const was = studio.isItemPinned(g.id);
    const pinned = studio.pinItem(g.id, true);
    if (!pinned && was) studio.pinItem(g.id, false);
    if (pinned) {
      const mesh = runtime.itemPinMesh(g.id);
      d.log(`Pinned “${label(g.id)}” to the art mesh ${mesh ?? '(unknown)'}.`);
    }
  };
  addEventListener('pointerup', end);
  addEventListener('pointercancel', end);
  document.documentElement.addEventListener('pointerleave', () => {
    if (drag) drag.out = true;
  });

  // Double-click (or double-tap): lock an item, or open the main menu.
  const double = (x: number, y: number): void => {
    const id = runtime.itemAt(x, y);
    if (id) {
      const on = !studio.items.find((i) => i.id === id)?.locked;
      studio.setItemLocked(id, on);
      d.notify(on ? `Locked “${label(id)}”.` : `Unlocked “${label(id)}”.`);
    } else d.openMenu();
  };
  let lastDouble = 0;
  stage.addEventListener('dblclick', (e) => {
    if (e.target instanceof HTMLElement && e.target.closest('button, input, select, a')) return;
    lastDouble = performance.now();
    double(e.clientX, e.clientY);
  });
  let lastTap: { t: number; x: number; y: number } | undefined;
  stage.addEventListener('pointerup', (e) => {
    if (e.pointerType !== 'touch') return;
    const now = performance.now();
    if (
      lastTap &&
      now - lastTap.t < 350 &&
      Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30
    ) {
      lastTap = undefined;
      // Some browsers also send dblclick for a double tap.
      setTimeout(() => {
        if (performance.now() - lastDouble > 300) double(e.clientX, e.clientY);
      }, 0);
      return;
    }
    lastTap = { t: now, x: e.clientX, y: e.clientY };
  });
}
