/**
 * The macOS camera's helper (native/maccam), the parts without Electron: the
 * frames the app sends it on its standard input. Unit-tested alone.
 */

/** The header of a frame for the helper: "MSCF", width, height, flags (MochiCameraCore). */
export function helperFrameHeader(width: number, height: number): Buffer {
  const b = Buffer.alloc(16);
  b.writeUInt32LE(0x4643534d, 0);
  b.writeUInt32LE(width, 4);
  b.writeUInt32LE(height, 8);
  return b;
}
