import { describe, expect, it } from 'vitest';
import {
  closeRing,
  openRing,
  readRingFrame,
  readRingHeader,
  RING_BYTES,
  RING_FOURCC_NV12,
  RING_HEADER,
  RING_MAGIC,
  RING_SLOT_BYTES,
  writeRingFrame,
} from './cameraRing';

const frame = (bytes: number, value: number) => new Uint8Array(bytes).fill(value);

describe('the Windows camera’s frame ring', () => {
  it('holds three of the largest frames after a 64-byte header', () => {
    expect(RING_HEADER).toBe(64);
    expect(RING_SLOT_BYTES).toBe(1920 * 1080 * 1.5);
    expect(RING_BYTES).toBe(64 + 3 * RING_SLOT_BYTES);
    // "MSC1" and "NV12", little-endian.
    expect(Buffer.from(new Uint32Array([RING_MAGIC]).buffer).toString()).toBe('MSC1');
    expect(Buffer.from(new Uint32Array([RING_FOURCC_NV12]).buffer).toString()).toBe('NV12');
  });

  it('gives readers the latest whole frame, in turn through the slots', () => {
    const ring = new Uint8Array(RING_BYTES);
    expect(readRingFrame(ring, 0)).toEqual({ none: 'empty' });
    openRing(ring, 1280, 720, 30, 4242);
    const h = readRingHeader(ring);
    expect(h).toMatchObject({
      width: 1280,
      height: 720,
      fps: 30,
      frameBytes: 1382400,
      sequence: 0,
    });
    expect(h.writerPid).toBe(4242);
    for (let n = 1; n <= 4; n++) {
      expect(writeRingFrame(ring, frame(1382400, n), 1000 + n)).toBe(n);
      const r = readRingFrame(ring, 1000 + n);
      expect(r).toMatchObject({ width: 1280, height: 720, sequence: n });
      expect('frame' in r && r.frame[0] === n && r.frame[1382399] === n).toBe(true);
    }
    // Frame 4 went to slot 1, overwriting frame 1.
    expect(ring[RING_HEADER + RING_SLOT_BYTES]).toBe(4);
  });

  it('says when nobody writes, when the writer stopped, and refuses frames of the wrong size', () => {
    const ring = new Uint8Array(RING_BYTES);
    openRing(ring, 960, 540, 30, 7);
    writeRingFrame(ring, frame((960 * 540 * 3) / 2, 9), 5000);
    expect(readRingFrame(ring, 9000)).toEqual({ none: 'stale' });
    closeRing(ring);
    expect(readRingFrame(ring, 5000)).toEqual({ none: 'no writer' });
    expect(() => writeRingFrame(ring, frame(10, 0), 0)).toThrow(/bytes/);
    expect(() => openRing(ring, 3840, 2160, 30, 1)).toThrow(/larger/);
  });

  it('keeps working when the millisecond tick wraps around', () => {
    const ring = new Uint8Array(RING_BYTES);
    openRing(ring, 960, 540, 30, 7);
    writeRingFrame(ring, frame((960 * 540 * 3) / 2, 1), 0xffffff00);
    expect(readRingFrame(ring, 0x10)).toMatchObject({ sequence: 1 });
  });
});
