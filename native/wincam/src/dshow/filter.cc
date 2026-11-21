// The virtual camera's DirectShow source filter (docs/virtual-camera.md,
// Windows): a COM DLL registered in the video input device category, which
// every DirectShow app lists as "Mochi Studio Camera". It runs inside each app
// that opens it, and reads the frames Mochi Studio writes to the frame ring
// (../ring.h); while nothing is sent, it shows a still card saying so.
//
// Written from the DirectShow interfaces (strmif.h) and their documentation,
// without the SDK's base classes: one filter, one output pin.
//
// - The pin offers NV12, YUY2 and RGB32 at 1280 x 720, 1920 x 1080 and
//   960 x 540 (the size Mochi Studio sends first), at 30 or 60 frames a second;
//   frames of another size are scaled to the one chosen.
// - It answers IAMStreamConfig (formats) and IKsPropertySet (the capture pin
//   category), which apps ask before they connect.
// - A streaming thread delivers a sample per frame interval while the graph
//   runs, timestamped on the graph's clock.
#include <dshow.h>
#include <initguid.h>
#include <ks.h>
#include <windows.h>

#include <atomic>
#include <cstdint>
#include <cstring>
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

// Media subtypes by FourCC ({FourCC-0000-0010-8000-00AA00389B71}), and RGB32.
constexpr GUID FourccGuid(uint32_t f) {
  return {f, 0x0000, 0x0010, {0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}};
}
constexpr uint32_t kFourccYuy2 = 0x32595559;  // "YUY2"
const GUID kSubNv12 = FourccGuid(mochi::kFourccNv12);
const GUID kSubYuy2 = FourccGuid(kFourccYuy2);
const GUID kSubRgb32 = {0xe436eb7e, 0x524f, 0x11ce, {0x9f, 0x53, 0x00, 0x20, 0xaf, 0x0b, 0xa7, 0x70}};
const GUID kTypeVideo = {0x73646976, 0x0000, 0x0010, {0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}};
const GUID kFormatVideoInfo = {0x05589f80, 0xc356, 0x11ce, {0xbf, 0x01, 0x00, 0xaa, 0x00, 0x55, 0x59, 0x5a}};
// The pin property set and the capture category (uuids.h), here by value.
const GUID kPropSetPin = {0x9b00f101, 0x1567, 0x11d1, {0xb3, 0xf1, 0x00, 0xaa, 0x00, 0x37, 0x61, 0xc5}};
const GUID kCategoryCapture = {0xfb6c4281, 0x0353, 0x11d1, {0x90, 0x5f, 0x00, 0x00, 0xc0, 0xcc, 0x16, 0xba}};
const GUID kVideoInputCategory = {0x860bb310, 0x5d01, 0x11d0, {0xbd, 0x3b, 0x00, 0xa0, 0xc9, 0x11, 0xce, 0x86}};
const GUID kClsidMemoryAllocator = {0x1e651cc0, 0xb199, 0x11d0, {0x82, 0x12, 0x00, 0xc0, 0x4f, 0xc3, 0x2c, 0x45}};
const GUID kClsidFilterMapper2 = {0xcda42200, 0xbd88, 0x11d0, {0xbd, 0x4e, 0x00, 0xa0, 0xc9, 0x11, 0xce, 0x86}};
constexpr DWORD kPinCategoryProperty = 0;  // AMPROPERTY_PIN_CATEGORY

struct Size {
  int width, height;
};
constexpr Size kSizes[] = {{1280, 720}, {1920, 1080}, {960, 540}};
enum Pixel { kNv12, kYuy2, kRgb32 };
constexpr int kPixels = 3;
constexpr REFERENCE_TIME kSecond = 10000000;

const GUID& SubtypeOf(Pixel p) { return p == kNv12 ? kSubNv12 : p == kYuy2 ? kSubYuy2 : kSubRgb32; }
WORD BitsOf(Pixel p) { return p == kNv12 ? 12 : p == kYuy2 ? 16 : 32; }
DWORD BytesOf(Pixel p, int w, int h) {
  return p == kNv12 ? DWORD(w) * h * 3 / 2 : p == kYuy2 ? DWORD(w) * h * 2 : DWORD(w) * h * 4;
}

void FreeFormat(AM_MEDIA_TYPE& mt) {
  if (mt.cbFormat && mt.pbFormat) CoTaskMemFree(mt.pbFormat);
  mt.cbFormat = 0;
  mt.pbFormat = nullptr;
  if (mt.pUnk) {
    mt.pUnk->Release();
    mt.pUnk = nullptr;
  }
}

HRESULT CopyType(AM_MEDIA_TYPE& to, const AM_MEDIA_TYPE& from) {
  to = from;
  if (from.cbFormat) {
    to.pbFormat = static_cast<BYTE*>(CoTaskMemAlloc(from.cbFormat));
    if (!to.pbFormat) {
      to.cbFormat = 0;
      return E_OUTOFMEMORY;
    }
    std::memcpy(to.pbFormat, from.pbFormat, from.cbFormat);
  }
  if (to.pUnk) to.pUnk->AddRef();
  return S_OK;
}

