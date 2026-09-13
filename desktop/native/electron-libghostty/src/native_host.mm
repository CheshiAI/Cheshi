#include <napi.h>

#include <cstdint>
#include <mutex>
#include <string>

#include "cheshi_ghostty_bridge.h"

namespace {

struct EventPayload {
  int32_t surface_id = -1;
  std::string type;
  std::string value;
};

class EventEmitter {
 public:
  static EventEmitter &Shared() {
    static EventEmitter emitter;
    return emitter;
  }

  void SetHandler(const Napi::Env &env, const Napi::Function &handler) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (handler_) {
      handler_.Release();
      handler_ = Napi::ThreadSafeFunction();
    }
    handler_ = Napi::ThreadSafeFunction::New(env, handler, "cheshi-ghostty-events", 0, 1);
  }

  void Emit(int32_t surface_id, const char *type, const char *value) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!handler_) return;
    auto *payload = new EventPayload{
        surface_id,
        type ? std::string(type) : std::string(),
        value ? std::string(value) : std::string(),
    };
    napi_status status = handler_.NonBlockingCall(
        payload,
        [](Napi::Env env, Napi::Function handler, EventPayload *event) {
          Napi::Object result = Napi::Object::New(env);
          result.Set("surfaceId", Napi::Number::New(env, event->surface_id));
          result.Set("type", Napi::String::New(env, event->type));
          result.Set("value", Napi::String::New(env, event->value));
          handler.Call({result});
          delete event;
        });
    if (status != napi_ok) delete payload;
  }

 private:
  std::mutex mutex_;
  Napi::ThreadSafeFunction handler_;
};

void BridgeEvent(int32_t surface_id, const char *type, const char *value) {
  EventEmitter::Shared().Emit(surface_id, type, value);
}

double RequireNumber(const Napi::Env &env, const Napi::Object &object, const char *key) {
  Napi::Value value = object.Get(key);
  if (!value.IsNumber()) {
    Napi::TypeError::New(env, std::string("Frame is missing numeric property '") + key + "'")
        .ThrowAsJavaScriptException();
    return 0;
  }
  return value.As<Napi::Number>().DoubleValue();
}

Napi::Value Initialize(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "Expected font directory").ThrowAsJavaScriptException();
    return env.Null();
  }
  std::string font_directory = info[0].As<Napi::String>().Utf8Value();
  return Napi::Boolean::New(env, cheshi_ghostty_initialize(font_directory.c_str()));
}

Napi::Value CreateSurface(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 4 || !info[0].IsBuffer() || !info[1].IsObject() ||
      !info[2].IsString() || !info[3].IsBoolean()) {
    Napi::TypeError::New(env, "Expected (handle, frame, workingDirectory, dark)")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  auto handle = info[0].As<Napi::Buffer<unsigned char>>();
  if (handle.Length() < sizeof(void *)) {
    Napi::TypeError::New(env, "Native window handle is too small").ThrowAsJavaScriptException();
    return env.Null();
  }
  void *root_view = *reinterpret_cast<void **>(handle.Data());
  if (!root_view) {
    Napi::Error::New(env, "Native window handle does not contain an NSView")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  Napi::Object frame = info[1].As<Napi::Object>();
  double x = RequireNumber(env, frame, "x");
  double y = RequireNumber(env, frame, "y");
  double width = RequireNumber(env, frame, "width");
  double height = RequireNumber(env, frame, "height");
  if (env.IsExceptionPending()) return env.Null();

  std::string working_directory = info[2].As<Napi::String>().Utf8Value();
  bool dark = info[3].As<Napi::Boolean>().Value();
  int32_t surface_id = cheshi_ghostty_surface_create(
      root_view, x, y, width, height, working_directory.c_str(), dark);
  return Napi::Number::New(env, surface_id);
}

Napi::Value ResizeSurface(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsObject()) {
    Napi::TypeError::New(env, "Expected (surfaceId, frame)").ThrowAsJavaScriptException();
    return env.Null();
  }
  int32_t surface_id = info[0].As<Napi::Number>().Int32Value();
  Napi::Object frame = info[1].As<Napi::Object>();
  double x = RequireNumber(env, frame, "x");
  double y = RequireNumber(env, frame, "y");
  double width = RequireNumber(env, frame, "width");
  double height = RequireNumber(env, frame, "height");
  if (env.IsExceptionPending()) return env.Null();
  return Napi::Boolean::New(
      env,
      cheshi_ghostty_surface_resize(surface_id, x, y, width, height));
}

Napi::Value DestroySurface(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "Expected surface id").ThrowAsJavaScriptException();
    return env.Null();
  }
  return Napi::Boolean::New(
      env,
      cheshi_ghostty_surface_destroy(info[0].As<Napi::Number>().Int32Value()));
}

Napi::Value SetFocus(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsBoolean()) {
    Napi::TypeError::New(env, "Expected (surfaceId, focused)").ThrowAsJavaScriptException();
    return env.Null();
  }
  return Napi::Boolean::New(
      env,
      cheshi_ghostty_surface_set_focus(
          info[0].As<Napi::Number>().Int32Value(),
          info[1].As<Napi::Boolean>().Value()));
}

Napi::Value SetOccluded(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsBoolean()) {
    Napi::TypeError::New(env, "Expected (surfaceId, occluded)").ThrowAsJavaScriptException();
    return env.Null();
  }
  return Napi::Boolean::New(
      env,
      cheshi_ghostty_surface_set_occluded(
          info[0].As<Napi::Number>().Int32Value(),
          info[1].As<Napi::Boolean>().Value()));
}

Napi::Value SetDark(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsBoolean()) {
    Napi::TypeError::New(env, "Expected dark boolean").ThrowAsJavaScriptException();
    return env.Null();
  }
  cheshi_ghostty_set_dark(info[0].As<Napi::Boolean>().Value());
  return env.Undefined();
}

Napi::Value SetEventHandler(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsFunction()) {
    Napi::TypeError::New(env, "Expected event handler").ThrowAsJavaScriptException();
    return env.Null();
  }
  EventEmitter::Shared().SetHandler(env, info[0].As<Napi::Function>());
  return env.Undefined();
}

Napi::Object InitializeModule(Napi::Env env, Napi::Object exports) {
  cheshi_ghostty_set_event_callback(&BridgeEvent);
  exports.Set("initialize", Napi::Function::New(env, Initialize));
  exports.Set("createSurface", Napi::Function::New(env, CreateSurface));
  exports.Set("resizeSurface", Napi::Function::New(env, ResizeSurface));
  exports.Set("destroySurface", Napi::Function::New(env, DestroySurface));
  exports.Set("setFocus", Napi::Function::New(env, SetFocus));
  exports.Set("setOccluded", Napi::Function::New(env, SetOccluded));
  exports.Set("setDark", Napi::Function::New(env, SetDark));
  exports.Set("setEventHandler", Napi::Function::New(env, SetEventHandler));
  return exports;
}

}  // namespace

NODE_API_MODULE(cheshi_ghostty, InitializeModule)
