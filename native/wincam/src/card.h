// The still card both Windows cameras show while Mochi Studio isn't sending
// (the DirectShow filter, the Media Foundation source): drawn with GDI, then
// made NV12.
#pragma once

#include <windows.h>

#include <cstdint>
#include <vector>

#include "frames.h"

namespace mochi {

inline std::vector<uint8_t> DrawCard(int width, int height) {
  std::vector<uint8_t> nv12(size_t(width) * height * 3 / 2);
  BITMAPINFO bi{};
  bi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  bi.bmiHeader.biWidth = width;
  bi.bmiHeader.biHeight = -height;  // top-down
  bi.bmiHeader.biPlanes = 1;
  bi.bmiHeader.biBitCount = 32;
  bi.bmiHeader.biCompression = BI_RGB;
  void* bits = nullptr;
  HDC dc = CreateCompatibleDC(nullptr);
  HBITMAP bmp = dc ? CreateDIBSection(dc, &bi, DIB_RGB_COLORS, &bits, nullptr, 0) : nullptr;
  if (!bmp || !bits) {
    if (dc) DeleteDC(dc);
    Nv12Black(nv12.data(), width, height);
    return nv12;
  }
  HGDIOBJ old = SelectObject(dc, bmp);
  RECT all = {0, 0, width, height};
  HBRUSH bg = CreateSolidBrush(RGB(0x22, 0x26, 0x33));
  FillRect(dc, &all, bg);
  DeleteObject(bg);
  SetBkMode(dc, TRANSPARENT);
  auto font = [&](int px, int weight) {
    return CreateFontW(-px, 0, 0, 0, weight, FALSE, FALSE, FALSE, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                       CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH | FF_SWISS, L"Segoe UI");
  };
  HFONT titleFont = font(height / 14, FW_SEMIBOLD), noteFont = font(height / 28, FW_NORMAL);
  RECT top = {0, height / 2 - height / 10, width, height / 2};
  RECT bottom = {0, height / 2 + height / 40, width, height / 2 + height / 8};
  SelectObject(dc, titleFont);
  SetTextColor(dc, RGB(0xf0, 0xf0, 0xf5));
  DrawTextW(dc, L"Mochi Studio isn’t sending", -1, &top, DT_CENTER | DT_BOTTOM | DT_SINGLELINE);
  SelectObject(dc, noteFont);
  SetTextColor(dc, RGB(0xa8, 0xad, 0xbd));
  DrawTextW(dc, L"Turn on the virtual camera in Mochi Studio’s Camera tab.", -1, &bottom,
            DT_CENTER | DT_TOP | DT_SINGLELINE);
  GdiFlush();
  // GDI leaves alpha at 0: the card is opaque.
  auto* px = static_cast<uint8_t*>(bits);
  for (size_t i = 0; i < size_t(width) * height; i++) px[i * 4 + 3] = 255;
  BgraToNv12(px, width, height, 0, nv12.data(), false);
  SelectObject(dc, old);
  DeleteObject(titleFont);
  DeleteObject(noteFont);
  DeleteObject(bmp);
  DeleteDC(dc);
  return nv12;
}

}  // namespace mochi