// The media type of a pixel format at a size and frame interval.
HRESULT MakeType(AM_MEDIA_TYPE& mt, Pixel p, Size s, REFERENCE_TIME interval) {
  std::memset(&mt, 0, sizeof mt);
  auto* vih = static_cast<VIDEOINFOHEADER*>(CoTaskMemAlloc(sizeof(VIDEOINFOHEADER)));
  if (!vih) return E_OUTOFMEMORY;
  std::memset(vih, 0, sizeof *vih);
  DWORD bytes = BytesOf(p, s.width, s.height);
  vih->AvgTimePerFrame = interval;
  vih->dwBitRate = DWORD(uint64_t(bytes) * 8 * kSecond / interval);
  vih->bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  vih->bmiHeader.biWidth = s.width;
  vih->bmiHeader.biHeight = s.height;
  vih->bmiHeader.biPlanes = 1;
  vih->bmiHeader.biBitCount = BitsOf(p);
  vih->bmiHeader.biCompression = p == kNv12 ? mochi::kFourccNv12 : p == kYuy2 ? kFourccYuy2 : BI_RGB;
  vih->bmiHeader.biSizeImage = bytes;
  mt.majortype = kTypeVideo;
  mt.subtype = SubtypeOf(p);
  mt.bFixedSizeSamples = TRUE;
  mt.bTemporalCompression = FALSE;
  mt.lSampleSize = bytes;
  mt.formattype = kFormatVideoInfo;
  mt.cbFormat = sizeof(VIDEOINFOHEADER);
  mt.pbFormat = reinterpret_cast<BYTE*>(vih);
  return S_OK;
}

// What a media type asks for, when it is one this camera gives.
struct Chosen {
  Pixel pixel;
  int width, height;
  bool bottomUp;
  REFERENCE_TIME interval;
};

bool Accept(const AM_MEDIA_TYPE* mt, Chosen* out) {
  if (!mt || mt->majortype != kTypeVideo || mt->formattype != kFormatVideoInfo || !mt->pbFormat ||
      mt->cbFormat < sizeof(VIDEOINFOHEADER))
    return false;
  Pixel p;
  if (mt->subtype == kSubNv12) p = kNv12;
  else if (mt->subtype == kSubYuy2) p = kYuy2;
  else if (mt->subtype == kSubRgb32) p = kRgb32;
  else return false;
  auto* vih = reinterpret_cast<const VIDEOINFOHEADER*>(mt->pbFormat);
  int w = vih->bmiHeader.biWidth, h = vih->bmiHeader.biHeight;
  bool bottomUp = p == kRgb32 && h > 0;
  if (h < 0) h = -h;
  bool known = false;
  for (Size s : kSizes) known |= s.width == w && s.height == h;
  if (!known) return false;
  REFERENCE_TIME interval = vih->AvgTimePerFrame;
  if (interval < kSecond / 60) interval = kSecond / 30;
  if (out) *out = {p, w, h, bottomUp, interval};
  return true;
}

class Filter;

class Lock {
 public:
  explicit Lock(CRITICAL_SECTION& cs) : cs_(cs) { EnterCriticalSection(&cs_); }
  ~Lock() { LeaveCriticalSection(&cs_); }

 private:
  CRITICAL_SECTION& cs_;
};

// --- media type enumerator ----------------------------------------------------

class EnumTypes final : public IEnumMediaTypes {
 public:
  EnumTypes(Size first, REFERENCE_TIME interval, ULONG at = 0)
      : first_(first), interval_(interval), at_(at) {
    g_objects++;
  }
  ~EnumTypes() { g_objects--; }

  // The types in order: the first size in each format, then the others.
  static ULONG Count() { return ULONG(kPixels * (sizeof kSizes / sizeof kSizes[0])); }
  static void Nth(ULONG i, Size first, Pixel* p, Size* s) {
    ULONG n = sizeof kSizes / sizeof kSizes[0];
    *p = Pixel(i % kPixels);
    ULONG k = i / kPixels;
    // The first size, then the rest in their order.
    Size order[3] = {first};
    ULONG j = 1;
    for (Size z : kSizes)
      if (z.width != first.width && j < n) order[j++] = z;
    *s = order[k < j ? k : 0];
  }

  STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
    if (!ppv) return E_POINTER;
    if (riid == IID_IUnknown || riid == IID_IEnumMediaTypes) {
      *ppv = static_cast<IEnumMediaTypes*>(this);
      AddRef();
      return S_OK;
    }
    *ppv = nullptr;
    return E_NOINTERFACE;
  }
  STDMETHODIMP_(ULONG) AddRef() override { return ++refs_; }
  STDMETHODIMP_(ULONG) Release() override {
    ULONG n = --refs_;
    if (!n) delete this;
    return n;
  }
  STDMETHODIMP Next(ULONG want, AM_MEDIA_TYPE** out, ULONG* got) override {
    if (!out || (want > 1 && !got)) return E_POINTER;
    ULONG n = 0;
    while (n < want && at_ < Count()) {
      Pixel p;
      Size s;
      Nth(at_++, first_, &p, &s);
      auto* mt = static_cast<AM_MEDIA_TYPE*>(CoTaskMemAlloc(sizeof(AM_MEDIA_TYPE)));
      if (!mt || FAILED(MakeType(*mt, p, s, interval_))) {
        CoTaskMemFree(mt);
        break;
      }
      out[n++] = mt;
    }
    if (got) *got = n;
    return n == want ? S_OK : S_FALSE;
  }
  STDMETHODIMP Skip(ULONG n) override {
    at_ += n;
    return at_ <= Count() ? S_OK : S_FALSE;
  }
  STDMETHODIMP Reset() override {
    at_ = 0;
    return S_OK;
  }
  STDMETHODIMP Clone(IEnumMediaTypes** out) override {
    if (!out) return E_POINTER;
    *out = new (std::nothrow) EnumTypes(first_, interval_, at_);
    return *out ? S_OK : E_OUTOFMEMORY;
  }

 private:
  std::atomic<ULONG> refs_{1};
  Size first_;
  REFERENCE_TIME interval_;
  ULONG at_;
};

