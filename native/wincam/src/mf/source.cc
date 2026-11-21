// The virtual camera's Media Foundation media source (docs/virtual-camera.md,
// Windows 11): the COM class behind the camera Mochi Studio makes with
// MFCreateVirtualCamera. Windows' Camera Frame Server service loads it, not the
// app, and every Media Foundation or WinRT app (the Camera app, Teams, browsers)
// reads it through the Frame Server.
//
// Written from the Media Foundation interface documentation (mfidl.h, mfapi.h)
// and Microsoft's description of what a virtual camera's media source must
// implement:
//
// - the source: IMFMediaSourceEx (and so IMFMediaSource and
//   IMFMediaEventGenerator), IMFGetService and IKsControl (which supports no
//   property sets);
// - one stream: IMFMediaStream2, NV12 at 1280 x 720, 1920 x 1080 and 960 x 540
//   at 30 frames a second, with the attributes that make it a shared color
//   capture stream;
// - Start queues MENewStream (MEUpdatedStream on a later Start) and
//   MESourceStarted, then the stream's MEStreamStarted; Pause is refused (a live
//   source); each RequestSample is answered, on the frame interval, with an
//   MEMediaSample that carries the request's token.
//
// The frames: the ring of ../ring.h in the "Global\" namespace, which this
// source creates (the service may; a person's app may not) with a security
// descriptor that lets signed-in people's apps write it. Mochi Studio's module
// opens it and writes NV12 there. While nothing is sent, the still card of
// ../card.h.
#include <windows.h>
// After windows.h.
#include <initguid.h>
#include <ks.h>
#include <ksmedia.h>
#include <mfapi.h>
#include <mferror.h>
#include <mfidl.h>
#include <olectl.h>
#include <sddl.h>

#include <atomic>
#include <cstdint>
#include <cstring>
#include <deque>
#include <new>
#include <string>
#include <vector>

#include "../card.h"
#include "../frames.h"
#include "../ids.h"
#include "../ring.h"

namespace {

HMODULE g_module = nullptr;
std::atomic<long> g_objects{0};
std::atomic<long> g_locks{0};

// IKsControl, declared here: the headers declare it for user mode only
// alongside DirectShow's proxy (ksproxy.h). The same methods, in order.
const GUID kIidKsControl = {0x28f54685, 0x06fd, 0x11d2, {0xb2, 0x7a, 0x00, 0xa0, 0xc9, 0x22, 0x31, 0x96}};
struct KsControl : public IUnknown {
  virtual HRESULT STDMETHODCALLTYPE KsProperty(void* property, ULONG propertyLength, void* data,
                                               ULONG dataLength, ULONG* returned) = 0;
  virtual HRESULT STDMETHODCALLTYPE KsMethod(void* method, ULONG methodLength, void* data,
                                             ULONG dataLength, ULONG* returned) = 0;
  virtual HRESULT STDMETHODCALLTYPE KsEvent(void* event, ULONG eventLength, void* data,
                                            ULONG dataLength, ULONG* returned) = 0;
};

struct Size {
  UINT32 width, height;
};
constexpr Size kSizes[] = {{1280, 720}, {1920, 1080}, {960, 540}};
constexpr int kTypes = 3;
constexpr UINT32 kFps = 30;
constexpr LONGLONG kInterval = 10000000 / kFps;  // 100-ns units

// Who may use the ring: the system, the Frame Server (Local Service), and
// signed-in people's apps (interactive users and administrators); at medium
// integrity, so apps at medium integrity may write.
constexpr wchar_t kRingSddl[] =
    L"D:(A;;GA;;;SY)(A;;GA;;;LS)(A;;GRGWGX;;;IU)(A;;GRGWGX;;;BA)S:(ML;;NW;;;ME)";

class Lock {
 public:
  // A critical section that sets itself up and tears itself down.
  struct Section {
    Section() { InitializeCriticalSection(&cs); }
    ~Section() { DeleteCriticalSection(&cs); }
    Section(const Section&) = delete;
    CRITICAL_SECTION cs;
  };
  explicit Lock(Section& s) : cs_(s.cs) { EnterCriticalSection(&cs_); }
  explicit Lock(CRITICAL_SECTION& cs) : cs_(cs) { EnterCriticalSection(&cs_); }
  ~Lock() { LeaveCriticalSection(&cs_); }

 private:
  CRITICAL_SECTION& cs_;
};

template <class T>
void SafeRelease(T*& p) {
  if (p) {
    p->Release();
    p = nullptr;
  }
}

// The NV12 media type of a size, at 30 frames a second, BT.709 limited range
// (as Mochi Studio sends it).
HRESULT MakeType(Size s, IMFMediaType** out) {
  IMFMediaType* t = nullptr;
  HRESULT hr = MFCreateMediaType(&t);
  if (FAILED(hr)) return hr;
  UINT32 bytes = s.width * s.height * 3 / 2;
  if (SUCCEEDED(hr)) hr = t->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
  if (SUCCEEDED(hr)) hr = t->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_NV12);
  if (SUCCEEDED(hr)) hr = MFSetAttributeSize(t, MF_MT_FRAME_SIZE, s.width, s.height);
  if (SUCCEEDED(hr)) hr = MFSetAttributeRatio(t, MF_MT_FRAME_RATE, kFps, 1);
  if (SUCCEEDED(hr)) hr = MFSetAttributeRatio(t, MF_MT_PIXEL_ASPECT_RATIO, 1, 1);
  if (SUCCEEDED(hr)) hr = t->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
  if (SUCCEEDED(hr)) hr = t->SetUINT32(MF_MT_ALL_SAMPLES_INDEPENDENT, TRUE);
  if (SUCCEEDED(hr)) hr = t->SetUINT32(MF_MT_FIXED_SIZE_SAMPLES, TRUE);
  if (SUCCEEDED(hr)) hr = t->SetUINT32(MF_MT_SAMPLE_SIZE, bytes);
  if (SUCCEEDED(hr)) hr = t->SetUINT32(MF_MT_DEFAULT_STRIDE, s.width);
  if (SUCCEEDED(hr)) hr = t->SetUINT32(MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709);
  if (SUCCEEDED(hr)) hr = t->SetUINT32(MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235);
  if (SUCCEEDED(hr)) hr = t->SetUINT32(MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_BT709);
  if (SUCCEEDED(hr)) hr = t->SetUINT32(MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_709);
  if (FAILED(hr)) {
    t->Release();
    return hr;
  }
  *out = t;
  return S_OK;
}

