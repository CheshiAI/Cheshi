// Adapted from MonoCode's macOS glass implementation (MIT, Copyright 2026 Nick).
// See LICENSE.monocode. WindowServer does the desktop blur; no redraw timer is used.
#import <AppKit/AppKit.h>
#include <napi.h>
#include <dlfcn.h>
#include <cmath>
#include <cstring>

namespace {
using Connection = size_t;
using SetBlur = int (*)(Connection, int, int);
using GetConnection = Connection (*)();
SetBlur BlurFunction() {
  static auto function = reinterpret_cast<SetBlur>(dlsym(RTLD_DEFAULT, "CGSSetWindowBackgroundBlurRadius"));
  return function;
}
GetConnection ConnectionFunction() {
  static auto function = [] {
    auto result = reinterpret_cast<GetConnection>(dlsym(RTLD_DEFAULT, "CGSDefaultConnectionForThread"));
    return result ? result : reinterpret_cast<GetConnection>(dlsym(RTLD_DEFAULT, "CGSMainConnectionID"));
  }();
  return function;
}
NSString *const BackingIdentifier = @"cheshi.window-glass-backing";

NSVisualEffectView *Backing(NSWindow *window, bool create) {
  NSView *content = window.contentView;
  for (NSView *view in content.subviews) {
    if ([view.identifier isEqualToString:BackingIdentifier]) return (NSVisualEffectView *)view;
  }
  if (!create || !content) return nil;
  NSVisualEffectView *view = [[NSVisualEffectView alloc] initWithFrame:content.bounds];
  view.identifier = BackingIdentifier;
  view.material = NSVisualEffectMaterialUnderWindowBackground;
  view.blendingMode = NSVisualEffectBlendingModeBehindWindow;
  view.state = NSVisualEffectStateActive;
  view.alphaValue = 0.01;
  view.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
  [content addSubview:view positioned:NSWindowBelow relativeTo:nil];
  return view;
}

Napi::Value Supported(const Napi::CallbackInfo &info) {
  return Napi::Boolean::New(info.Env(), BlurFunction() && ConnectionFunction());
}

Napi::Value Apply(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() != 3 || !info[0].IsBuffer() || !info[1].IsBoolean() || !info[2].IsNumber()) {
    Napi::TypeError::New(env, "Expected (native window handle, enabled, blur radius)").ThrowAsJavaScriptException();
    return env.Null();
  }
  auto handle = info[0].As<Napi::Buffer<unsigned char>>();
  double radius = info[2].As<Napi::Number>().DoubleValue();
  if (handle.Length() != sizeof(void *) || !std::isfinite(radius) || radius < 0 || radius > 64 || std::floor(radius) != radius) {
    Napi::TypeError::New(env, "Invalid window handle or blur radius").ThrowAsJavaScriptException();
    return env.Null();
  }
  if (![NSThread isMainThread]) {
    Napi::Error::New(env, "Window glass must run on the main thread").ThrowAsJavaScriptException();
    return env.Null();
  }
  void *pointer = nullptr;
  std::memcpy(&pointer, handle.Data(), sizeof(pointer));
  NSView *root = (__bridge NSView *)pointer;
  NSWindow *window = root.window;
  if (!window || !BlurFunction() || !ConnectionFunction()) return Napi::String::New(env, "unsupported");
  bool requested = info[1].As<Napi::Boolean>().Value();
  bool reduced = NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceTransparency;
  bool enabled = requested && !reduced;
  int result = BlurFunction()(ConnectionFunction()(), (int)window.windowNumber, enabled ? (int)radius : 0);
  if (result != 0) {
    Backing(window, false).hidden = YES;
    window.opaque = YES;
    Napi::Error::New(env, "WindowServer could not apply background blur").ThrowAsJavaScriptException();
    return env.Null();
  }
  Backing(window, enabled).hidden = !enabled;
  window.opaque = !enabled;
  if (enabled) window.backgroundColor = [NSColor.clearColor colorWithAlphaComponent:0.01];
  window.hasShadow = YES;
  [window invalidateShadow];
  return Napi::String::New(env, enabled ? "active" : requested && reduced ? "reduced-transparency" : "disabled");
}
}

void RegisterWindowGlass(Napi::Env env, Napi::Object exports) {
  exports.Set("windowGlassSupported", Napi::Function::New(env, Supported));
  exports.Set("setWindowGlass", Napi::Function::New(env, Apply));
}