// --- the output pin -------------------------------------------------------------

class Pin final : public IPin, public IAMStreamConfig, public IKsPropertySet {
 public:
  explicit Pin(Filter* filter);
  ~Pin();

  // IUnknown: the pin lives as long as its filter.
  STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override;
  STDMETHODIMP_(ULONG) AddRef() override;
  STDMETHODIMP_(ULONG) Release() override;

  // IPin
  STDMETHODIMP Connect(IPin* receive, const AM_MEDIA_TYPE* pmt) override;
  STDMETHODIMP ReceiveConnection(IPin*, const AM_MEDIA_TYPE*) override { return E_UNEXPECTED; }
  STDMETHODIMP Disconnect() override;
  STDMETHODIMP ConnectedTo(IPin** pin) override;
  STDMETHODIMP ConnectionMediaType(AM_MEDIA_TYPE* pmt) override;
  STDMETHODIMP QueryPinInfo(PIN_INFO* info) override;
  STDMETHODIMP QueryDirection(PIN_DIRECTION* dir) override {
    if (!dir) return E_POINTER;
    *dir = PINDIR_OUTPUT;
    return S_OK;
  }
  STDMETHODIMP QueryId(LPWSTR* id) override;
  STDMETHODIMP QueryAccept(const AM_MEDIA_TYPE* pmt) override {
    return Accept(pmt, nullptr) ? S_OK : S_FALSE;
  }
  STDMETHODIMP EnumMediaTypes(IEnumMediaTypes** out) override;
  STDMETHODIMP QueryInternalConnections(IPin**, ULONG*) override { return E_NOTIMPL; }
  STDMETHODIMP EndOfStream() override { return E_UNEXPECTED; }
  STDMETHODIMP BeginFlush() override { return E_UNEXPECTED; }
  STDMETHODIMP EndFlush() override { return E_UNEXPECTED; }
  STDMETHODIMP NewSegment(REFERENCE_TIME, REFERENCE_TIME, double) override { return S_OK; }

  // IAMStreamConfig
  STDMETHODIMP SetFormat(AM_MEDIA_TYPE* pmt) override;
  STDMETHODIMP GetFormat(AM_MEDIA_TYPE** pmt) override;
  STDMETHODIMP GetNumberOfCapabilities(int* count, int* size) override {
    if (!count || !size) return E_POINTER;
    *count = int(EnumTypes::Count());
    *size = sizeof(VIDEO_STREAM_CONFIG_CAPS);
    return S_OK;
  }
  STDMETHODIMP GetStreamCaps(int index, AM_MEDIA_TYPE** pmt, BYTE* caps) override;

  // IKsPropertySet: the pin's category, which apps check.
  STDMETHODIMP Set(REFGUID, DWORD, LPVOID, DWORD, LPVOID, DWORD) override { return E_NOTIMPL; }
  STDMETHODIMP Get(REFGUID set, DWORD id, LPVOID, DWORD, LPVOID data, DWORD size,
                   DWORD* returned) override {
    if (set != kPropSetPin) return E_PROP_SET_UNSUPPORTED;
    if (id != kPinCategoryProperty) return E_PROP_ID_UNSUPPORTED;
    if (returned) *returned = sizeof(GUID);
    if (!data) return returned ? S_OK : E_POINTER;
    if (size < sizeof(GUID)) return E_UNEXPECTED;
    *static_cast<GUID*>(data) = kCategoryCapture;
    return S_OK;
  }
  STDMETHODIMP QuerySupported(REFGUID set, DWORD id, DWORD* support) override {
    if (set != kPropSetPin) return E_PROP_SET_UNSUPPORTED;
    if (id != kPinCategoryProperty) return E_PROP_ID_UNSUPPORTED;
    if (support) *support = KSPROPERTY_SUPPORT_GET;
    return S_OK;
  }

  // From the filter.
  HRESULT Active();
  void Inactive();
  bool IsConnected() const { return peer_ != nullptr; }

 private:
  HRESULT TryConnect(IPin* receive, const AM_MEDIA_TYPE& mt);
  HRESULT DecideAllocator();
  void ReleaseConnection();
  static DWORD WINAPI ThreadMain(void* self) {
    static_cast<Pin*>(self)->Stream();
    return 0;
  }
  void Stream();
  void Fill(uint8_t* out, const Chosen& c);

  Filter* filter_;
  CRITICAL_SECTION lock_;
  IPin* peer_ = nullptr;
  IMemInputPin* input_ = nullptr;
  IMemAllocator* allocator_ = nullptr;
  AM_MEDIA_TYPE type_{};  // the connection's type
  bool hasType_ = false;
  AM_MEDIA_TYPE wanted_{};  // set with IAMStreamConfig::SetFormat
  bool hasWanted_ = false;
  HANDLE thread_ = nullptr;
  HANDLE stop_ = nullptr;
  // The stream's state, on its thread.
  mochi::RingReader ring_;
  std::vector<uint8_t> latest_, scaled_, card_;
  int latestW_ = 0, latestH_ = 0;
  bool haveLatest_ = false;
  int cardW_ = 0, cardH_ = 0;
};

