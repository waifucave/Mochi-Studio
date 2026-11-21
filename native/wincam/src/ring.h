// The virtual camera's frame ring on Windows: the layout of
// src/core/cameraRing.ts (the reference), as a C++ writer for the app's module
// and a reader for the cameras (the DirectShow filter, the Media Foundation
// source). Written from the Win32 file-mapping and event documentation.
#pragma once

#include <windows.h>

#include <cstdint>
#include <cstring>

namespace mochi {

constexpr uint32_t kRingMagic = 0x3143534d;  // "MSC1"
constexpr uint32_t kRingVersion = 1;
constexpr uint32_t kFourccNv12 = 0x3231564e;  // "NV12"
constexpr uint32_t kRingHeader = 64;
constexpr uint32_t kRingSlots = 3;
constexpr uint32_t kRingSlotBytes = 1920 * 1080 * 3 / 2;
constexpr uint64_t kRingBytes = kRingHeader + uint64_t(kRingSlots) * kRingSlotBytes;
constexpr uint32_t kRingStaleMs = 2000;

// The names: "Local\" for apps in the person's session (DirectShow);
// "Global\" for the Frame Server, which runs as a service (Media Foundation).
constexpr wchar_t kRingName[] = L"MochiStudioCamera";
constexpr wchar_t kRingEventName[] = L"MochiStudioCameraFrame";

#pragma pack(push, 1)
struct RingHeader {
  uint32_t magic;
  uint32_t version;
  uint32_t width;
  uint32_t height;
  uint32_t fps;
  uint32_t fourcc;
  uint32_t slotBytes;
  uint32_t frameBytes;
  volatile LONG sequence;
  volatile LONG writerPid;
  volatile LONG lastWriteMs;
  uint8_t reserved[20];
};
#pragma pack(pop)
static_assert(sizeof(RingHeader) == kRingHeader, "the header is 64 bytes");

inline uint8_t* RingSlot(void* base, uint32_t sequence) {
  return static_cast<uint8_t*>(base) + kRingHeader + uint64_t(sequence % kRingSlots) * kRingSlotBytes;
}

inline void Name(wchar_t* out, size_t n, const wchar_t* ns, const wchar_t* name) {
  wcscpy_s(out, n, ns);
  wcscat_s(out, n, name);
}

// The app's side: creates (or opens) the ring and its event, and writes frames.
class RingWriter {
 public:
  ~RingWriter() { Close(); }

  // Opens the ring in a namespace ("Local\" or "Global\"). False, with
  // GetLastError's code, when it can't.
  bool Open(const wchar_t* ns, bool create) {
    wchar_t name[96], event[96];
    Name(name, 96, ns, kRingName);
    Name(event, 96, ns, kRingEventName);
    if (create) {
      map_ = CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE,
                                DWORD(kRingBytes >> 32), DWORD(kRingBytes & 0xffffffff), name);
    } else {
      map_ = OpenFileMappingW(FILE_MAP_WRITE | FILE_MAP_READ, FALSE, name);
    }
    if (!map_) return false;
    base_ = MapViewOfFile(map_, FILE_MAP_WRITE | FILE_MAP_READ, 0, 0, SIZE_T(kRingBytes));
    if (!base_) {
      Close();
      return false;
    }
    event_ = create ? CreateEventW(nullptr, FALSE, FALSE, event)
                    : OpenEventW(EVENT_MODIFY_STATE | SYNCHRONIZE, FALSE, event);
    return true;
  }

  bool IsOpen() const { return base_ != nullptr; }

  // Starts writing at a size. False when the frame is larger than a slot.
  bool Start(uint32_t width, uint32_t height, uint32_t fps) {
    uint32_t bytes = width * height * 3 / 2;
    if (!base_ || bytes > kRingSlotBytes || (width & 1) || (height & 1)) return false;
    RingHeader* h = Header();
    h->magic = kRingMagic;
    h->version = kRingVersion;
    h->width = width;
    h->height = height;
    h->fps = fps;
    h->fourcc = kFourccNv12;
    h->slotBytes = kRingSlotBytes;
    h->frameBytes = bytes;
    MemoryBarrier();
    InterlockedExchange(&h->writerPid, LONG(GetCurrentProcessId()));
    return true;
  }

