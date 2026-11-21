// NV12 for the macOS camera: premultiplied BGRA (or RGBA) over a color to
// NV12, exactly as src/core/yuv.ts's premultipliedToNv12 (the reference; the
// tests compare with its vectors, test/fixtures/nv12-vectors.json). BT.709,
// limited range; each 2 x 2 block shares its Cb and Cr.

/// The same fixed-point weights as src/core/yuv.ts (x 2^16, rounded).
private let s: Int = 1 << 16
private func weight(_ v: Double) -> Int { Int(v * Double(s) + (v < 0 ? -0.5 : 0.5)) }
private let ck = 224.0 / 255.0
private let yr = weight(0.2126 * 219 / 255), yg = weight(0.7152 * 219 / 255),
  yb = weight(0.0722 * 219 / 255)
private let ur = weight(-0.2126 / 1.8556 * ck), ug = weight(-0.7152 / 1.8556 * ck),
  ub = weight(0.5 * ck)
private let vr = weight(0.5 * ck), vg = weight(-0.7152 / 1.5748 * ck),
  vb = weight(-0.0722 / 1.5748 * ck)

public enum Nv12Error: Error, Equatable {
  case oddSize(width: Int, height: Int)
  case tooSmall(have: Int, need: Int)
}

/// Bytes an NV12 frame of this size takes: the Y plane, then Cb and Cr at half size.
public func nv12Bytes(width: Int, height: Int) -> Int { width * height * 3 / 2 }

/// Converts premultiplied BGRA (or RGBA) pixels over `under` (0xRRGGBB) to NV12.
public func bgraToNv12(
  _ src: [UInt8], width: Int, height: Int, under: UInt32, rgba: Bool = false
) throws -> [UInt8] {
  if width % 2 != 0 || height % 2 != 0 { throw Nv12Error.oddSize(width: width, height: height) }
  if src.count < width * height * 4 {
    throw Nv12Error.tooSmall(have: src.count, need: width * height * 4)
  }
  let r0 = Int((under >> 16) & 255), g0 = Int((under >> 8) & 255), b0 = Int(under & 255)
  let ri = rgba ? 0 : 2, bi = rgba ? 2 : 0
  var tr = [Int](repeating: 0, count: 256), tg = tr, tb = tr
  for a in 0..<256 {
    tr[a] = (r0 * (255 - a) + 127) / 255
    tg[a] = (g0 * (255 - a) + 127) / 255
    tb[a] = (b0 * (255 - a) + 127) / 255
  }
  var out = [UInt8](repeating: 0, count: nv12Bytes(width: width, height: height))
  let uvStart = width * height
  for y in stride(from: 0, to: height, by: 2) {
    for x in stride(from: 0, to: width, by: 2) {
      var r = 0, g = 0, b = 0
      for k in 0..<4 {
        let px = (y + (k >> 1)) * width + x + (k & 1)
        let i = px * 4
        let a = Int(src[i + 3])
        let pr = Int(src[i + ri]) + tr[a], pg = Int(src[i + 1]) + tg[a], pb = Int(src[i + bi]) + tb[a]
        out[px] = UInt8(16 + ((yr * pr + yg * pg + yb * pb + (s >> 1)) >> 16))
        r += pr
        g += pg
        b += pb
      }
      let o = uvStart + (y >> 1) * width + x
      out[o] = UInt8(128 + ((ur * r + ug * g + ub * b + (s << 1)) >> 18))
      out[o + 1] = UInt8(128 + ((vr * r + vg * g + vb * b + (s << 1)) >> 18))
    }
  }
  return out
}

/// NV12 black: Y 16, Cb and Cr 128.
public func nv12Black(width: Int, height: Int) -> [UInt8] {
  var out = [UInt8](repeating: 128, count: nv12Bytes(width: width, height: height))
  for i in 0..<(width * height) { out[i] = 16 }
  return out
}
