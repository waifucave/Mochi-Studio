import Foundation
import XCTest

@testable import MochiCameraCore

/// The reference's test vectors (src/core/nv12.test.ts writes them).
struct Vector: Decodable {
  let width: Int
  let height: Int
  let under: UInt32
  let bgra: [UInt8]
  let nv12: [UInt8]
}

/// A sink whose buffers have longer rows than the frame, as pixel buffers may.
final class FakeBuffer: SinkBuffer {
  let width: Int
  let height: Int
  let lumaBytesPerRow: Int
  let chromaBytesPerRow: Int
  var luma: [UInt8]
  var chroma: [UInt8]
  init(width: Int, height: Int, padding: Int) {
    self.width = width
    self.height = height
    lumaBytesPerRow = width + padding
    chromaBytesPerRow = width + padding
    luma = [UInt8](repeating: 0xEE, count: lumaBytesPerRow * height)
    chroma = [UInt8](repeating: 0xEE, count: chromaBytesPerRow * height / 2)
  }
  func withPlanes(_ body: (UnsafeMutablePointer<UInt8>, UnsafeMutablePointer<UInt8>) throws -> Void)
    rethrows
  {
    try luma.withUnsafeMutableBufferPointer { l in
      try chroma.withUnsafeMutableBufferPointer { c in try body(l.baseAddress!, c.baseAddress!) }
    }
  }
}

final class FakeSink: FrameSink {
  var sent: [(FakeBuffer, UInt64)] = []
  let padding: Int
  init(padding: Int) { self.padding = padding }
  func makeBuffer(width: Int, height: Int) throws -> SinkBuffer {
    FakeBuffer(width: width, height: height, padding: padding)
  }
  func send(_ buffer: SinkBuffer, presentationNanos: UInt64) throws {
    sent.append((buffer as! FakeBuffer, presentationNanos))
  }
}

final class CoreTests: XCTestCase {
  func testConvertsExactlyAsTheReference() throws {
    let url = Bundle.module.url(forResource: "nv12-vectors", withExtension: "json")!
    let vectors = try JSONDecoder().decode([Vector].self, from: Data(contentsOf: url))
    XCTAssertEqual(vectors.count, 3)
    for v in vectors {
      let out = try bgraToNv12(v.bgra, width: v.width, height: v.height, under: v.under)
      XCTAssertEqual(out, v.nv12, "\(v.width) x \(v.height) over \(String(v.under, radix: 16))")
    }
  }

  func testGivesTheReferenceLevelsAndRefusesOddSizes() throws {
    let white = [UInt8](repeating: 255, count: 16)
    XCTAssertEqual(try bgraToNv12(white, width: 2, height: 2, under: 0), [235, 235, 235, 235, 128, 128])
    let clear = [UInt8](repeating: 0, count: 16)
    XCTAssertEqual(try bgraToNv12(clear, width: 2, height: 2, under: 0), [16, 16, 16, 16, 128, 128])
    XCTAssertThrowsError(try bgraToNv12(white, width: 3, height: 2, under: 0))
    XCTAssertThrowsError(try bgraToNv12(white, width: 2, height: 4, under: 0))
  }

  func testReadsFramesInPiecesOfAnySize() throws {
    let w = 4, h = 2
    let a = frameHeader(width: w, height: h) + (0..<12).map { UInt8($0) }
    let b = frameHeader(width: w, height: h) + (0..<12).map { UInt8(100 + $0) }
    let all = a + b
    let reader = FrameReader()
    var frames = [Frame]()
    // Seven bytes at a time: headers and frames split anywhere.
    for start in stride(from: 0, to: all.count, by: 7) {
      frames += try reader.add(Array(all[start..<min(start + 7, all.count)]))
    }
    XCTAssertEqual(frames.count, 2)
    XCTAssertEqual(frames[0], Frame(width: 4, height: 2, nv12: (0..<12).map { UInt8($0) }))
    XCTAssertEqual(frames[1].nv12.first, 100)
  }

  func testRefusesHeadersItCannotRead() {
    XCTAssertThrowsError(try FrameReader().add([UInt8](repeating: 0, count: 16))) { e in
      XCTAssertEqual(e as? FrameError, .badMagic(0))
    }
    XCTAssertThrowsError(try FrameReader().add(frameHeader(width: 3840, height: 2160))) { e in
      XCTAssertEqual(e as? FrameError, .badSize(width: 3840, height: 2160))
    }
    XCTAssertThrowsError(try FrameReader().add(frameHeader(width: 5, height: 2)))
  }

  func testWritesRowsIntoLongerRowsAndPresentsOnTheClock() throws {
    let sink = FakeSink(padding: 64)
    var clock: UInt64 = 1_000
    let writer = SinkWriter(sink: sink) { clock }
    let w = 8, h = 4
    let nv12 = (0..<(w * h * 3 / 2)).map { UInt8($0) }
    try writer.write(Frame(width: w, height: h, nv12: nv12))
    // The same time again: presented a nanosecond later, never twice at once.
    try writer.write(Frame(width: w, height: h, nv12: nv12))
    clock = 5_000
    try writer.write(Frame(width: w, height: h, nv12: nv12))
    XCTAssertEqual(sink.sent.map { $0.1 }, [1_000, 1_001, 5_000])
    XCTAssertEqual(writer.framesWritten, 3)
    let (buf, _) = sink.sent[0]
    for y in 0..<h {
      XCTAssertEqual(Array(buf.luma[(y * buf.lumaBytesPerRow)..<(y * buf.lumaBytesPerRow + w)]),
                     Array(nv12[(y * w)..<(y * w + w)]))
      // The padding is left alone.
      XCTAssertEqual(buf.luma[y * buf.lumaBytesPerRow + w], 0xEE)
    }
    for y in 0..<(h / 2) {
      let at = w * h + y * w
      XCTAssertEqual(Array(buf.chroma[(y * buf.chromaBytesPerRow)..<(y * buf.chromaBytesPerRow + w)]),
                     Array(nv12[at..<(at + w)]))
    }
  }

  func testRefusesAFrameOfTheWrongLength() {
    let writer = SinkWriter(sink: FakeSink(padding: 0)) { 1 }
    XCTAssertThrowsError(try writer.write(Frame(width: 4, height: 2, nv12: [1, 2, 3])))
  }
}