// --- the filter --------------------------------------------------------------------

class Filter final : public IBaseFilter, public IAMFilterMiscFlags {
 public:
  Filter() : pin_(this) {
    InitializeCriticalSection(&lock_);
    g_objects++;
  }
  ~Filter() {
    pin_.Inactive();
    if (clock_) clock_->Release();
    DeleteCriticalSection(&lock_);
    g_objects--;
  }

  STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
    if (!ppv) return E_POINTER;
    if (riid == IID_IUnknown || riid == IID_IPersist || riid == IID_IMediaFilter ||
        riid == IID_IBaseFilter) {
      *ppv = static_cast<IBaseFilter*>(this);
    } else if (riid == IID_IAMFilterMiscFlags) {
      *ppv = static_cast<IAMFilterMiscFlags*>(this);
    } else {
      *ppv = nullptr;
      return E_NOINTERFACE;
    }
    AddRef();
    return S_OK;
  }
  STDMETHODIMP_(ULONG) AddRef() override { return ++refs_; }
  STDMETHODIMP_(ULONG) Release() override {
    ULONG n = --refs_;
    if (!n) delete this;
    return n;
  }

  // IPersist
  STDMETHODIMP GetClassID(CLSID* id) override {
    if (!id) return E_POINTER;
    *id = mochi::kClsidDshowCamera;
    return S_OK;
  }

  // IMediaFilter
  STDMETHODIMP Stop() override {
    // Stopped first, then the streaming thread is waited for outside the lock:
    // the thread takes the lock to read the stream time (StreamTime), and waiting
    // for it while holding the lock could hang the app's Stop for good.
    {
      Lock l(lock_);
      state_ = State_Stopped;
    }
    pin_.Inactive();
    return S_OK;
  }
  STDMETHODIMP Pause() override {
    Lock l(lock_);
    if (state_ == State_Stopped) {
      HRESULT hr = pin_.Active();
      if (FAILED(hr)) return hr;
    }
    state_ = State_Paused;
    return S_OK;
  }
  STDMETHODIMP Run(REFERENCE_TIME start) override {
    Lock l(lock_);
    if (state_ == State_Stopped) {
      HRESULT hr = pin_.Active();
      if (FAILED(hr)) return hr;
    }
    start_ = start;
    state_ = State_Running;
    return S_OK;
  }
  STDMETHODIMP GetState(DWORD, FILTER_STATE* state) override {
    if (!state) return E_POINTER;
    Lock l(lock_);
    *state = state_;
    // A live source sends nothing while paused.
    return state_ == State_Paused ? VFW_S_CANT_CUE : S_OK;
  }
  STDMETHODIMP SetSyncSource(IReferenceClock* clock) override {
    Lock l(lock_);
    if (clock) clock->AddRef();
    if (clock_) clock_->Release();
    clock_ = clock;
    return S_OK;
  }
  STDMETHODIMP GetSyncSource(IReferenceClock** clock) override {
    if (!clock) return E_POINTER;
    Lock l(lock_);
    *clock = clock_;
    if (clock_) clock_->AddRef();
    return S_OK;
  }

  // IBaseFilter
  STDMETHODIMP EnumPins(IEnumPins** out) override;
  STDMETHODIMP FindPin(LPCWSTR id, IPin** pin) override {
    if (!id || !pin) return E_POINTER;
    if (wcscmp(id, L"Capture") != 0) {
      *pin = nullptr;
      return VFW_E_NOT_FOUND;
    }
    *pin = &pin_;
    pin_.AddRef();
    return S_OK;
  }
  STDMETHODIMP QueryFilterInfo(FILTER_INFO* info) override {
    if (!info) return E_POINTER;
    Lock l(lock_);
    wcscpy_s(info->achName, name_);
    info->pGraph = graph_;
    if (graph_) graph_->AddRef();
    return S_OK;
  }
  STDMETHODIMP JoinFilterGraph(IFilterGraph* graph, LPCWSTR name) override {
    Lock l(lock_);
    graph_ = graph;  // not held: the graph holds the filter
    if (name) wcscpy_s(name_, name);
    else name_[0] = 0;
    return S_OK;
  }
  STDMETHODIMP QueryVendorInfo(LPWSTR* info) override {
    if (!info) return E_POINTER;
    *info = nullptr;
    return E_NOTIMPL;
  }

  // IAMFilterMiscFlags: a source of live frames.
  STDMETHODIMP_(ULONG) GetMiscFlags() override { return AM_FILTER_MISC_FLAGS_IS_SOURCE; }

  // For the pin's thread: the stream time now, or false when the graph doesn't run.
  bool StreamTime(REFERENCE_TIME* now) {
    Lock l(lock_);
    if (state_ != State_Running) return false;
    if (!clock_) {
      *now = -1;
      return true;
    }
    REFERENCE_TIME t = 0;
    if (FAILED(clock_->GetTime(&t))) return false;
    *now = t - start_;
    return true;
  }
  FILTER_STATE StateNow() {
    Lock l(lock_);
    return state_;
  }

  Pin& pin() { return pin_; }

 private:
  std::atomic<ULONG> refs_{1};
  CRITICAL_SECTION lock_;
  FILTER_STATE state_ = State_Stopped;
  REFERENCE_TIME start_ = 0;
  IReferenceClock* clock_ = nullptr;
  IFilterGraph* graph_ = nullptr;
  wchar_t name_[MAX_FILTER_NAME] = {0};
  Pin pin_;
};