  // Writes the next frame and publishes it. Returns its sequence number (0 on a size mismatch).
  uint32_t Write(const uint8_t* frame, size_t bytes) {
    RingHeader* h = Header();
    if (!base_ || bytes != h->frameBytes) return 0;
    uint32_t next = uint32_t(h->sequence) + 1;
    std::memcpy(RingSlot(base_, next), frame, bytes);
    InterlockedExchange(&h->lastWriteMs, LONG(GetTickCount()));
    MemoryBarrier();
    InterlockedExchange(&h->sequence, LONG(next));
    if (event_) SetEvent(event_);
    return next;
  }

  // Readers see nobody writes (the mapping stays while a reader holds it).
  void Stop() {
    if (base_) InterlockedExchange(&Header()->writerPid, 0);
  }

  void Close() {
    Stop();
    if (base_) UnmapViewOfFile(base_);
    if (map_) CloseHandle(map_);
    if (event_) CloseHandle(event_);
    base_ = nullptr;
    map_ = event_ = nullptr;
  }

 private:
  RingHeader* Header() { return static_cast<RingHeader*>(base_); }
  HANDLE map_ = nullptr;
  HANDLE event_ = nullptr;
  void* base_ = nullptr;
};

// The camera's side: opens the ring when it exists, and copies the latest whole frame.
class RingReader {
 public:
  ~RingReader() { Close(); }

  // Opens the ring and its event when the app has made them; true when open.
  bool TryOpen(const wchar_t* ns) {
    if (base_) return true;
    wchar_t name[96], event[96];
    Name(name, 96, ns, kRingName);
    Name(event, 96, ns, kRingEventName);
    map_ = OpenFileMappingW(FILE_MAP_READ, FALSE, name);
    if (!map_) return false;
    base_ = MapViewOfFile(map_, FILE_MAP_READ, 0, 0, SIZE_T(kRingBytes));
    if (!base_) {
      Close();
      return false;
    }
    event_ = OpenEventW(SYNCHRONIZE, FALSE, event);
    return true;
  }

  // Waits up to `ms` for a new frame (when the event exists).
  void Wait(DWORD ms) {
    if (event_) WaitForSingleObject(event_, ms);
    else Sleep(ms);
  }

  // The size frames come in now; false when nobody writes.
  bool Size(uint32_t* width, uint32_t* height) const {
    const RingHeader* h = Header();
    if (!h || h->magic != kRingMagic || h->version != kRingVersion || !h->writerPid) return false;
    *width = h->width;
    *height = h->height;
    return true;
  }

  // Copies the latest whole frame (NV12) into `out`, which holds `capacity` bytes.
  // Returns its sequence number, or 0 when there is none (nobody writes, the writer
  // stopped, a frame larger than `out`, or one that changed while it was copied).
  uint32_t Read(uint8_t* out, size_t capacity, uint32_t* width, uint32_t* height) const {
    const RingHeader* h = Header();
    if (!h || h->magic != kRingMagic || h->version != kRingVersion) return 0;
    uint32_t seq = uint32_t(h->sequence);
    MemoryBarrier();
    if (!seq || !h->writerPid) return 0;
    if (uint32_t(GetTickCount() - uint32_t(h->lastWriteMs)) > kRingStaleMs) return 0;
    uint32_t w = h->width, hh = h->height, bytes = h->frameBytes;
    if (bytes != w * hh * 3 / 2 || bytes > capacity || bytes > kRingSlotBytes) return 0;
    std::memcpy(out, RingSlot(base_, seq), bytes);
    MemoryBarrier();
    if (uint32_t(h->sequence) - seq >= kRingSlots - 1) return 0;
    *width = w;
    *height = hh;
    return seq;
  }

  void Close() {
    if (base_) UnmapViewOfFile(base_);
    if (map_) CloseHandle(map_);
    if (event_) CloseHandle(event_);
    base_ = nullptr;
    map_ = event_ = nullptr;
  }

 private:
  const RingHeader* Header() const { return static_cast<const RingHeader*>(base_); }
  HANDLE map_ = nullptr;
  HANDLE event_ = nullptr;
  void* base_ = nullptr;
};

}  // namespace mochi