// The attributes that make the stream a shared color capture stream.
HRESULT SetStreamAttributes(IMFAttributes* a) {
  HRESULT hr = a->SetGUID(MF_DEVICESTREAM_STREAM_CATEGORY, PINNAME_VIDEO_CAPTURE);
  if (SUCCEEDED(hr)) hr = a->SetUINT32(MF_DEVICESTREAM_STREAM_ID, 0);
  if (SUCCEEDED(hr)) hr = a->SetUINT32(MF_DEVICESTREAM_FRAMESERVER_SHARED, 1);
  if (SUCCEEDED(hr))
    hr = a->SetUINT32(MF_DEVICESTREAM_ATTRIBUTE_FRAMESOURCE_TYPES, MFFrameSourceTypes_Color);
  return hr;
}

// The frame ring, made here for the app to write (see the top of the file).
class SharedRing {
 public:
  SharedRing() = default;
  SharedRing(const SharedRing&) = delete;
  ~SharedRing() { Close(); }

  // Makes the ring (or opens it, if the app's module or another source made
  // it), then reads it. False when it can't.
  bool Open() {
    if (base_) return true;
    PSECURITY_DESCRIPTOR sd = nullptr;
    SECURITY_ATTRIBUTES sa{sizeof sa, nullptr, FALSE};
    if (ConvertStringSecurityDescriptorToSecurityDescriptorW(kRingSddl, SDDL_REVISION_1, &sd,
                                                             nullptr))
      sa.lpSecurityDescriptor = sd;
    wchar_t name[96], event[96];
    mochi::Name(name, 96, L"Global\\", mochi::kRingName);
    mochi::Name(event, 96, L"Global\\", mochi::kRingEventName);
    map_ = CreateFileMappingW(INVALID_HANDLE_VALUE, &sa, PAGE_READWRITE,
                              DWORD(mochi::kRingBytes >> 32), DWORD(mochi::kRingBytes & 0xffffffff),
                              name);
    if (map_) event_ = CreateEventW(&sa, FALSE, FALSE, event);
    if (sd) LocalFree(sd);
    if (!map_) return false;
    base_ = MapViewOfFile(map_, FILE_MAP_READ, 0, 0, SIZE_T(mochi::kRingBytes));
    if (!base_) {
      Close();
      return false;
    }
    return true;
  }

  // The latest whole frame, as mochi::RingReader::Read gives it.
  uint32_t Read(uint8_t* out, size_t capacity, uint32_t* w, uint32_t* h) {
    if (!base_) return 0;
    const auto* hd = static_cast<const mochi::RingHeader*>(base_);
    if (hd->magic != mochi::kRingMagic || hd->version != mochi::kRingVersion) return 0;
    uint32_t seq = uint32_t(hd->sequence);
    MemoryBarrier();
    if (!seq || !hd->writerPid) return 0;
    if (uint32_t(GetTickCount() - uint32_t(hd->lastWriteMs)) > mochi::kRingStaleMs) return 0;
    uint32_t fw = hd->width, fh = hd->height, bytes = hd->frameBytes;
    if (bytes != fw * fh * 3 / 2 || bytes > capacity || bytes > mochi::kRingSlotBytes) return 0;
    std::memcpy(out, mochi::RingSlot(base_, seq), bytes);
    MemoryBarrier();
    if (uint32_t(hd->sequence) - seq >= mochi::kRingSlots - 1) return 0;
    *w = fw;
    *h = fh;
    return seq;
  }

  // Whether someone writes now (a torn read keeps the last frame, not the card).
  bool Writing() const {
    if (!base_) return false;
    const auto* hd = static_cast<const mochi::RingHeader*>(base_);
    return hd->magic == mochi::kRingMagic && hd->writerPid &&
           uint32_t(GetTickCount() - uint32_t(hd->lastWriteMs)) <= mochi::kRingStaleMs;
  }

  void Close() {
    if (base_) UnmapViewOfFile(base_);
    if (map_) CloseHandle(map_);
    if (event_) CloseHandle(event_);
    base_ = nullptr;
    map_ = event_ = nullptr;
  }

 private:
  HANDLE map_ = nullptr;
  HANDLE event_ = nullptr;
  void* base_ = nullptr;
};

class Source;

// --- the stream ---------------------------------------------------------------------

class Stream final : public IMFMediaStream2 {
 public:
  Stream(Source* source, IMFStreamDescriptor* sd);
  HRESULT Init();

  // IUnknown
  STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override;
  STDMETHODIMP_(ULONG) AddRef() override { return ++refs_; }
  STDMETHODIMP_(ULONG) Release() override {
    long n = --refs_;
    if (n == 0) delete this;
    return ULONG(n);
  }

  // IMFMediaEventGenerator
  STDMETHODIMP GetEvent(DWORD flags, IMFMediaEvent** event) override;
  STDMETHODIMP BeginGetEvent(IMFAsyncCallback* cb, IUnknown* state) override;
  STDMETHODIMP EndGetEvent(IMFAsyncResult* result, IMFMediaEvent** event) override;
  STDMETHODIMP QueueEvent(MediaEventType type, REFGUID ext, HRESULT status,
                          const PROPVARIANT* value) override;

