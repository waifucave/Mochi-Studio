// The frames the app sends the helper on its standard input, and the writer
// that puts them into a sink: the extension's sink stream on a Mac, a fake one
// in the tests.
//
// Each frame: a 16-byte header (little-endian 32-bit fields: the magic
// "MSCF", width, height, flags), then the NV12 frame. The sizes are the
// camera's (16:9, at most 1920 x 1080), even.

public let frameMagic: UInt32 = 0x4643_534d  // "MSCF"
public let frameHeaderBytes = 16
public let largestFrame = (width: 1920, height: 1080)

public struct Frame: Equatable {
  public let width: Int
  public let height: Int
  public let nv12: [UInt8]
  public init(width: Int, height: Int, nv12: [UInt8]) {
    self.width = width
    self.height = height
    self.nv12 = nv12
  }
}

public enum FrameError: Error, Equatable {
  case badMagic(UInt32)
  case badSize(width: Int, height: Int)
}

/// The header of a frame of this size, for the app's side (and the tests).
public func frameHeader(width: Int, height: Int) -> [UInt8] {
  var out = [UInt8]()
  for v in [frameMagic, UInt32(width), UInt32(height), 0] {
    out += [UInt8(v & 255), UInt8((v >> 8) & 255), UInt8((v >> 16) & 255), UInt8(v >> 24)]
  }
  return out
}

/// Reads frames from the bytes as they come, in pieces of any size.
public final class FrameReader {
  private var pending = [UInt8]()
  public init() {}

  /// Adds bytes; returns the frames now whole. Throws on a header it can't read
  /// (the stream is then out of step: the helper stops).
  public func add(_ bytes: [UInt8]) throws -> [Frame] {
    pending += bytes
    var frames = [Frame]()
    while pending.count >= frameHeaderBytes {
      func u32(_ at: Int) -> UInt32 {
        UInt32(pending[at]) | UInt32(pending[at + 1]) << 8 | UInt32(pending[at + 2]) << 16
          | UInt32(pending[at + 3]) << 24
      }
      if u32(0) != frameMagic { throw FrameError.badMagic(u32(0)) }
      let w = Int(u32(4)), h = Int(u32(8))
      if w <= 0 || h <= 0 || w % 2 != 0 || h % 2 != 0 || w > largestFrame.width
        || h > largestFrame.height
      {
        throw FrameError.badSize(width: w, height: h)
      }
      let need = frameHeaderBytes + nv12Bytes(width: w, height: h)
      if pending.count < need { break }
      frames.append(Frame(width: w, height: h, nv12: Array(pending[frameHeaderBytes..<need])))
      pending.removeFirst(need)
    }
    return frames
  }
}

/// A buffer a sink gives for one frame: two planes, each with its own row length
/// (a pixel buffer's rows may be longer than the frame's).
public protocol SinkBuffer: AnyObject {
  var width: Int { get }
  var height: Int { get }
  var lumaBytesPerRow: Int { get }
  var chromaBytesPerRow: Int { get }
  /// The planes' memory, while the closure runs.
  func withPlanes(_ body: (UnsafeMutablePointer<UInt8>, UnsafeMutablePointer<UInt8>) throws -> Void)
    rethrows
}

/// Where frames go: the extension's sink stream, or a fake.
public protocol FrameSink: AnyObject {
  func makeBuffer(width: Int, height: Int) throws -> SinkBuffer
  /// Sends a filled buffer, presented at a host time in nanoseconds.
  func send(_ buffer: SinkBuffer, presentationNanos: UInt64) throws
}

/// Copies frames into the sink's buffers row by row, and presents them on the
/// host clock, never twice at the same time.
public final class SinkWriter {
  private let sink: FrameSink
  private let now: () -> UInt64
  private var last: UInt64 = 0
  public private(set) var framesWritten = 0

  public init(sink: FrameSink, now: @escaping () -> UInt64) {
    self.sink = sink
    self.now = now
  }

  public func write(_ frame: Frame) throws {
    let w = frame.width, h = frame.height
    if frame.nv12.count != nv12Bytes(width: w, height: h) {
      throw FrameError.badSize(width: w, height: h)
    }
    let buffer = try sink.makeBuffer(width: w, height: h)
    frame.nv12.withUnsafeBufferPointer { src in
      buffer.withPlanes { luma, chroma in
        for y in 0..<h {
          (luma + y * buffer.lumaBytesPerRow).update(from: src.baseAddress! + y * w, count: w)
        }
        let uv = src.baseAddress! + w * h
        for y in 0..<(h / 2) {
          (chroma + y * buffer.chromaBytesPerRow).update(from: uv + y * w, count: w)
        }
      }
    }
    var t = now()
    if t <= last { t = last + 1 }
    last = t
    try sink.send(buffer, presentationNanos: t)
    framesWritten += 1
  }
}