class EnumPinsImpl final : public IEnumPins {
 public:
  EnumPinsImpl(Filter* f, ULONG at = 0) : filter_(f), at_(at) {
    filter_->AddRef();
    g_objects++;
  }
  ~EnumPinsImpl() {
    filter_->Release();
    g_objects--;
  }
  STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
    if (!ppv) return E_POINTER;
    if (riid == IID_IUnknown || riid == IID_IEnumPins) {
      *ppv = static_cast<IEnumPins*>(this);
      AddRef();
      return S_OK;
    }
    *ppv = nullptr;
    return E_NOINTERFACE;
  }
  STDMETHODIMP_(ULONG) AddRef() override { return ++refs_; }
  STDMETHODIMP_(ULONG) Release() override {
    ULONG n = --refs_;
    if (!n) delete this;
    return n;
  }
  STDMETHODIMP Next(ULONG want, IPin** pins, ULONG* got) override {
    if (!pins || (want > 1 && !got)) return E_POINTER;
    ULONG n = 0;
    if (want && at_ == 0) {
      pins[n++] = &filter_->pin();
      filter_->pin().AddRef();
      at_ = 1;
    }
    if (got) *got = n;
    return n == want ? S_OK : S_FALSE;
  }
  STDMETHODIMP Skip(ULONG n) override {
    at_ += n;
    return at_ <= 1 ? S_OK : S_FALSE;
  }
  STDMETHODIMP Reset() override {
    at_ = 0;
    return S_OK;
  }
  STDMETHODIMP Clone(IEnumPins** out) override {
    if (!out) return E_POINTER;
    *out = new (std::nothrow) EnumPinsImpl(filter_, at_);
    return *out ? S_OK : E_OUTOFMEMORY;
  }

 private:
  std::atomic<ULONG> refs_{1};
  Filter* filter_;
  ULONG at_;
};

STDMETHODIMP Filter::EnumPins(IEnumPins** out) {
  if (!out) return E_POINTER;
  *out = new (std::nothrow) EnumPinsImpl(this);
  return *out ? S_OK : E_OUTOFMEMORY;
}

// --- the pin's methods -------------------------------------------------------------

Pin::Pin(Filter* filter) : filter_(filter) {
  InitializeCriticalSection(&lock_);
  stop_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
}

Pin::~Pin() {
  Inactive();
  ReleaseConnection();
  if (hasWanted_) FreeFormat(wanted_);
  if (stop_) CloseHandle(stop_);
  DeleteCriticalSection(&lock_);
}

STDMETHODIMP Pin::QueryInterface(REFIID riid, void** ppv) {
  if (!ppv) return E_POINTER;
  if (riid == IID_IUnknown || riid == IID_IPin) *ppv = static_cast<IPin*>(this);
  else if (riid == IID_IAMStreamConfig) *ppv = static_cast<IAMStreamConfig*>(this);
  else if (riid == IID_IKsPropertySet) *ppv = static_cast<IKsPropertySet*>(this);
  else {
    *ppv = nullptr;
    return E_NOINTERFACE;
  }
  AddRef();
  return S_OK;
}
STDMETHODIMP_(ULONG) Pin::AddRef() { return filter_->AddRef(); }
STDMETHODIMP_(ULONG) Pin::Release() { return filter_->Release(); }

// The size and rate to offer first: what Mochi Studio sends now, else 1280 x 720 at 30.
static void Offered(Size* size, REFERENCE_TIME* interval) {
  *size = kSizes[0];
  *interval = kSecond / 30;
  mochi::RingReader r;
  uint32_t w, h;
  if (r.TryOpen(L"Local\\") && r.Size(&w, &h))
    for (Size s : kSizes)
      if (uint32_t(s.width) == w && uint32_t(s.height) == h) *size = s;
}

STDMETHODIMP Pin::EnumMediaTypes(IEnumMediaTypes** out) {
  if (!out) return E_POINTER;
  Size s;
  REFERENCE_TIME interval;
  Offered(&s, &interval);
  *out = new (std::nothrow) EnumTypes(s, interval);
  return *out ? S_OK : E_OUTOFMEMORY;
}

STDMETHODIMP Pin::Connect(IPin* receive, const AM_MEDIA_TYPE* pmt) {
  if (!receive) return E_POINTER;
  Lock l(lock_);
  if (peer_) return VFW_E_ALREADY_CONNECTED;
  if (filter_->StateNow() != State_Stopped) return VFW_E_NOT_STOPPED;
  // A complete type asked for: that one or none.
  if (pmt && pmt->formattype != GUID_NULL && pmt->pbFormat) {
    if (!Accept(pmt, nullptr)) return VFW_E_TYPE_NOT_ACCEPTED;
    return TryConnect(receive, *pmt);
  }
  // The type set with SetFormat, then ours in order, as far as they fit a partial type.
  if (hasWanted_ && SUCCEEDED(TryConnect(receive, wanted_))) return S_OK;
  Size first;
  REFERENCE_TIME interval;
  Offered(&first, &interval);
  for (ULONG i = 0; i < EnumTypes::Count(); i++) {
    Pixel p;
    Size s;
    EnumTypes::Nth(i, first, &p, &s);
    AM_MEDIA_TYPE mt;
    if (FAILED(MakeType(mt, p, s, interval))) return E_OUTOFMEMORY;
    bool fits = !pmt || ((pmt->majortype == GUID_NULL || pmt->majortype == mt.majortype) &&
                         (pmt->subtype == GUID_NULL || pmt->subtype == mt.subtype));
    HRESULT hr = fits ? TryConnect(receive, mt) : E_FAIL;
    FreeFormat(mt);
    if (SUCCEEDED(hr)) return S_OK;
  }
  return VFW_E_NO_ACCEPTABLE_TYPES;
}