  // IMFMediaStream
  STDMETHODIMP GetMediaSource(IMFMediaSource** out) override;
  STDMETHODIMP GetStreamDescriptor(IMFStreamDescriptor** out) override;
  STDMETHODIMP RequestSample(IUnknown* token) override;

  // IMFMediaStream2
  STDMETHODIMP SetStreamState(MF_STREAM_STATE value) override;
  STDMETHODIMP GetStreamState(MF_STREAM_STATE* value) override;

  // For the source.
  HRESULT Begin(IMFMediaType* type, const PROPVARIANT* start);
  void End(bool queueStopped);
  void Shutdown();

 private:
  ~Stream();
  static DWORD WINAPI ThreadMain(void* self) {
    static_cast<Stream*>(self)->Deliver();
    return 0;
  }
  void Deliver();
  HRESULT MakeSample(IMFSample** out);
  void StopThread();

  std::atomic<long> refs_{1};
  CRITICAL_SECTION lock_;
  Source* source_;  // held (released at Shutdown)
  IMFStreamDescriptor* sd_;
  IMFMediaEventQueue* queue_ = nullptr;
  MF_STREAM_STATE state_ = MF_STREAM_STATE_STOPPED;
  bool shutdown_ = false;
  Size size_ = kSizes[0];
  std::deque<IUnknown*> tokens_;  // the requests not answered yet (null for none)
  HANDLE wake_ = nullptr;
  HANDLE quit_ = nullptr;
  HANDLE thread_ = nullptr;
  SharedRing ring_;
  std::vector<uint8_t> latest_;
  bool haveLatest_ = false;
  uint32_t latestW_ = 0, latestH_ = 0;
  std::vector<uint8_t> card_;
  Size cardSize_ = {0, 0};
};

// --- the source ---------------------------------------------------------------------

class Source final : public IMFMediaSourceEx, public IMFGetService, public KsControl {
 public:
  Source() {
    InitializeCriticalSection(&lock_);
    g_objects++;
  }
  HRESULT Init();

  // IUnknown
  STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override;
  STDMETHODIMP_(ULONG) AddRef() override { return ++refs_; }
  STDMETHODIMP_(ULONG) Release() override {
    long n = --refs_;
    if (n == 0) delete this;
    return ULONG(n);
  }

  // IMFMediaEventGenerator
  STDMETHODIMP GetEvent(DWORD flags, IMFMediaEvent** event) override;
  STDMETHODIMP BeginGetEvent(IMFAsyncCallback* cb, IUnknown* state) override;
  STDMETHODIMP EndGetEvent(IMFAsyncResult* result, IMFMediaEvent** event) override;
  STDMETHODIMP QueueEvent(MediaEventType type, REFGUID ext, HRESULT status,
                          const PROPVARIANT* value) override;

  // IMFMediaSource
  STDMETHODIMP GetCharacteristics(DWORD* out) override;
  STDMETHODIMP CreatePresentationDescriptor(IMFPresentationDescriptor** out) override;
  STDMETHODIMP Start(IMFPresentationDescriptor* pd, const GUID* format,
                     const PROPVARIANT* start) override;
  STDMETHODIMP Stop() override;
  STDMETHODIMP Pause() override { return MF_E_INVALID_STATE_TRANSITION; }
  STDMETHODIMP Shutdown() override;

  // IMFMediaSourceEx
  STDMETHODIMP GetSourceAttributes(IMFAttributes** out) override;
  STDMETHODIMP GetStreamAttributes(DWORD id, IMFAttributes** out) override;
  STDMETHODIMP SetD3DManager(IUnknown*) override { return S_OK; }  // frames are in memory

  // IMFGetService
  STDMETHODIMP GetService(REFGUID, REFIID, void** ppv) override {
    if (ppv) *ppv = nullptr;
    return MF_E_UNSUPPORTED_SERVICE;
  }

  // IKsControl: no property sets, methods or events.
  STDMETHODIMP KsProperty(void*, ULONG, void*, ULONG, ULONG* returned) override {
    if (returned) *returned = 0;
    return HRESULT_FROM_WIN32(ERROR_SET_NOT_FOUND);
  }
  STDMETHODIMP KsMethod(void*, ULONG, void*, ULONG, ULONG* returned) override {
    if (returned) *returned = 0;
    return HRESULT_FROM_WIN32(ERROR_SET_NOT_FOUND);
  }
  STDMETHODIMP KsEvent(void*, ULONG, void*, ULONG, ULONG* returned) override {
    if (returned) *returned = 0;
    return HRESULT_FROM_WIN32(ERROR_SET_NOT_FOUND);
  }

 private:
  ~Source() {
    Shutdown();
    DeleteCriticalSection(&lock_);
    g_objects--;
  }
  HRESULT Check() const { return shutdown_ ? MF_E_SHUTDOWN : S_OK; }

  std::atomic<long> refs_{1};
  CRITICAL_SECTION lock_;
  bool shutdown_ = false;
  bool started_ = false;
  bool announced_ = false;  // MENewStream sent once; MEUpdatedStream after
  IMFMediaEventQueue* queue_ = nullptr;
  IMFAttributes* attrs_ = nullptr;
  IMFAttributes* streamAttrs_ = nullptr;
  IMFPresentationDescriptor* pd_ = nullptr;
  Stream* stream_ = nullptr;
};

