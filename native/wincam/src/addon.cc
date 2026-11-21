// The virtual camera's Windows module for the app (docs/virtual-camera.md):
//
// - open(width, height, fps): creates the frame ring in the person's session
//   ("Local\", for the DirectShow camera) and, when the Frame Server has made
//   one ("Global\", for the Media Foundation camera), opens that too;
// - write(frame): one NV12 frame to the rings;
// - close(): readers see nobody writes;
// - convert(src, width, height, under, dst, rgba): premultiplied BGRA (or RGBA)
//   over the color `under` to NV12, exactly as src/core/yuv.ts does;
// - installed(): whether the DirectShow camera and the Media Foundation source
//   are registered (for every app, under HKLM), and the DLLs' paths;
// - peek(): the ring as a camera reads it (for tests);
// - mfStart(), mfStop(), mfState(): Windows 11's camera, made with
//   MFCreateVirtualCamera for this session and this person (no administrator
//   rights; its media source must be registered, which Install does);
// - mfDevices(), mfGrab(name, skip): the cameras Media Foundation lists, and one
//   NV12 frame read from one of them as an app reads it (for tests).
//
// Media Foundation is loaded when first used (GetProcAddress), so the module
// loads where it is missing (Windows 10, N editions).
//
// Plain Node-API (C), so one build loads in Electron and in Node.
#undef WINVER
#undef _WIN32_WINNT
#undef NTDDI_VERSION
#define WINVER 0x0A00
#define _WIN32_WINNT 0x0A00
#define NTDDI_VERSION 0x0A00000C  // for mfvirtualcamera.h (Windows 11's SDK)
#include <node_api.h>
#include <windows.h>
// After windows.h.
#include <mfapi.h>
#include <mferror.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <mfvirtualcamera.h>

#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "frames.h"
#include "ids.h"
#include "ring.h"