HRESULT Pin::TryConnect(IPin* receive, const AM_MEDIA_TYPE& mt) {
  HRESULT hr = receive->ReceiveConnection(this, &mt);
  if (hr != S_OK) return FAILED(hr) ? hr : E_FAIL;
  peer_ = receive;
  peer_->AddRef();
  if (FAILED(CopyType(type_, mt))) {
    ReleaseConnection();
    return E_OUTOFMEMORY;
  }
  hasType_ = true;
  hr = DecideAllocator();
  if (FAILED(hr)) {
    receive->Disconnect();
    ReleaseConnection();
    return hr;
  }
  return S_OK;
}

HRESULT Pin::DecideAllocator() {
  HRESULT hr = peer_->QueryInterface(IID_IMemInputPin, reinterpret_cast<void**>(&input_));
  if (FAILED(hr)) return hr;
  ALLOCATOR_PROPERTIES want{}, got{};
  input_->GetAllocatorRequirements(&want);
  Chosen c;
  Accept(&type_, &c);
  DWORD bytes = BytesOf(c.pixel, c.width, c.height);
  want.cBuffers = want.cBuffers > 3 ? want.cBuffers : 3;
  want.cbBuffer = want.cbBuffer > long(bytes) ? want.cbBuffer : long(bytes);
  if (want.cbAlign < 1) want.cbAlign = 1;
  if (FAILED(input_->GetAllocator(&allocator_)) || !allocator_) {
    hr = CoCreateInstance(kClsidMemoryAllocator, nullptr, CLSCTX_INPROC_SERVER, IID_IMemAllocator,
                          reinterpret_cast<void**>(&allocator_));
    if (FAILED(hr)) return hr;
  }
  hr = allocator_->SetProperties(&want, &got);
  if (FAILED(hr)) return hr;
  if (got.cbBuffer < long(bytes)) return E_FAIL;
  return input_->NotifyAllocator(allocator_, FALSE);
}

void Pin::ReleaseConnection() {
  if (allocator_) allocator_->Release();
  if (input_) input_->Release();
  if (peer_) peer_->Release();
  allocator_ = nullptr;
  input_ = nullptr;
  peer_ = nullptr;
  if (hasType_) FreeFormat(type_);
  hasType_ = false;
}

STDMETHODIMP Pin::Disconnect() {
  Lock l(lock_);
  if (filter_->StateNow() != State_Stopped) return VFW_E_NOT_STOPPED;
  if (!peer_) return S_FALSE;
  ReleaseConnection();
  return S_OK;
}

STDMETHODIMP Pin::ConnectedTo(IPin** pin) {
  if (!pin) return E_POINTER;
  Lock l(lock_);
  *pin = peer_;
  if (!peer_) return VFW_E_NOT_CONNECTED;
  peer_->AddRef();
  return S_OK;
}

STDMETHODIMP Pin::ConnectionMediaType(AM_MEDIA_TYPE* pmt) {
  if (!pmt) return E_POINTER;
  Lock l(lock_);
  if (!peer_ || !hasType_) {
    std::memset(pmt, 0, sizeof *pmt);
    return VFW_E_NOT_CONNECTED;
  }
  return CopyType(*pmt, type_);
}

STDMETHODIMP Pin::QueryPinInfo(PIN_INFO* info) {
  if (!info) return E_POINTER;
  info->pFilter = filter_;
  filter_->AddRef();
  info->dir = PINDIR_OUTPUT;
  wcscpy_s(info->achName, L"Capture");
  return S_OK;
}

STDMETHODIMP Pin::QueryId(LPWSTR* id) {
  if (!id) return E_POINTER;
  *id = static_cast<LPWSTR>(CoTaskMemAlloc(sizeof L"Capture"));
  if (!*id) return E_OUTOFMEMORY;
  std::memcpy(*id, L"Capture", sizeof L"Capture");
  return S_OK;
}

STDMETHODIMP Pin::SetFormat(AM_MEDIA_TYPE* pmt) {
  Lock l(lock_);
  if (!pmt) {
    if (hasWanted_) FreeFormat(wanted_);
    hasWanted_ = false;
    return S_OK;
  }
  if (!Accept(pmt, nullptr)) return VFW_E_INVALIDMEDIATYPE;
  if (peer_) {
    // Connected already: only a type the peer takes, and only while stopped.
    if (filter_->StateNow() != State_Stopped) return VFW_E_NOT_STOPPED;
    if (peer_->QueryAccept(pmt) != S_OK) return VFW_E_INVALIDMEDIATYPE;
  }
  if (hasWanted_) FreeFormat(wanted_);
  hasWanted_ = SUCCEEDED(CopyType(wanted_, *pmt));
  return hasWanted_ ? S_OK : E_OUTOFMEMORY;
}