HRESULT Source::Init() {
  HRESULT hr = MFCreateEventQueue(&queue_);
  if (SUCCEEDED(hr)) hr = MFCreateAttributes(&attrs_, 1);
  if (SUCCEEDED(hr)) hr = MFCreateAttributes(&streamAttrs_, 4);
  if (SUCCEEDED(hr)) hr = SetStreamAttributes(streamAttrs_);
  IMFMediaType* types[kTypes] = {};
  for (int i = 0; SUCCEEDED(hr) && i < kTypes; i++) hr = MakeType(kSizes[i], &types[i]);
  IMFStreamDescriptor* sd = nullptr;
  if (SUCCEEDED(hr)) hr = MFCreateStreamDescriptor(0, kTypes, types, &sd);
  if (SUCCEEDED(hr)) hr = streamAttrs_->CopyAllItems(sd);
  IMFMediaTypeHandler* handler = nullptr;
  if (SUCCEEDED(hr)) hr = sd->GetMediaTypeHandler(&handler);
  if (SUCCEEDED(hr)) hr = handler->SetCurrentMediaType(types[0]);
  SafeRelease(handler);
  if (SUCCEEDED(hr)) hr = MFCreatePresentationDescriptor(1, &sd, &pd_);
  if (SUCCEEDED(hr)) hr = pd_->SelectStream(0);
  if (SUCCEEDED(hr)) {
    stream_ = new (std::nothrow) Stream(this, sd);
    hr = stream_ ? stream_->Init() : E_OUTOFMEMORY;
  }
  SafeRelease(sd);
  for (auto*& t : types) SafeRelease(t);
  return hr;
}

STDMETHODIMP Source::QueryInterface(REFIID riid, void** ppv) {
  if (!ppv) return E_POINTER;
  if (riid == IID_IUnknown || riid == IID_IMFMediaEventGenerator || riid == IID_IMFMediaSource ||
      riid == IID_IMFMediaSourceEx)
    *ppv = static_cast<IMFMediaSourceEx*>(this);
  else if (riid == IID_IMFGetService)
    *ppv = static_cast<IMFGetService*>(this);
  else if (riid == kIidKsControl)
    *ppv = static_cast<KsControl*>(this);
  else {
    *ppv = nullptr;
    return E_NOINTERFACE;
  }
  AddRef();
  return S_OK;
}

STDMETHODIMP Source::GetEvent(DWORD flags, IMFMediaEvent** event) {
  IMFMediaEventQueue* q;
  {
    Lock l(lock_);
    if (FAILED(Check())) return MF_E_SHUTDOWN;
    q = queue_;
    q->AddRef();
  }
  // Outside the lock: GetEvent may block.
  HRESULT hr = q->GetEvent(flags, event);
  q->Release();
  return hr;
}

STDMETHODIMP Source::BeginGetEvent(IMFAsyncCallback* cb, IUnknown* state) {
  Lock l(lock_);
  if (FAILED(Check())) return MF_E_SHUTDOWN;
  return queue_->BeginGetEvent(cb, state);
}

STDMETHODIMP Source::EndGetEvent(IMFAsyncResult* result, IMFMediaEvent** event) {
  Lock l(lock_);
  if (FAILED(Check())) return MF_E_SHUTDOWN;
  return queue_->EndGetEvent(result, event);
}

STDMETHODIMP Source::QueueEvent(MediaEventType type, REFGUID ext, HRESULT status,
                                const PROPVARIANT* value) {
  Lock l(lock_);
  if (FAILED(Check())) return MF_E_SHUTDOWN;
  return queue_->QueueEventParamVar(type, ext, status, value);
}

STDMETHODIMP Source::GetCharacteristics(DWORD* out) {
  if (!out) return E_POINTER;
  Lock l(lock_);
  if (FAILED(Check())) return MF_E_SHUTDOWN;
  *out = MFMEDIASOURCE_IS_LIVE;
  return S_OK;
}

STDMETHODIMP Source::CreatePresentationDescriptor(IMFPresentationDescriptor** out) {
  if (!out) return E_POINTER;
  Lock l(lock_);
  if (FAILED(Check())) return MF_E_SHUTDOWN;
  return pd_->Clone(out);
}

STDMETHODIMP Source::Start(IMFPresentationDescriptor* pd, const GUID* format,
                           const PROPVARIANT* start) {
  if (!pd || !start) return E_INVALIDARG;
  if (format && *format != GUID_NULL) return MF_E_UNSUPPORTED_TIME_FORMAT;
  if (start->vt != VT_EMPTY && start->vt != VT_I8) return MF_E_UNSUPPORTED_TIME_FORMAT;
  Lock l(lock_);
  if (FAILED(Check())) return MF_E_SHUTDOWN;
  // The stream must be selected, with one of this camera's types.
  BOOL selected = FALSE;
  IMFStreamDescriptor* sd = nullptr;
  HRESULT hr = pd->GetStreamDescriptorByIndex(0, &selected, &sd);
  if (FAILED(hr)) return hr;
  IMFMediaTypeHandler* handler = nullptr;
  IMFMediaType* type = nullptr;
  hr = sd->GetMediaTypeHandler(&handler);
  if (SUCCEEDED(hr)) hr = handler->GetCurrentMediaType(&type);
  SafeRelease(handler);
  SafeRelease(sd);
  if (FAILED(hr)) return hr;
  if (!selected) {
    type->Release();
    return MF_E_INVALIDREQUEST;
  }
  // A live source starts now, whatever position was asked.
  PROPVARIANT now;
  PropVariantInit(&now);
  now.vt = VT_I8;
  now.hVal.QuadPart = MFGetSystemTime();
  hr = queue_->QueueEventParamUnk(announced_ ? MEUpdatedStream : MENewStream, GUID_NULL, S_OK,
                                  static_cast<IMFMediaStream*>(stream_));
  if (SUCCEEDED(hr)) hr = queue_->QueueEventParamVar(MESourceStarted, GUID_NULL, S_OK, &now);
  if (SUCCEEDED(hr)) hr = stream_->Begin(type, &now);
  type->Release();
  if (SUCCEEDED(hr)) {
    announced_ = true;
    started_ = true;
  }
  return hr;
}