namespace {

mochi::RingWriter g_local;
mochi::RingWriter g_global;
uint32_t g_width = 0, g_height = 0, g_fps = 30;

#define CHECK(call)                                    \
  do {                                                 \
    if ((call) != napi_ok) {                           \
      napi_throw_error(env, nullptr, "Node-API failed"); \
      return nullptr;                                  \
    }                                                  \
  } while (0)

bool Args(napi_env env, napi_callback_info info, size_t want, napi_value* argv, size_t* got = nullptr) {
  size_t argc = 8;
  napi_value all[8];
  if (napi_get_cb_info(env, info, &argc, all, nullptr, nullptr) != napi_ok || argc < want) {
    napi_throw_type_error(env, nullptr, "Missing arguments");
    return false;
  }
  for (size_t i = 0; i < argc && i < 8; i++) argv[i] = all[i];
  if (got) *got = argc;
  return true;
}

bool I32(napi_env env, napi_value v, int32_t* out) {
  if (napi_get_value_int32(env, v, out) != napi_ok) {
    napi_throw_type_error(env, nullptr, "Expected a number");
    return false;
  }
  return true;
}

bool Bytes(napi_env env, napi_value v, uint8_t** data, size_t* len) {
  napi_typedarray_type t;
  napi_value ab;
  size_t off;
  if (napi_get_typedarray_info(env, v, &t, len, reinterpret_cast<void**>(data), &ab, &off) !=
          napi_ok ||
      t != napi_uint8_array) {
    napi_throw_type_error(env, nullptr, "Expected a Uint8Array");
    return false;
  }
  return true;
}

napi_value Bool(napi_env env, bool b) {
  napi_value r;
  napi_get_boolean(env, b, &r);
  return r;
}

napi_value U32(napi_env env, uint32_t n) {
  napi_value r;
  napi_create_uint32(env, n, &r);
  return r;
}

void Set(napi_env env, napi_value obj, const char* key, napi_value v) {
  napi_set_named_property(env, obj, key, v);
}

std::string Utf8(const wchar_t* w) {
  int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
  std::string s(n > 0 ? n - 1 : 0, '\0');
  if (n > 1) WideCharToMultiByte(CP_UTF8, 0, w, -1, s.data(), n, nullptr, nullptr);
  return s;
}

napi_value Open(napi_env env, napi_callback_info info) {
  napi_value argv[3];
  int32_t w, h, fps;
  if (!Args(env, info, 3, argv) || !I32(env, argv[0], &w) || !I32(env, argv[1], &h) ||
      !I32(env, argv[2], &fps))
    return nullptr;
  g_local.Close();
  g_global.Close();
  if (!g_local.Open(L"Local\\", true)) {
    char msg[120];
    std::snprintf(msg, sizeof msg, "The frame ring could not be made (error %lu).", GetLastError());
    napi_throw_error(env, nullptr, msg);
    return nullptr;
  }
  if (!g_local.Start(uint32_t(w), uint32_t(h), uint32_t(fps))) {
    g_local.Close();
    napi_throw_range_error(env, nullptr, "The size is odd or larger than 1920 x 1080.");
    return nullptr;
  }
  // The Media Foundation camera's ring, made by its source in the Frame Server.
  if (g_global.Open(L"Global\\", false)) g_global.Start(uint32_t(w), uint32_t(h), uint32_t(fps));
  g_width = uint32_t(w);
  g_height = uint32_t(h);
  g_fps = uint32_t(fps);
  napi_value r;
  CHECK(napi_create_object(env, &r));
  Set(env, r, "local", Bool(env, true));
  Set(env, r, "global", Bool(env, g_global.IsOpen()));
  return r;
}

napi_value Write(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  uint8_t* data;
  size_t len;
  if (!Args(env, info, 1, argv) || !Bytes(env, argv[0], &data, &len)) return nullptr;
  if (!g_local.IsOpen()) {
    napi_throw_error(env, nullptr, "The frame ring is not open.");
    return nullptr;
  }
  if (len != size_t(g_width) * g_height * 3 / 2) {
    napi_throw_range_error(env, nullptr, "The frame's size is not the ring's.");
    return nullptr;
  }
  uint32_t seq = g_local.Write(data, len);
  if (g_global.IsOpen()) g_global.Write(data, len);
  else if (g_global.Open(L"Global\\", false)) {
    // Made since: a Media Foundation camera started reading.
    g_global.Start(g_width, g_height, g_fps);
  }
  return U32(env, seq);
}

napi_value Close(napi_env, napi_callback_info) {
  g_local.Close();
  g_global.Close();
  g_width = g_height = 0;
  return nullptr;
}

napi_value Convert(napi_env env, napi_callback_info info) {
  napi_value argv[6];
  size_t argc = 0;
  int32_t w, h, under;
  uint8_t *src, *dst;
  size_t slen, dlen;
  if (!Args(env, info, 5, argv, &argc) || !Bytes(env, argv[0], &src, &slen) ||
      !I32(env, argv[1], &w) || !I32(env, argv[2], &h) || !I32(env, argv[3], &under) ||
      !Bytes(env, argv[4], &dst, &dlen))
    return nullptr;
  bool rgba = false;
  if (argc >= 6) napi_get_value_bool(env, argv[5], &rgba);
  if (w <= 0 || h <= 0 || (w & 1) || (h & 1)) {
    napi_throw_range_error(env, nullptr, "The width and height must be even.");
    return nullptr;
  }
  size_t n = size_t(w) * size_t(h);
  if (slen < n * 4 || dlen < n * 3 / 2) {
    napi_throw_range_error(env, nullptr, "A buffer is smaller than the frame.");
    return nullptr;
  }
  mochi::BgraToNv12(src, w, h, uint32_t(under), dst, rgba);
  return nullptr;
}

// The DLL registered for a class ID in the 64-bit or 32-bit registry view, or "".
std::wstring Registered(const wchar_t* clsid, REGSAM view) {
  std::wstring key = std::wstring(L"SOFTWARE\\Classes\\CLSID\\") + clsid + L"\\InprocServer32";
  wchar_t path[MAX_PATH * 2] = {0};
  DWORD bytes = sizeof path;
  if (RegGetValueW(HKEY_LOCAL_MACHINE, key.c_str(), nullptr, RRF_RT_REG_SZ | view, nullptr, path,
                   &bytes) != ERROR_SUCCESS)
    return L"";
  return path;
}

napi_value Installed(napi_env env, napi_callback_info) {
  std::wstring dll64 = Registered(mochi::kClsidDshowCameraString, RRF_SUBKEY_WOW6464KEY);
  std::wstring dll32 = Registered(mochi::kClsidDshowCameraString, RRF_SUBKEY_WOW6432KEY);
  napi_value r, s;
  CHECK(napi_create_object(env, &r));
  Set(env, r, "dshow", Bool(env, !dll64.empty()));
  CHECK(napi_create_string_utf8(env, Utf8(dll64.c_str()).c_str(), NAPI_AUTO_LENGTH, &s));
  Set(env, r, "dshowPath", s);
  Set(env, r, "dshow32", Bool(env, !dll32.empty()));
  CHECK(napi_create_string_utf8(env, Utf8(dll32.c_str()).c_str(), NAPI_AUTO_LENGTH, &s));
  Set(env, r, "dshow32Path", s);
  std::wstring mfDll = Registered(mochi::kClsidMfCameraString, RRF_SUBKEY_WOW6464KEY);
  Set(env, r, "mf", Bool(env, !mfDll.empty()));
  CHECK(napi_create_string_utf8(env, Utf8(mfDll.c_str()).c_str(), NAPI_AUTO_LENGTH, &s));
  Set(env, r, "mfPath", s);
  // Windows 11's virtual cameras (MFCreateVirtualCamera, in mfsensorgroup.dll).
  HMODULE m = LoadLibraryExW(L"mfsensorgroup.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
  bool mf = m && GetProcAddress(m, "MFCreateVirtualCamera");
  if (m) FreeLibrary(m);
  Set(env, r, "mfAvailable", Bool(env, mf));
  return r;
}

napi_value Peek(napi_env env, napi_callback_info) {
  static std::vector<uint8_t> buf(mochi::kRingSlotBytes);
  mochi::RingReader reader;
  napi_value r;
  CHECK(napi_create_object(env, &r));
  if (!reader.TryOpen(L"Local\\")) {
    Set(env, r, "open", Bool(env, false));
    return r;
  }
  Set(env, r, "open", Bool(env, true));
  uint32_t w = 0, h = 0;
  uint32_t seq = reader.Read(buf.data(), buf.size(), &w, &h);
  Set(env, r, "sequence", U32(env, seq));
  Set(env, r, "width", U32(env, w));
  Set(env, r, "height", U32(env, h));
  if (seq) {
    napi_value ab, arr;
    void* data;
    size_t bytes = size_t(w) * h * 3 / 2;
    CHECK(napi_create_arraybuffer(env, bytes, &data, &ab));
    std::memcpy(data, buf.data(), bytes);
    CHECK(napi_create_typedarray(env, napi_uint8_array, bytes, ab, 0, &arr));
    Set(env, r, "frame", arr);
  }
  return r;
}

// --- Media Foundation: Windows 11's virtual camera ---------------------------------

struct Mf {
  bool loaded = false;
  bool started = false;  // MFStartup done
  std::string problem;   // why it can't be used, when it can't
  decltype(&MFStartup) startup = nullptr;
  decltype(&MFCreateAttributes) createAttributes = nullptr;
  decltype(&MFCreateMediaType) createMediaType = nullptr;
  decltype(&MFEnumDeviceSources) enumDeviceSources = nullptr;
  decltype(&MFCreateSourceReaderFromMediaSource) createReader = nullptr;
  decltype(&MFCreateVirtualCamera) createVirtualCamera = nullptr;
};
Mf g_mf;
IMFVirtualCamera* g_camera = nullptr;
std::string g_cameraError;

template <class F>
bool Proc(const wchar_t* dll, const char* name, F* out) {
  HMODULE m = LoadLibraryExW(dll, nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
  if (!m) return false;
  *out = reinterpret_cast<F>(GetProcAddress(m, name));
  return *out != nullptr;
}

std::string Hr(const char* what, HRESULT hr) {
  char msg[160];
  std::snprintf(msg, sizeof msg, "%s failed (0x%08lX).", what, static_cast<unsigned long>(hr));
  return msg;
}

// Loads Media Foundation and starts it once. False, with g_mf.problem, when it can't.
bool LoadMf() {
  if (g_mf.loaded) return g_mf.problem.empty();
  g_mf.loaded = true;
  if (!Proc(L"mfplat.dll", "MFStartup", &g_mf.startup) ||
      !Proc(L"mfplat.dll", "MFCreateAttributes", &g_mf.createAttributes) ||
      !Proc(L"mfplat.dll", "MFCreateMediaType", &g_mf.createMediaType) ||
      !Proc(L"mf.dll", "MFEnumDeviceSources", &g_mf.enumDeviceSources) ||
      !Proc(L"mfreadwrite.dll", "MFCreateSourceReaderFromMediaSource", &g_mf.createReader)) {
    g_mf.problem = "Media Foundation isn't on this computer.";
    return false;
  }
  // Windows 11 (build 22000) and later.
  Proc(L"mfsensorgroup.dll", "MFCreateVirtualCamera", &g_mf.createVirtualCamera);
  HRESULT co = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  (void)co;  // already initialized in another mode (Electron's main thread): fine
  HRESULT hr = g_mf.startup(MF_VERSION, MFSTARTUP_FULL);
  if (FAILED(hr)) {
    g_mf.problem = Hr("MFStartup", hr);
    return false;
  }
  g_mf.started = true;
  return true;
}

napi_value Str(napi_env env, const std::string& s) {
  napi_value r;
  napi_create_string_utf8(env, s.c_str(), NAPI_AUTO_LENGTH, &r);
  return r;
}

napi_value MfState(napi_env env, napi_callback_info) {
  napi_value r;
  CHECK(napi_create_object(env, &r));
  bool ok = LoadMf();
  Set(env, r, "available", Bool(env, ok && g_mf.createVirtualCamera));
  if (!ok) Set(env, r, "problem", Str(env, g_mf.problem));
  else if (!g_mf.createVirtualCamera)
    Set(env, r, "problem", Str(env, "Windows 11's virtual cameras need build 22000 or later."));
  Set(env, r, "running", Bool(env, g_camera != nullptr));
  if (!g_cameraError.empty()) Set(env, r, "error", Str(env, g_cameraError));
  return r;
}

void StopCamera() {
  if (g_camera) {
    g_camera->Shutdown();
    g_camera->Release();
    g_camera = nullptr;
  }
}

// Makes the camera for this session and this person, and starts it. Its frames
// come from the source the Frame Server loads, which reads the Global ring.
napi_value MfStart(napi_env env, napi_callback_info info) {
  g_cameraError.clear();
  if (!g_camera) {
    if (!LoadMf() || !g_mf.createVirtualCamera) {
      g_cameraError = g_mf.problem.empty() ? "Windows 11's virtual cameras need build 22000 or later."
                                           : g_mf.problem;
    } else {
      IMFVirtualCamera* cam = nullptr;
      HRESULT hr = g_mf.createVirtualCamera(
          MFVirtualCameraType_SoftwareCameraSource, MFVirtualCameraLifetime_Session,
          MFVirtualCameraAccess_CurrentUser, mochi::kCameraName, mochi::kClsidMfCameraString, nullptr,
          0, &cam);
      if (FAILED(hr)) {
        g_cameraError = Hr("MFCreateVirtualCamera", hr);
      } else {
        hr = cam->Start(nullptr);
        if (FAILED(hr)) {
          g_cameraError = Hr("Starting the camera", hr);
          cam->Shutdown();
          cam->Release();
        } else {
          g_camera = cam;
        }
      }
    }
  }
  return MfState(env, info);
}

napi_value MfStop(napi_env env, napi_callback_info info) {
  StopCamera();
  g_cameraError.clear();
  return MfState(env, info);
}

// The video capture devices Media Foundation lists (activated by name below).
HRESULT VideoDevices(IMFActivate*** devices, UINT32* count) {
  IMFAttributes* a = nullptr;
  HRESULT hr = g_mf.createAttributes(&a, 1);
  if (SUCCEEDED(hr))
    hr = a->SetGUID(MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE, MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID);
  if (SUCCEEDED(hr)) hr = g_mf.enumDeviceSources(a, devices, count);
  if (a) a->Release();
  return hr;
}

std::string FriendlyName(IMFActivate* d) {
  wchar_t* name = nullptr;
  UINT32 len = 0;
  if (FAILED(d->GetAllocatedString(MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME, &name, &len))) return "";
  std::string s = Utf8(name);
  CoTaskMemFree(name);
  return s;
}

void FreeDevices(IMFActivate** devices, UINT32 count) {
  for (UINT32 i = 0; i < count; i++) devices[i]->Release();
  CoTaskMemFree(devices);
}

napi_value MfDevices(napi_env env, napi_callback_info) {
  napi_value list;
  CHECK(napi_create_array(env, &list));
  if (!LoadMf()) return list;
  IMFActivate** devices = nullptr;
  UINT32 count = 0;
  if (FAILED(VideoDevices(&devices, &count))) return list;
  for (UINT32 i = 0; i < count; i++) napi_set_element(env, list, i, Str(env, FriendlyName(devices[i])));
  FreeDevices(devices, count);
  return list;
}

// One NV12 frame from the camera named `name`, after `skip` frames, as a Media
// Foundation app reads it: {width, height, frame} or {error}.
napi_value MfGrab(napi_env env, napi_callback_info info) {
  napi_value argv[2];
  if (!Args(env, info, 2, argv)) return nullptr;
  size_t n = 0;
  char want[256] = {0};
  int32_t skip = 0;
  if (napi_get_value_string_utf8(env, argv[0], want, sizeof want, &n) != napi_ok ||
      !I32(env, argv[1], &skip))
    return nullptr;
  napi_value r;
  CHECK(napi_create_object(env, &r));
  auto fail = [&](const std::string& e) {
    Set(env, r, "error", Str(env, e));
    return r;
  };
  if (!LoadMf()) return fail(g_mf.problem);
  IMFActivate** devices = nullptr;
  UINT32 count = 0;
  HRESULT hr = VideoDevices(&devices, &count);
  if (FAILED(hr)) return fail(Hr("MFEnumDeviceSources", hr));
  IMFMediaSource* source = nullptr;
  std::string seen;
  for (UINT32 i = 0; i < count && !source; i++) {
    std::string name = FriendlyName(devices[i]);
    seen += (seen.empty() ? "" : ", ") + name;
    // Windows lists a virtual camera with " (Windows Virtual Camera)" after its name.
    if (name != want && name.rfind(std::string(want) + " (", 0) != 0) continue;
    hr = devices[i]->ActivateObject(IID_PPV_ARGS(&source));
    if (FAILED(hr)) source = nullptr;
  }
  FreeDevices(devices, count);
  if (!source)
    return fail(FAILED(hr) ? Hr("Activating the camera", hr)
                           : "No camera of that name (listed: " + (seen.empty() ? "none" : seen) + ").");
  IMFSourceReader* reader = nullptr;
  hr = g_mf.createReader(source, nullptr, &reader);
  if (FAILED(hr)) {
    source->Shutdown();
    source->Release();
    return fail(Hr("MFCreateSourceReaderFromMediaSource", hr));
  }
  const DWORD stream = DWORD(MF_SOURCE_READER_FIRST_VIDEO_STREAM);
  IMFMediaType* type = nullptr;
  UINT32 w = 0, h = 0;
  hr = reader->GetCurrentMediaType(stream, &type);
  if (SUCCEEDED(hr)) hr = MFGetAttributeSize(type, MF_MT_FRAME_SIZE, &w, &h);
  GUID sub = GUID_NULL;
  if (SUCCEEDED(hr)) hr = type->GetGUID(MF_MT_SUBTYPE, &sub);
  if (type) type->Release();
  IMFSample* sample = nullptr;
  for (int i = 0; SUCCEEDED(hr) && i <= skip; i++) {
    if (sample) {
      sample->Release();
      sample = nullptr;
    }
    DWORD flags = 0;
    LONGLONG ts = 0;
    hr = reader->ReadSample(stream, 0, nullptr, &flags, &ts, &sample);
    if (SUCCEEDED(hr) && (flags & MF_SOURCE_READERF_ERROR)) hr = E_FAIL;
    if (SUCCEEDED(hr) && !sample) i--;  // a gap: read again
  }
  std::vector<uint8_t> bytes;
  if (SUCCEEDED(hr) && sample) {
    IMFMediaBuffer* buf = nullptr;
    hr = sample->ConvertToContiguousBuffer(&buf);
    BYTE* data = nullptr;
    DWORD len = 0;
    if (SUCCEEDED(hr)) hr = buf->Lock(&data, nullptr, &len);
    if (SUCCEEDED(hr)) {
      bytes.assign(data, data + len);
      buf->Unlock();
    }
    if (buf) buf->Release();
  }
  if (sample) sample->Release();
  reader->Release();
  source->Shutdown();
  source->Release();
  if (FAILED(hr)) return fail(Hr("Reading a frame", hr));
  if (sub != MFVideoFormat_NV12) return fail("The camera's format isn't NV12.");
  Set(env, r, "width", U32(env, w));
  Set(env, r, "height", U32(env, h));
  napi_value ab, arr;
  void* data;
  CHECK(napi_create_arraybuffer(env, bytes.size(), &data, &ab));
  std::memcpy(data, bytes.data(), bytes.size());
  CHECK(napi_create_typedarray(env, napi_uint8_array, bytes.size(), ab, 0, &arr));
  Set(env, r, "frame", arr);
  return r;
}

napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor props[] = {
      {"open", nullptr, Open, nullptr, nullptr, nullptr, napi_enumerable, nullptr},
      {"write", nullptr, Write, nullptr, nullptr, nullptr, napi_enumerable, nullptr},
      {"close", nullptr, Close, nullptr, nullptr, nullptr, napi_enumerable, nullptr},
      {"convert", nullptr, Convert, nullptr, nullptr, nullptr, napi_enumerable, nullptr},
      {"installed", nullptr, Installed, nullptr, nullptr, nullptr, napi_enumerable, nullptr},
      {"peek", nullptr, Peek, nullptr, nullptr, nullptr, napi_enumerable, nullptr},
      {"mfState", nullptr, MfState, nullptr, nullptr, nullptr, napi_enumerable, nullptr},
      {"mfStart", nullptr, MfStart, nullptr, nullptr, nullptr, napi_enumerable, nullptr},
      {"mfStop", nullptr, MfStop, nullptr, nullptr, nullptr, napi_enumerable, nullptr},
      {"mfDevices", nullptr, MfDevices, nullptr, nullptr, nullptr, napi_enumerable, nullptr},
      {"mfGrab", nullptr, MfGrab, nullptr, nullptr, nullptr, napi_enumerable, nullptr},
  };
  napi_define_properties(env, exports, sizeof props / sizeof props[0], props);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