STDMETHODIMP Pin::GetFormat(AM_MEDIA_TYPE** pmt) {
  if (!pmt) return E_POINTER;
  Lock l(lock_);
  auto* mt = static_cast<AM_MEDIA_TYPE*>(CoTaskMemAlloc(sizeof(AM_MEDIA_TYPE)));
  if (!mt) return E_OUTOFMEMORY;
  HRESULT hr;
  if (hasType_) hr = CopyType(*mt, type_);
  else if (hasWanted_) hr = CopyType(*mt, wanted_);
  else {
    Size s;
    REFERENCE_TIME interval;
    Offered(&s, &interval);
    hr = MakeType(*mt, kNv12, s, interval);
  }
  if (FAILED(hr)) {
    CoTaskMemFree(mt);
    return hr;
  }
  *pmt = mt;
  return S_OK;
}

STDMETHODIMP Pin::GetStreamCaps(int index, AM_MEDIA_TYPE** pmt, BYTE* caps) {
  if (!pmt || !caps) return E_POINTER;
  if (index < 0 || ULONG(index) >= EnumTypes::Count()) return S_FALSE;
  Size first;
  REFERENCE_TIME interval;
  Offered(&first, &interval);
  Pixel p;
  Size s;
  EnumTypes::Nth(ULONG(index), first, &p, &s);
  auto* mt = static_cast<AM_MEDIA_TYPE*>(CoTaskMemAlloc(sizeof(AM_MEDIA_TYPE)));
  if (!mt) return E_OUTOFMEMORY;
  HRESULT hr = MakeType(*mt, p, s, interval);
  if (FAILED(hr)) {
    CoTaskMemFree(mt);
    return hr;
  }
  auto* c = reinterpret_cast<VIDEO_STREAM_CONFIG_CAPS*>(caps);
  std::memset(c, 0, sizeof *c);
  c->guid = kFormatVideoInfo;
  c->VideoStandard = 0;
  c->InputSize = {s.width, s.height};
  c->MinCroppingSize = c->MaxCroppingSize = {s.width, s.height};
  c->MinOutputSize = c->MaxOutputSize = {s.width, s.height};
  c->CropGranularityX = c->CropGranularityY = 1;
  c->CropAlignX = c->CropAlignY = 1;
  c->MinFrameInterval = kSecond / 60;
  c->MaxFrameInterval = kSecond / 30;
  DWORD bits = BytesOf(p, s.width, s.height) * 8;
  c->MinBitsPerSecond = LONG(uint64_t(bits) * 30 > 0x7fffffff ? 0x7fffffff : uint64_t(bits) * 30);
  c->MaxBitsPerSecond = LONG(uint64_t(bits) * 60 > 0x7fffffff ? 0x7fffffff : uint64_t(bits) * 60);
  *pmt = mt;
  return S_OK;
}

HRESULT Pin::Active() {
  Lock l(lock_);
  if (!peer_ || !allocator_) return S_OK;  // nothing connected: nothing to send
  HRESULT hr = allocator_->Commit();
  if (FAILED(hr)) return hr;
  ResetEvent(stop_);
  thread_ = CreateThread(nullptr, 0, &Pin::ThreadMain, this, 0, nullptr);
  return thread_ ? S_OK : E_FAIL;
}

void Pin::Inactive() {
  HANDLE thread;
  {
    Lock l(lock_);
    thread = thread_;
    thread_ = nullptr;
    if (stop_) SetEvent(stop_);
    // Unblocks a GetBuffer waiting for a free sample.
    if (allocator_) allocator_->Decommit();
  }
  if (thread) {
    WaitForSingleObject(thread, INFINITE);
    CloseHandle(thread);
  }
}

// The frame to send now, in the connection's format and size.
void Pin::Fill(uint8_t* out, const Chosen& c) {
  if (!ring_.TryOpen(L"Local\\")) {
    // Not made yet (Mochi Studio hasn't sent since this computer started).
  }
  latest_.resize(mochi::kRingSlotBytes);
  uint32_t w = 0, h = 0;
  if (ring_.Read(latest_.data(), latest_.size(), &w, &h)) {
    latestW_ = int(w);
    latestH_ = int(h);
    haveLatest_ = true;
  } else {
    uint32_t sw, sh;
    // Nobody writes, or the writer stopped: the card. (A torn read keeps the last frame.)
    if (!ring_.Size(&sw, &sh)) haveLatest_ = false;
  }
  const uint8_t* src;
  int sw, sh;
  if (haveLatest_) {
    src = latest_.data();
    sw = latestW_;
    sh = latestH_;
  } else {
    if (cardW_ != c.width || cardH_ != c.height) {
      card_ = mochi::DrawCard(c.width, c.height);
      cardW_ = c.width;
      cardH_ = c.height;
    }
    src = card_.data();
    sw = c.width;
    sh = c.height;
  }
  const uint8_t* nv12 = src;
  if (sw != c.width || sh != c.height || c.pixel == kNv12) {
    scaled_.resize(size_t(c.width) * c.height * 3 / 2);
    uint8_t* target = c.pixel == kNv12 ? out : scaled_.data();
    mochi::Nv12Scale(src, sw, sh, target, c.width, c.height);
    if (c.pixel == kNv12) return;
    nv12 = scaled_.data();
  }
  if (c.pixel == kYuy2) mochi::Nv12ToYuy2(nv12, c.width, c.height, out);
  else mochi::Nv12ToRgb32(nv12, c.width, c.height, out, c.bottomUp);
}