STDMETHODIMP Source::Stop() {
  Lock l(lock_);
  if (FAILED(Check())) return MF_E_SHUTDOWN;
  stream_->End(true);
  started_ = false;
  return queue_->QueueEventParamVar(MESourceStopped, GUID_NULL, S_OK, nullptr);
}

STDMETHODIMP Source::Shutdown() {
  Stream* stream;
  {
    Lock l(lock_);
    if (shutdown_) return MF_E_SHUTDOWN;
    shutdown_ = true;
    if (queue_) queue_->Shutdown();
    stream = stream_;
    stream_ = nullptr;
  }
  // The stream lets go of the source here, outside the lock.
  if (stream) {
    stream->Shutdown();
    stream->Release();
  }
  SafeRelease(queue_);
  SafeRelease(attrs_);
  SafeRelease(streamAttrs_);
  SafeRelease(pd_);
  return S_OK;
}

STDMETHODIMP Source::GetSourceAttributes(IMFAttributes** out) {
  if (!out) return E_POINTER;
  Lock l(lock_);
  if (FAILED(Check())) return MF_E_SHUTDOWN;
  *out = attrs_;
  attrs_->AddRef();
  return S_OK;
}

STDMETHODIMP Source::GetStreamAttributes(DWORD id, IMFAttributes** out) {
  if (!out) return E_POINTER;
  Lock l(lock_);
  if (FAILED(Check())) return MF_E_SHUTDOWN;
  if (id != 0) return MF_E_INVALIDSTREAMNUMBER;
  *out = streamAttrs_;
  streamAttrs_->AddRef();
  return S_OK;
}

// --- the stream's methods ------------------------------------------------------------

Stream::Stream(Source* source, IMFStreamDescriptor* sd) : source_(source), sd_(sd) {
  InitializeCriticalSection(&lock_);
  source_->AddRef();
  sd_->AddRef();
  g_objects++;
}

Stream::~Stream() {
  Shutdown();
  for (IUnknown* t : tokens_)
    if (t) t->Release();
  if (wake_) CloseHandle(wake_);
  if (quit_) CloseHandle(quit_);
  SafeRelease(sd_);
  DeleteCriticalSection(&lock_);
  g_objects--;
}

HRESULT Stream::Init() {
  HRESULT hr = MFCreateEventQueue(&queue_);
  if (FAILED(hr)) return hr;
  wake_ = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  quit_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (!wake_ || !quit_) return HRESULT_FROM_WIN32(GetLastError());
  // Without the ring the card still shows; Mochi Studio's frames can't reach it.
  ring_.Open();
  latest_.resize(mochi::kRingSlotBytes);
  return S_OK;
}

STDMETHODIMP Stream::QueryInterface(REFIID riid, void** ppv) {
  if (!ppv) return E_POINTER;
  if (riid == IID_IUnknown || riid == IID_IMFMediaEventGenerator || riid == IID_IMFMediaStream ||
      riid == __uuidof(IMFMediaStream2)) {
    *ppv = static_cast<IMFMediaStream2*>(this);
    AddRef();
    return S_OK;
  }
  *ppv = nullptr;
  return E_NOINTERFACE;
}

STDMETHODIMP Stream::GetEvent(DWORD flags, IMFMediaEvent** event) {
  IMFMediaEventQueue* q;
  {
    Lock l(lock_);
    if (shutdown_) return MF_E_SHUTDOWN;
    q = queue_;
    q->AddRef();
  }
  HRESULT hr = q->GetEvent(flags, event);
  q->Release();
  return hr;
}

STDMETHODIMP Stream::BeginGetEvent(IMFAsyncCallback* cb, IUnknown* state) {
  Lock l(lock_);
  if (shutdown_) return MF_E_SHUTDOWN;
  return queue_->BeginGetEvent(cb, state);
}

STDMETHODIMP Stream::EndGetEvent(IMFAsyncResult* result, IMFMediaEvent** event) {
  Lock l(lock_);
  if (shutdown_) return MF_E_SHUTDOWN;
  return queue_->EndGetEvent(result, event);
}

STDMETHODIMP Stream::QueueEvent(MediaEventType type, REFGUID ext, HRESULT status,
                                const PROPVARIANT* value) {
  Lock l(lock_);
  if (shutdown_) return MF_E_SHUTDOWN;
  return queue_->QueueEventParamVar(type, ext, status, value);
}

STDMETHODIMP Stream::GetMediaSource(IMFMediaSource** out) {
  if (!out) return E_POINTER;
  Lock l(lock_);
  if (shutdown_ || !source_) return MF_E_SHUTDOWN;
  *out = static_cast<IMFMediaSource*>(source_);
  (*out)->AddRef();
  return S_OK;
}

STDMETHODIMP Stream::GetStreamDescriptor(IMFStreamDescriptor** out) {
  if (!out) return E_POINTER;
  Lock l(lock_);
  if (shutdown_) return MF_E_SHUTDOWN;
  *out = sd_;
  sd_->AddRef();
  return S_OK;
}

STDMETHODIMP Stream::RequestSample(IUnknown* token) {
  Lock l(lock_);
  if (shutdown_) return MF_E_SHUTDOWN;
  if (state_ != MF_STREAM_STATE_RUNNING) return MF_E_MEDIA_SOURCE_WRONGSTATE;
  if (token) token->AddRef();
  tokens_.push_back(token);
  SetEvent(wake_);
  return S_OK;
}

