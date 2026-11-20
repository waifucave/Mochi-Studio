// Mochi Studio's Spout2 addon: a Node-API wrapper over the Spout2
// SDK's DirectX 11 class (spoutDX, BSD-2-Clause, github.com/leadedge/Spout2).
//
//   new Sender(name)                    a Spout2 sender of that name
//   sender.sendSharedTexture(ntHandle)  sends an Electron offscreen frame's
//                                       shared D3D11 texture (an NT handle in
//                                       a Buffer), copied on the GPU
//   sender.sendImage(bgra, w, h)        sends BGRA pixels (the fallback)
//   sender.release()                    closes the sender
//   new Receiver(name)                  for tests: receive(): {width, height, format, data}
//   senders()                           the names of the senders on this computer
//
// Windows only; elsewhere the module is not built.

#include <napi.h>

#include <d3d11_1.h>
#include <string>
#include <vector>

#include "SpoutDX.h"

namespace {

class Sender : public Napi::ObjectWrap<Sender> {
 public:
  static Napi::Function Init(Napi::Env env) {
    return DefineClass(env, "Sender",
                       {
                           InstanceMethod("sendSharedTexture", &Sender::SendSharedTexture),
                           InstanceMethod("sendImage", &Sender::SendImage),
                           InstanceMethod("release", &Sender::Release),
                           InstanceAccessor("name", &Sender::Name, nullptr),
                           InstanceAccessor("width", &Sender::Width, nullptr),
                           InstanceAccessor("height", &Sender::Height, nullptr),
                       });
  }

  explicit Sender(const Napi::CallbackInfo& info) : Napi::ObjectWrap<Sender>(info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
      Napi::TypeError::New(env, "Sender(name): a name").ThrowAsJavaScriptException();
      return;
    }
    name_ = info[0].As<Napi::String>().Utf8Value();
    if (!dx_.OpenDirectX11()) {
      Napi::Error::New(env, "Spout2: DirectX 11 is not available").ThrowAsJavaScriptException();
      return;
    }
    // Spout senders frame-count by default; the sender's own rate is the page's.
    dx_.SetSenderName(name_.c_str());
    dx_.GetDX11Device()->QueryInterface(__uuidof(ID3D11Device1),
                                         reinterpret_cast<void**>(&device1_));
    open_ = true;
  }

  ~Sender() override { Close(); }

 private:
  void Close() {
    if (!open_) return;
    open_ = false;
    dx_.ReleaseSender();
    if (device1_) {
      device1_->Release();
      device1_ = nullptr;
    }
    dx_.CloseDirectX11();
  }

  // sendSharedTexture(ntHandle: Buffer): boolean
  Napi::Value SendSharedTexture(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (!open_ || !device1_ || info.Length() < 1 || !info[0].IsBuffer())
      return Napi::Boolean::New(env, false);
    auto buf = info[0].As<Napi::Buffer<uint8_t>>();
    if (buf.Length() < sizeof(HANDLE)) return Napi::Boolean::New(env, false);
    HANDLE handle = *reinterpret_cast<HANDLE*>(buf.Data());
    ID3D11Texture2D* tex = nullptr;
    HRESULT hr = device1_->OpenSharedResource1(handle, __uuidof(ID3D11Texture2D),
                                                reinterpret_cast<void**>(&tex));
    if (FAILED(hr) || !tex) return Napi::Boolean::New(env, false);
    bool ok = dx_.SendTexture(tex);
    tex->Release();
    return Napi::Boolean::New(env, ok);
  }

  // sendImage(bgra: Uint8Array, width, height): boolean
  Napi::Value SendImage(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (!open_ || info.Length() < 3 || !info[0].IsTypedArray())
      return Napi::Boolean::New(env, false);
    auto arr = info[0].As<Napi::Uint8Array>();
    uint32_t w = info[1].As<Napi::Number>().Uint32Value();
    uint32_t h = info[2].As<Napi::Number>().Uint32Value();
    if (w == 0 || h == 0 || arr.ByteLength() < size_t(w) * h * 4)
      return Napi::Boolean::New(env, false);
    return Napi::Boolean::New(env, dx_.SendImage(arr.Data(), w, h));
  }