void Pin::Stream() {
  CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  Chosen c{};
  IMemAllocator* allocator;
  IMemInputPin* input;
  {
    Lock l(lock_);
    Accept(&type_, &c);
    allocator = allocator_;
    input = input_;
    allocator->AddRef();
    input->AddRef();
  }
  DWORD bytes = BytesOf(c.pixel, c.width, c.height);
  REFERENCE_TIME sent = -1;
  LARGE_INTEGER freq, t0, now;
  QueryPerformanceFrequency(&freq);
  QueryPerformanceCounter(&t0);
  uint64_t n = 0;
  for (;;) {
    // One frame per interval, on this thread's own timer.
    QueryPerformanceCounter(&now);
    double elapsedMs = double(now.QuadPart - t0.QuadPart) * 1000.0 / double(freq.QuadPart);
    double dueMs = double(n) * double(c.interval) / 10000.0;
    DWORD wait = dueMs > elapsedMs ? DWORD(dueMs - elapsedMs) : 0;
    if (WaitForSingleObject(stop_, wait) == WAIT_OBJECT_0) break;
    n++;
    REFERENCE_TIME streamNow;
    if (!filter_->StreamTime(&streamNow)) continue;  // paused: a live source sends nothing
    IMediaSample* sample = nullptr;
    if (FAILED(allocator->GetBuffer(&sample, nullptr, nullptr, 0)) || !sample) break;
    BYTE* data = nullptr;
    if (SUCCEEDED(sample->GetPointer(&data)) && data && sample->GetSize() >= long(bytes)) {
      Fill(data, c);
      sample->SetActualDataLength(long(bytes));
      // On the graph's clock when it has one; else one interval after the last.
      REFERENCE_TIME start = streamNow >= 0 ? streamNow : (sent < 0 ? 0 : sent + c.interval);
      if (sent >= 0 && start <= sent) start = sent + 1;
      REFERENCE_TIME stop = start + c.interval;
      sample->SetTime(&start, &stop);
      sample->SetSyncPoint(TRUE);
      sample->SetDiscontinuity(sent < 0);
      sent = start;
      input->Receive(sample);
    }
    sample->Release();
  }
  allocator->Release();
  input->Release();
  CoUninitialize();
}

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
    auto* f = new (std::nothrow) Filter();
    if (!f) return E_OUTOFMEMORY;
    HRESULT hr = f->QueryInterface(riid, ppv);
    f->Release();
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

const std::wstring kClassKey = std::wstring(L"Software\\Classes\\CLSID\\") + mochi::kClsidDshowCameraString;

// The filter's registration in the video input category, through the filter mapper.
HRESULT RegisterCategory(bool add) {
  HRESULT init = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  IFilterMapper2* mapper = nullptr;
  HRESULT hr = CoCreateInstance(kClsidFilterMapper2, nullptr, CLSCTX_INPROC_SERVER, IID_IFilterMapper2,
                                reinterpret_cast<void**>(&mapper));
  if (SUCCEEDED(hr)) {
    if (add) {
      REGPINTYPES type = {&kTypeVideo, &GUID_NULL};
      REGFILTERPINS pin = {};
      pin.strName = const_cast<LPWSTR>(L"Capture");
      pin.bOutput = TRUE;
      pin.nMediaTypes = 1;
      pin.lpMediaType = &type;
      REGFILTER2 rf = {};
      rf.dwVersion = 1;
      rf.dwMerit = MERIT_DO_NOT_USE;
      rf.cPins = 1;
      rf.rgPins = &pin;
      hr = mapper->RegisterFilter(mochi::kClsidDshowCamera, mochi::kCameraName, nullptr,
                                  &kVideoInputCategory, mochi::kClsidDshowCameraString, &rf);
    } else {
      hr = mapper->UnregisterFilter(&kVideoInputCategory, mochi::kClsidDshowCameraString,
                                    mochi::kClsidDshowCamera);
    }
    mapper->Release();
  }
  if (SUCCEEDED(init)) CoUninitialize();
  return hr;
}

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
  if (clsid != mochi::kClsidDshowCamera) return CLASS_E_CLASSNOTAVAILABLE;
  return g_factory.QueryInterface(riid, ppv);
}

STDAPI DllCanUnloadNow() { return g_objects == 0 && g_locks == 0 ? S_OK : S_FALSE; }

// For every app: the class under HKLM (regsvr32, as administrator), then the category.
STDAPI DllRegisterServer() {
  wchar_t path[MAX_PATH];
  if (!GetModuleFileNameW(g_module, path, MAX_PATH)) return HRESULT_FROM_WIN32(GetLastError());
  if (SetString(HKEY_LOCAL_MACHINE, kClassKey, nullptr, mochi::kCameraName) != ERROR_SUCCESS ||
      SetString(HKEY_LOCAL_MACHINE, kClassKey + L"\\InprocServer32", nullptr, path) != ERROR_SUCCESS ||
      SetString(HKEY_LOCAL_MACHINE, kClassKey + L"\\InprocServer32", L"ThreadingModel", L"Both") !=
          ERROR_SUCCESS)
    return SELFREG_E_CLASS;
  return RegisterCategory(true);
}

STDAPI DllUnregisterServer() {
  HRESULT hr = RegisterCategory(false);
  LONG r = RegDeleteTreeW(HKEY_LOCAL_MACHINE, kClassKey.c_str());
  if (r != ERROR_SUCCESS && r != ERROR_FILE_NOT_FOUND) return SELFREG_E_CLASS;
  return SUCCEEDED(hr) || hr == HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND) ? S_OK : hr;
}