STDMETHODIMP Stream::SetStreamState(MF_STREAM_STATE value) {
  {
    Lock l(lock_);
    if (shutdown_) return MF_E_SHUTDOWN;
    if (value == state_) return S_OK;
    if (value == MF_STREAM_STATE_PAUSED) return MF_E_INVALID_STATE_TRANSITION;
  }
  if (value == MF_STREAM_STATE_STOPPED) {
    End(true);
    return S_OK;
  }
  IMFMediaType* type = nullptr;
  IMFMediaTypeHandler* handler = nullptr;
  HRESULT hr = sd_->GetMediaTypeHandler(&handler);
  if (SUCCEEDED(hr)) hr = handler->GetCurrentMediaType(&type);
  SafeRelease(handler);
  if (FAILED(hr)) return hr;
  PROPVARIANT now;
  PropVariantInit(&now);
  now.vt = VT_I8;
  now.hVal.QuadPart = MFGetSystemTime();
  hr = Begin(type, &now);
  type->Release();
  return hr;
}

STDMETHODIMP Stream::GetStreamState(MF_STREAM_STATE* value) {
  if (!value) return E_POINTER;
  Lock l(lock_);
  if (shutdown_) return MF_E_SHUTDOWN;
  *value = state_;
  return S_OK;
}

HRESULT Stream::Begin(IMFMediaType* type, const PROPVARIANT* start) {
  UINT32 w = 0, h = 0;
  HRESULT hr = MFGetAttributeSize(type, MF_MT_FRAME_SIZE, &w, &h);
  if (FAILED(hr)) return hr;
  bool known = false;
  for (const Size& s : kSizes) known = known || (s.width == w && s.height == h);
  if (!known) return MF_E_INVALIDMEDIATYPE;
  StopThread();  // a new Start while running: start over at the new size
  Lock l(lock_);
  if (shutdown_) return MF_E_SHUTDOWN;
  size_ = {w, h};
  state_ = MF_STREAM_STATE_RUNNING;
  ResetEvent(quit_);
  thread_ = CreateThread(nullptr, 0, ThreadMain, this, 0, nullptr);
  if (!thread_) {
    state_ = MF_STREAM_STATE_STOPPED;
    return HRESULT_FROM_WIN32(GetLastError());
  }
  return queue_->QueueEventParamVar(MEStreamStarted, GUID_NULL, S_OK, start);
}

void Stream::StopThread() {
  HANDLE t;
  {
    Lock l(lock_);
    t = thread_;
    thread_ = nullptr;
    if (t) SetEvent(quit_);
  }
  if (t) {
    WaitForSingleObject(t, INFINITE);
    CloseHandle(t);
  }
}

void Stream::End(bool queueStopped) {
  StopThread();
  Lock l(lock_);
  bool wasRunning = state_ == MF_STREAM_STATE_RUNNING;
  state_ = MF_STREAM_STATE_STOPPED;
  for (IUnknown* t : tokens_)
    if (t) t->Release();
  tokens_.clear();
  if (queueStopped && wasRunning && !shutdown_)
    queue_->QueueEventParamVar(MEStreamStopped, GUID_NULL, S_OK, nullptr);
}

void Stream::Shutdown() {
  End(false);
  Source* source;
  {
    Lock l(lock_);
    if (shutdown_) return;
    shutdown_ = true;
    if (queue_) queue_->Shutdown();
    source = source_;
    source_ = nullptr;
  }
  SafeRelease(queue_);
  ring_.Close();
  if (source) source->Release();
}

// The next frame: Mochi Studio's latest, at the stream's size, or the card.
HRESULT Stream::MakeSample(IMFSample** out) {
  const Size s = size_;
  const DWORD bytes = s.width * s.height * 3 / 2;
  uint32_t w = 0, h = 0;
  if (ring_.Read(latest_.data(), latest_.size(), &w, &h)) {
    haveLatest_ = true;
    latestW_ = w;
    latestH_ = h;
  } else if (!ring_.Writing()) {
    haveLatest_ = false;
  }
  if (!haveLatest_ && (cardSize_.width != s.width || cardSize_.height != s.height)) {
    card_ = mochi::DrawCard(int(s.width), int(s.height));
    cardSize_ = s;
  }
  IMFMediaBuffer* buffer = nullptr;
  HRESULT hr = MFCreateMemoryBuffer(bytes, &buffer);
  if (FAILED(hr)) return hr;
  BYTE* data = nullptr;
  DWORD max = 0;
  hr = buffer->Lock(&data, &max, nullptr);
  if (SUCCEEDED(hr)) {
    if (max < bytes) hr = E_UNEXPECTED;
    else if (haveLatest_)
      mochi::Nv12Scale(latest_.data(), int(latestW_), int(latestH_), data, int(s.width),
                       int(s.height));
    else
      std::memcpy(data, card_.data(), bytes);
    buffer->Unlock();
  }
  if (SUCCEEDED(hr)) hr = buffer->SetCurrentLength(bytes);
  IMFSample* sample = nullptr;
  if (SUCCEEDED(hr)) hr = MFCreateSample(&sample);
  if (SUCCEEDED(hr)) hr = sample->AddBuffer(buffer);
  if (SUCCEEDED(hr)) hr = sample->SetSampleTime(MFGetSystemTime());
  if (SUCCEEDED(hr)) hr = sample->SetSampleDuration(kInterval);
  if (SUCCEEDED(hr)) hr = sample->SetUINT32(MFSampleExtension_CleanPoint, TRUE);
  buffer->Release();
  if (FAILED(hr)) {
    SafeRelease(sample);
    return hr;
  }
  *out = sample;
  return S_OK;
}