  Napi::Value Release(const Napi::CallbackInfo& info) {
    Close();
    return info.Env().Undefined();
  }

  Napi::Value Name(const Napi::CallbackInfo& info) { return Napi::String::New(info.Env(), name_); }
  Napi::Value Width(const Napi::CallbackInfo& info) {
    return Napi::Number::New(info.Env(), open_ ? dx_.GetWidth() : 0);
  }
  Napi::Value Height(const Napi::CallbackInfo& info) {
    return Napi::Number::New(info.Env(), open_ ? dx_.GetHeight() : 0);
  }

  spoutDX dx_;
  ID3D11Device1* device1_ = nullptr;
  std::string name_;
  bool open_ = false;
};

// For tests: receives a sender's frames as RGBA pixels.
class Receiver : public Napi::ObjectWrap<Receiver> {
 public:
  static Napi::Function Init(Napi::Env env) {
    return DefineClass(env, "Receiver",
                       {
                           InstanceMethod("receive", &Receiver::Receive),
                           InstanceMethod("release", &Receiver::Release),
                       });
  }

  explicit Receiver(const Napi::CallbackInfo& info) : Napi::ObjectWrap<Receiver>(info) {
    Napi::Env env = info.Env();
    if (!dx_.OpenDirectX11()) {
      Napi::Error::New(env, "Spout2: DirectX 11 is not available").ThrowAsJavaScriptException();
      return;
    }
    if (info.Length() > 0 && info[0].IsString())
      dx_.SetReceiverName(info[0].As<Napi::String>().Utf8Value().c_str());
    open_ = true;
  }

  ~Receiver() override { Close(); }

 private:
  void Close() {
    if (!open_) return;
    open_ = false;
    dx_.ReleaseReceiver();
    dx_.CloseDirectX11();
  }

  // receive(): { width, height, name, format, data } | null
  //
  // The latest frame the receiver holds, whether or not the sender has drawn
  // since: a still page paints rarely. ReceiveTexture connects (and follows a
  // change of sender) and copies each new frame into the receiver's texture;
  // that texture is then read, twice, because SpoutDX reads through two
  // staging textures, one frame behind.
  Napi::Value Receive(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (!open_) return env.Null();
    for (int i = 0; i < 3; i++) {
      if (!dx_.ReceiveTexture()) return env.Null();
      if (!dx_.IsUpdated()) break;
      w_ = dx_.GetSenderWidth();
      h_ = dx_.GetSenderHeight();
      pixels_.assign(size_t(w_) * h_ * 4, 0);
    }
    ID3D11Texture2D* tex = dx_.GetSenderTexture();
    if (!tex || pixels_.empty()) return env.Null();
    dx_.ReadTexurePixels(tex, pixels_.data());
    dx_.ReadTexurePixels(tex, pixels_.data());
    Napi::Object out = Napi::Object::New(env);
    out.Set("width", Napi::Number::New(env, w_));
    out.Set("height", Napi::Number::New(env, h_));
    out.Set("name", Napi::String::New(env, dx_.GetSenderName()));
    // The pixels are in the sender texture's own order: DXGI format 87 is BGRA, 28 RGBA.
    out.Set("format", Napi::Number::New(env, static_cast<double>(dx_.GetSenderFormat())));
    out.Set("data", Napi::Buffer<uint8_t>::Copy(env, pixels_.data(), pixels_.size()));
    return out;
  }

  Napi::Value Release(const Napi::CallbackInfo& info) {
    Close();
    return info.Env().Undefined();
  }

  spoutDX dx_;
  std::vector<unsigned char> pixels_;
  unsigned int w_ = 0, h_ = 0;
  bool open_ = false;
};

Napi::Value Senders(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  spoutDX dx;
  std::vector<std::string> names = dx.GetSenderList();
  Napi::Array out = Napi::Array::New(env, names.size());
  for (size_t i = 0; i < names.size(); i++) out.Set(uint32_t(i), names[i]);
  return out;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("Sender", Sender::Init(env));
  exports.Set("Receiver", Receiver::Init(env));
  exports.Set("senders", Napi::Function::New(env, Senders));
  return exports;
}

}  // namespace

NODE_API_MODULE(mochi_spout, Init)
