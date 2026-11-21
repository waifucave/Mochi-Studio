// The virtual camera's pixel work on Windows:
// - BgraToNv12: premultiplied BGRA (or RGBA) over a color to NV12, exactly as
//   src/core/yuv.ts's premultipliedToNv12 (the reference; a test compares the
//   bytes);
// - Nv12Scale, Nv12ToYuy2, Nv12ToRgb32: what the cameras give apps that ask
//   for another size or format (nearest-neighbour scaling, BT.709 limited
//   range).
// Header-only, so the app's module and the camera DLLs share it.
#pragma once

#include <cstddef>
#include <cstdint>
#include <cstring>

namespace mochi {

// The same fixed-point weights as src/core/yuv.ts (x 2^16, rounded).
constexpr int32_t kS = 1 << 16;
constexpr int32_t Weight(double v) { return int32_t(v * kS + (v < 0 ? -0.5 : 0.5)); }
constexpr double kCk = 224.0 / 255.0;

inline void BgraToNv12(const uint8_t* src, int width, int height, uint32_t under, uint8_t* dst,
                       bool rgba) {
  const int32_t YR = Weight(0.2126 * 219 / 255), YG = Weight(0.7152 * 219 / 255),
                YB = Weight(0.0722 * 219 / 255);
  const int32_t UR = Weight(-0.2126 / 1.8556 * kCk), UG = Weight(-0.7152 / 1.8556 * kCk),
                UB = Weight(0.5 * kCk);
  const int32_t VR = Weight(0.5 * kCk), VG = Weight(-0.7152 / 1.5748 * kCk),
                VB = Weight(-0.0722 / 1.5748 * kCk);
  const int32_t ur = (under >> 16) & 255, ug = (under >> 8) & 255, ub = under & 255;
  const int ri = rgba ? 0 : 2, bi = rgba ? 2 : 0;
  int32_t tr[256], tg[256], tb[256];
  for (int a = 0; a < 256; a++) {
    tr[a] = (ur * (255 - a) + 127) / 255;
    tg[a] = (ug * (255 - a) + 127) / 255;
    tb[a] = (ub * (255 - a) + 127) / 255;
  }
  uint8_t* uv = dst + size_t(width) * height;
  for (int y = 0; y < height; y += 2) {
    for (int x = 0; x < width; x += 2) {
      int32_t r = 0, g = 0, b = 0;
      for (int k = 0; k < 4; k++) {
        size_t px = size_t(y + (k >> 1)) * width + x + (k & 1);
        const uint8_t* s = src + px * 4;
        int32_t pr = s[ri] + tr[s[3]], pg = s[1] + tg[s[3]], pb = s[bi] + tb[s[3]];
        dst[px] = uint8_t(16 + ((YR * pr + YG * pg + YB * pb + (kS >> 1)) >> 16));
        r += pr;
        g += pg;
        b += pb;
      }
      uint8_t* o = uv + size_t(y >> 1) * width + x;
      o[0] = uint8_t(128 + ((UR * r + UG * g + UB * b + (kS << 1)) >> 18));
      o[1] = uint8_t(128 + ((VR * r + VG * g + VB * b + (kS << 1)) >> 18));
    }
  }
}

// Black, in NV12: Y 16, Cb and Cr 128.
inline void Nv12Black(uint8_t* dst, int width, int height) {
  size_t y = size_t(width) * height;
  std::memset(dst, 16, y);
  std::memset(dst + y, 128, y / 2);
}

// NV12 of one size to NV12 of another (nearest neighbour; a copy when equal).
inline void Nv12Scale(const uint8_t* src, int sw, int sh, uint8_t* dst, int dw, int dh) {
  if (sw == dw && sh == dh) {
    std::memcpy(dst, src, size_t(sw) * sh * 3 / 2);
    return;
  }
  for (int y = 0; y < dh; y++) {
    const uint8_t* row = src + size_t(y * sh / dh) * sw;
    for (int x = 0; x < dw; x++) dst[size_t(y) * dw + x] = row[x * sw / dw];
  }
  const uint8_t* suv = src + size_t(sw) * sh;
  uint8_t* duv = dst + size_t(dw) * dh;
  for (int y = 0; y < dh / 2; y++) {
    const uint8_t* row = suv + size_t(y * (sh / 2) / (dh / 2)) * sw;
    for (int x = 0; x < dw / 2; x++) {
      int sx = x * (sw / 2) / (dw / 2);
      duv[size_t(y) * dw + 2 * x] = row[2 * sx];
      duv[size_t(y) * dw + 2 * x + 1] = row[2 * sx + 1];
    }
  }
}

// NV12 to YUY2 (4:2:2) of the same size: each chroma row serves two rows.
inline void Nv12ToYuy2(const uint8_t* src, int width, int height, uint8_t* dst) {
  const uint8_t* uv = src + size_t(width) * height;
  for (int y = 0; y < height; y++) {
    const uint8_t* yr = src + size_t(y) * width;
    const uint8_t* cr = uv + size_t(y >> 1) * width;
    uint8_t* o = dst + size_t(y) * width * 2;
    for (int x = 0; x < width; x += 2) {
      o[2 * x] = yr[x];
      o[2 * x + 1] = cr[x];
      o[2 * x + 2] = yr[x + 1];
      o[2 * x + 3] = cr[x + 1];
    }
  }
}

inline uint8_t Clamp8(int32_t v) { return uint8_t(v < 0 ? 0 : v > 255 ? 255 : v); }

// NV12 to RGB32 (B, G, R, 255), BT.709 limited range; bottom-up rows when asked
// (a positive height in a BITMAPINFOHEADER).
inline void Nv12ToRgb32(const uint8_t* src, int width, int height, uint8_t* dst, bool bottomUp) {
  // R = 1.164 (Y-16) + 1.793 (Cr-128); G = 1.164 (Y-16) - 0.213 (Cb-128) - 0.533 (Cr-128);
  // B = 1.164 (Y-16) + 2.112 (Cb-128): x 2^16.
  const int32_t KY = Weight(255.0 / 219), KRV = Weight(255.0 / 224 * 1.5748),
                KGU = Weight(255.0 / 224 * 0.0722 * 1.8556 / 0.7152),
                KGV = Weight(255.0 / 224 * 0.2126 * 1.5748 / 0.7152),
                KBU = Weight(255.0 / 224 * 1.8556);
  const uint8_t* uv = src + size_t(width) * height;
  for (int y = 0; y < height; y++) {
    const uint8_t* yr = src + size_t(y) * width;
    const uint8_t* cr = uv + size_t(y >> 1) * width;
    uint8_t* o = dst + size_t(bottomUp ? height - 1 - y : y) * width * 4;
    for (int x = 0; x < width; x++) {
      int32_t Y = (yr[x] - 16) * KY, U = cr[x & ~1] - 128, V = cr[(x & ~1) + 1] - 128;
      o[4 * x] = Clamp8((Y + KBU * U + (kS >> 1)) >> 16);
      o[4 * x + 1] = Clamp8((Y - KGU * U - KGV * V + (kS >> 1)) >> 16);
      o[4 * x + 2] = Clamp8((Y + KRV * V + (kS >> 1)) >> 16);
      o[4 * x + 3] = 255;
    }
  }
}

}  // namespace mochi