// The streaming thread: answers each request on the frame interval.
void Stream::Deliver() {
  LONGLONG due = MFGetSystemTime();
  for (;;) {
    HANDLE both[2] = {quit_, wake_};
    if (WaitForMultipleObjects(2, both, FALSE, INFINITE) == WAIT_OBJECT_0) return;
    for (;;) {
      {
        Lock l(lock_);
        if (tokens_.empty()) break;
      }
      // No sooner than one interval after the last frame; never behind by more.
      LONGLONG now = MFGetSystemTime();
      if (due < now - kInterval) due = now;
      if (due > now && WaitForSingleObject(quit_, DWORD((due - now) / 10000)) == WAIT_OBJECT_0)
        return;
      due += kInterval;
      IMFSample* sample = nullptr;
      HRESULT hr = MakeSample(&sample);
      Lock l(lock_);
      if (tokens_.empty() || shutdown_) {
        SafeRelease(sample);
        break;
      }
      IUnknown* token = tokens_.front();
      tokens_.pop_front();
      if (SUCCEEDED(hr) && token) hr = sample->SetUnknown(MFSampleExtension_Token, token);
      if (SUCCEEDED(hr))
        queue_->QueueEventParamUnk(MEMediaSample, GUID_NULL, S_OK, sample);
      else
        queue_->QueueEventParamVar(MEError, GUID_NULL, hr, nullptr);
      SafeRelease(sample);
      if (token) token->Release();
    }
  }
}

// --- the activation object ------------------------------------------------------------
//
// What the class gives: an IMFActivate (with its own attributes, which the
// Frame Server may set), whose ActivateObject makes the media source. An app
// that asks the class for the source itself gets one too.

class Activate final : public IMFActivate {
 public:
  Activate() { g_objects++; }
  HRESULT Init() { return MFCreateAttributes(&attrs_, 4); }

  STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
    if (!ppv) return E_POINTER;
    if (riid == IID_IUnknown || riid == IID_IMFAttributes || riid == IID_IMFActivate) {
      *ppv = static_cast<IMFActivate*>(this);
      AddRef();
      return S_OK;
    }
    *ppv = nullptr;
    return E_NOINTERFACE;
  }
  STDMETHODIMP_(ULONG) AddRef() override { return ++refs_; }
  STDMETHODIMP_(ULONG) Release() override {
    long n = --refs_;
    if (n == 0) delete this;
    return ULONG(n);
  }

  // IMFActivate
  STDMETHODIMP ActivateObject(REFIID riid, void** ppv) override {
    if (!ppv) return E_POINTER;
    *ppv = nullptr;
    Lock l(lock_);
    if (!source_) {
      auto* s = new (std::nothrow) Source();
      if (!s) return E_OUTOFMEMORY;
      HRESULT hr = s->Init();
      if (FAILED(hr)) {
        s->Release();
        return hr;
      }
      source_ = s;
    }
    return source_->QueryInterface(riid, ppv);
  }
  STDMETHODIMP ShutdownObject() override {
    Lock l(lock_);
    if (source_) {
      source_->Shutdown();
      source_->Release();
      source_ = nullptr;
    }
    return S_OK;
  }
  STDMETHODIMP DetachObject() override {
    Lock l(lock_);
    SafeRelease(source_);
    return S_OK;
  }

  // IMFAttributes, kept in an attribute store.
  STDMETHODIMP GetItem(REFGUID k, PROPVARIANT* v) override { return attrs_->GetItem(k, v); }
  STDMETHODIMP GetItemType(REFGUID k, MF_ATTRIBUTE_TYPE* t) override { return attrs_->GetItemType(k, t); }
  STDMETHODIMP CompareItem(REFGUID k, REFPROPVARIANT v, BOOL* r) override {
    return attrs_->CompareItem(k, v, r);
  }
  STDMETHODIMP Compare(IMFAttributes* o, MF_ATTRIBUTES_MATCH_TYPE m, BOOL* r) override {
    return attrs_->Compare(o, m, r);
  }
  STDMETHODIMP GetUINT32(REFGUID k, UINT32* v) override { return attrs_->GetUINT32(k, v); }
  STDMETHODIMP GetUINT64(REFGUID k, UINT64* v) override { return attrs_->GetUINT64(k, v); }
  STDMETHODIMP GetDouble(REFGUID k, double* v) override { return attrs_->GetDouble(k, v); }
  STDMETHODIMP GetGUID(REFGUID k, GUID* v) override { return attrs_->GetGUID(k, v); }
  STDMETHODIMP GetStringLength(REFGUID k, UINT32* n) override { return attrs_->GetStringLength(k, n); }
  STDMETHODIMP GetString(REFGUID k, LPWSTR v, UINT32 n, UINT32* len) override {
    return attrs_->GetString(k, v, n, len);
  }
  STDMETHODIMP GetAllocatedString(REFGUID k, LPWSTR* v, UINT32* len) override {
    return attrs_->GetAllocatedString(k, v, len);
  }
  STDMETHODIMP GetBlobSize(REFGUID k, UINT32* n) override { return attrs_->GetBlobSize(k, n); }
  STDMETHODIMP GetBlob(REFGUID k, UINT8* b, UINT32 n, UINT32* got) override {
    return attrs_->GetBlob(k, b, n, got);
  }
  STDMETHODIMP GetAllocatedBlob(REFGUID k, UINT8** b, UINT32* n) override {
    return attrs_->GetAllocatedBlob(k, b, n);
  }
  STDMETHODIMP GetUnknown(REFGUID k, REFIID riid, LPVOID* v) override {
    return attrs_->GetUnknown(k, riid, v);
  }
  STDMETHODIMP SetItem(REFGUID k, REFPROPVARIANT v) override { return attrs_->SetItem(k, v); }
  STDMETHODIMP DeleteItem(REFGUID k) override { return attrs_->DeleteItem(k); }
  STDMETHODIMP DeleteAllItems() override { return attrs_->DeleteAllItems(); }
  STDMETHODIMP SetUINT32(REFGUID k, UINT32 v) override { return attrs_->SetUINT32(k, v); }
  STDMETHODIMP SetUINT64(REFGUID k, UINT64 v) override { return attrs_->SetUINT64(k, v); }
  STDMETHODIMP SetDouble(REFGUID k, double v) override { return attrs_->SetDouble(k, v); }
  STDMETHODIMP SetGUID(REFGUID k, REFGUID v) override { return attrs_->SetGUID(k, v); }
  STDMETHODIMP SetString(REFGUID k, LPCWSTR v) override { return attrs_->SetString(k, v); }
  STDMETHODIMP SetBlob(REFGUID k, const UINT8* b, UINT32 n) override { return attrs_->SetBlob(k, b, n); }
  STDMETHODIMP SetUnknown(REFGUID k, IUnknown* v) override { return attrs_->SetUnknown(k, v); }
  STDMETHODIMP LockStore() override { return attrs_->LockStore(); }
  STDMETHODIMP UnlockStore() override { return attrs_->UnlockStore(); }
  STDMETHODIMP GetCount(UINT32* n) override { return attrs_->GetCount(n); }
  STDMETHODIMP GetItemByIndex(UINT32 i, GUID* k, PROPVARIANT* v) override {
    return attrs_->GetItemByIndex(i, k, v);
  }
  STDMETHODIMP CopyAllItems(IMFAttributes* to) override { return attrs_->CopyAllItems(to); }

 private:
  // Released: let go of the source, never shut it down. The Frame Server
  // releases the activation object once it has the source, and goes on using it.
  ~Activate() {
    SafeRelease(source_);
    SafeRelease(attrs_);
    g_objects--;
  }
  std::atomic<long> refs_{1};
  Lock::Section lock_;
  IMFAttributes* attrs_ = nullptr;
  Source* source_ = nullptr;
};

