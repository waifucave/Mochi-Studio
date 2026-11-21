/**
 * The virtual camera's frame ring on Windows (docs/virtual-camera.md): a
 * named shared memory where the app writes NV12 frames and the camera reads
 * them, from another process (the DirectShow filter runs inside each app that
 * opens the camera; the Media Foundation source in the Frame Server).
 *
 * This is the layout's reference. native/wincam/src/ring.h mirrors it, and
 * the tests here exercise it on a plain buffer.
 *
 * - **The header** (64 bytes, little-endian 32-bit fields): magic, version,
 *   width, height, frames a second, format (the FourCC "NV12"), slot size,
 *   frame size, the sequence number of the latest whole frame, the writer's
 *   process id (0: nobody writes), and the time of the last write (a
 *   millisecond tick, to tell a writer that stopped without saying so).
 * - **Three slots,** each the size of the largest frame (1920 × 1080 NV12).
 *   Frame n goes to slot n mod 3, and the sequence number becomes n only
 *   after the frame is whole, so a reader that copies slot (seq mod 3) gets
 *   a whole frame unless the writer wrote two more meanwhile; it checks the
 *   sequence again after copying.
 */

export const RING_NAME = 'MochiStudioCamera';
/** Signalled after each frame. */
export const RING_EVENT_NAME = 'MochiStudioCameraFrame';
export const RING_MAGIC = 0x3143534d; // "MSC1"
export const RING_VERSION = 1;
export const RING_FOURCC_NV12 = 0x3231564e; // "NV12"
export const RING_HEADER = 64;
export const RING_SLOTS = 3;
/** The largest frame: 1920 × 1080 NV12. */
export const RING_SLOT_BYTES = (1920 * 1080 * 3) / 2;
export const RING_BYTES = RING_HEADER + RING_SLOTS * RING_SLOT_BYTES;
/** A writer that hasn't written for this long has stopped. */
export const RING_STALE_MS = 2000;

/** Byte offsets of the header's fields. */
export const RING_FIELD = {
  magic: 0,
  version: 4,
  width: 8,
  height: 12,
  fps: 16,
  fourcc: 20,
  slotBytes: 24,
  frameBytes: 28,
  sequence: 32,
  writerPid: 36,
  lastWriteMs: 40,
} as const;

export interface RingHeader {
  magic: number;
  version: number;
  width: number;
  height: number;
  fps: number;
  fourcc: number;
  slotBytes: number;
  frameBytes: number;
  sequence: number;
  writerPid: number;
  lastWriteMs: number;
}

export function readRingHeader(ring: Uint8Array): RingHeader {
  const v = new DataView(ring.buffer, ring.byteOffset, RING_HEADER);
  const out = {} as RingHeader;
  for (const [k, at] of Object.entries(RING_FIELD))
    out[k as keyof RingHeader] = v.getUint32(at, true);
  return out;
}

/** Starts writing at a size: the header, with no frame yet. */
export function openRing(
  ring: Uint8Array,
  width: number,
  height: number,
  fps: number,
  pid: number,
): void {
  const bytes = (width * height * 3) / 2;
  if (bytes > RING_SLOT_BYTES) throw new Error(`${width} × ${height} is larger than the ring.`);
  const v = new DataView(ring.buffer, ring.byteOffset, RING_HEADER);
  const set = (k: keyof typeof RING_FIELD, n: number) => v.setUint32(RING_FIELD[k], n >>> 0, true);
  set('magic', RING_MAGIC);
  set('version', RING_VERSION);
  set('width', width);
  set('height', height);
  set('fps', fps);
  set('fourcc', RING_FOURCC_NV12);
  set('slotBytes', RING_SLOT_BYTES);
  set('frameBytes', bytes);
  set('writerPid', pid);
}

/** Writes the next frame, then publishes it. Returns its sequence number. */
export function writeRingFrame(ring: Uint8Array, frame: Uint8Array, nowMs: number): number {
  const h = readRingHeader(ring);
  if (frame.length !== h.frameBytes)
    throw new Error(`a frame of ${frame.length} bytes for ${h.frameBytes}`);
  const next = (h.sequence + 1) >>> 0;
  ring.set(frame, RING_HEADER + (next % RING_SLOTS) * RING_SLOT_BYTES);
  const v = new DataView(ring.buffer, ring.byteOffset, RING_HEADER);
  v.setUint32(RING_FIELD.lastWriteMs, nowMs >>> 0, true);
  v.setUint32(RING_FIELD.sequence, next, true);
  return next;
}

/** The writer leaves: readers see nobody writes. */
export function closeRing(ring: Uint8Array): void {
  new DataView(ring.buffer, ring.byteOffset, RING_HEADER).setUint32(RING_FIELD.writerPid, 0, true);
}

/**
 * What a reader gets: the latest whole frame, or why there is none (nobody
 * writes, the writer stopped, or a frame changed while it was copied).
 */
export function readRingFrame(
  ring: Uint8Array,
  nowMs: number,
):
  | { frame: Uint8Array; width: number; height: number; sequence: number }
  | { none: 'empty' | 'no writer' | 'stale' | 'torn' } {
  const h = readRingHeader(ring);
  if (h.magic !== RING_MAGIC || h.version !== RING_VERSION || h.sequence === 0)
    return { none: 'empty' };
  if (!h.writerPid) return { none: 'no writer' };
  if ((nowMs - h.lastWriteMs) >>> 0 > RING_STALE_MS) return { none: 'stale' };
  const start = RING_HEADER + (h.sequence % RING_SLOTS) * RING_SLOT_BYTES;
  const frame = ring.slice(start, start + h.frameBytes);
  const after = readRingHeader(ring).sequence;
  if ((after - h.sequence) >>> 0 >= RING_SLOTS - 1) return { none: 'torn' };
  return { frame, width: h.width, height: h.height, sequence: h.sequence };
}
