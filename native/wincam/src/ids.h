// The class IDs of the two Windows cameras, and their name.
#pragma once

#include <windows.h>

namespace mochi {

constexpr wchar_t kCameraName[] = L"Mochi Studio Camera";

// The DirectShow source filter (mochi_camera_dshow.dll).
// {69823E65-D1F3-4109-B5AA-BA9E17744403}
constexpr GUID kClsidDshowCamera = {
    0x69823e65, 0xd1f3, 0x4109, {0xb5, 0xaa, 0xba, 0x9e, 0x17, 0x74, 0x44, 0x03}};
constexpr wchar_t kClsidDshowCameraString[] = L"{69823E65-D1F3-4109-B5AA-BA9E17744403}";

// The Media Foundation media source (mochi_camera_mf.dll).
// {2422A552-E4DF-4067-853F-4FF936501A63}
constexpr GUID kClsidMfCamera = {
    0x2422a552, 0xe4df, 0x4067, {0x85, 0x3f, 0x4f, 0xf9, 0x36, 0x50, 0x1a, 0x63}};
constexpr wchar_t kClsidMfCameraString[] = L"{2422A552-E4DF-4067-853F-4FF936501A63}";

}  // namespace mochi