// --- the class factory and the DLL's exports --------------------------------------------

class Factory final : public IClassFactory {
 public:
  STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
    if (!ppv) return E_POINTER;
    if (riid == IID_IUnknown || riid == IID_IClassFactory) {
      *ppv = static_cast<IClassFactory*>(this);
      AddRef();
      return S_OK;
    }
    *ppv = nullptr;
    return E_NOINTERFACE;
  }
  STDMETHODIMP_(ULONG) AddRef() override { return 2; }
  STDMETHODIMP_(ULONG) Release() override { return 1; }
  STDMETHODIMP CreateInstance(IUnknown* outer, REFIID riid, void** ppv) override {
    if (!ppv) return E_POINTER;
    *ppv = nullptr;
    if (outer) return CLASS_E_NOAGGREGATION;
    // The activation object, or the source itself for a caller that asks for it.
    if (riid == IID_IUnknown || riid == IID_IMFAttributes || riid == IID_IMFActivate) {
      auto* a = new (std::nothrow) Activate();
      if (!a) return E_OUTOFMEMORY;
      HRESULT hr = a->Init();
      if (SUCCEEDED(hr)) hr = a->QueryInterface(riid, ppv);
      a->Release();
      return hr;
    }
    auto* s = new (std::nothrow) Source();
    if (!s) return E_OUTOFMEMORY;
    HRESULT hr = s->Init();
    if (SUCCEEDED(hr)) hr = s->QueryInterface(riid, ppv);
    s->Release();
    return hr;
  }
  STDMETHODIMP LockServer(BOOL lock) override {
    if (lock) g_locks++;
    else g_locks--;
    return S_OK;
  }
};
Factory g_factory;

LONG SetString(HKEY root, const std::wstring& key, const wchar_t* name, const wchar_t* value) {
  HKEY k;
  LONG r = RegCreateKeyExW(root, key.c_str(), 0, nullptr, 0, KEY_WRITE, nullptr, &k, nullptr);
  if (r != ERROR_SUCCESS) return r;
  r = RegSetValueExW(k, name, 0, REG_SZ, reinterpret_cast<const BYTE*>(value),
                     DWORD((wcslen(value) + 1) * sizeof(wchar_t)));
  RegCloseKey(k);
  return r;
}

const std::wstring kClassKey = std::wstring(L"Software\\Classes\\CLSID\\") + mochi::kClsidMfCameraString;

}  // namespace

extern "C" BOOL WINAPI DllMain(HINSTANCE module, DWORD reason, LPVOID) {
  if (reason == DLL_PROCESS_ATTACH) {
    g_module = module;
    DisableThreadLibraryCalls(module);
  }
  return TRUE;
}

STDAPI DllGetClassObject(REFCLSID clsid, REFIID riid, void** ppv) {
  if (!ppv) return E_POINTER;
  *ppv = nullptr;
  if (clsid != mochi::kClsidMfCamera) return CLASS_E_CLASSNOTAVAILABLE;
  return g_factory.QueryInterface(riid, ppv);
}

STDAPI DllCanUnloadNow() { return g_objects == 0 && g_locks == 0 ? S_OK : S_FALSE; }

// Under HKLM, where the Frame Server (a service) finds the class.
STDAPI DllRegisterServer() {
  wchar_t path[MAX_PATH];
  if (!GetModuleFileNameW(g_module, path, MAX_PATH)) return HRESULT_FROM_WIN32(GetLastError());
  if (SetString(HKEY_LOCAL_MACHINE, kClassKey, nullptr, mochi::kCameraName) != ERROR_SUCCESS ||
      SetString(HKEY_LOCAL_MACHINE, kClassKey + L"\\InprocServer32", nullptr, path) != ERROR_SUCCESS ||
      SetString(HKEY_LOCAL_MACHINE, kClassKey + L"\\InprocServer32", L"ThreadingModel", L"Both") !=
          ERROR_SUCCESS)
    return SELFREG_E_CLASS;
  return S_OK;
}

STDAPI DllUnregisterServer() {
  LONG r = RegDeleteTreeW(HKEY_LOCAL_MACHINE, kClassKey.c_str());
  return r == ERROR_SUCCESS || r == ERROR_FILE_NOT_FOUND ? S_OK : SELFREG_E_CLASS;
}
