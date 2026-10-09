#include "window_traffic_lights.h"
#include <cassert>
#include <cmath>
#include <cstdio>
#include <limits>

namespace {
void Near(CGFloat actual, CGFloat expected) { assert(std::abs(actual - expected) < 0.001); }
NSRect WindowFrame(NSButton *button) { return [button.superview convertRect:button.frame toView:nil]; }

void CheckWindow(NSWindow *window) {
  NSButton *buttons[] = {
    [window standardWindowButton:NSWindowCloseButton],
    [window standardWindowButton:NSWindowMiniaturizeButton],
    [window standardWindowButton:NSWindowZoomButton],
  };
  NSRect original[3], bounds[3];
  SEL actions[3];
  __weak id targets[3];
  for (size_t i = 0; i < 3; ++i) {
    original[i] = WindowFrame(buttons[i]); bounds[i] = buttons[i].bounds;
    actions[i] = buttons[i].action; targets[i] = buttons[i].target;
  }
  const CGFloat topCenter = NSHeight(window.frame) - NSMidY(original[0]);
  for (int pass = 0; pass < 4; ++pass) {
    if (pass == 2) {
      // Simulate AppKit resetting frames on a resize, while retaining bounds.
      NSRect frame = window.frame;
      frame.size.height += 100; frame.size.width += 80;
      [window setFrame:frame display:NO];
      for (size_t i = 0; i < 3; ++i) buttons[i].frame = original[i];
    }
    assert(SetWindowTrafficLightScale(window, 0.8));
    for (size_t i = 0; i < 3; ++i) {
      NSButton *button = buttons[i];
      NSRect actual = WindowFrame(button);
      Near(NSWidth(actual), NSWidth(original[i]) * 0.8);
      Near(NSHeight(actual), NSHeight(original[i]) * 0.8);
      Near(NSMinX(actual), NSMinX(original[0]) + (NSMinX(original[i]) - NSMinX(original[0])) * 0.8);
      Near(NSHeight(window.frame) - NSMidY(actual), topCenter);
      Near(NSMinX(button.bounds), NSMinX(bounds[i]));
      Near(NSMinY(button.bounds), NSMinY(bounds[i]));
      Near(NSWidth(button.bounds), NSWidth(bounds[i]));
      Near(NSHeight(button.bounds), NSHeight(bounds[i]));
      assert(button.action == actions[i] && button.target == targets[i]);
      NSPoint center = NSMakePoint(NSMidX(button.frame), NSMidY(button.frame));
      assert([button hitTest:center] == button);
      assert([button hitTest:NSMakePoint(NSMaxX(button.frame) + 2, center.y)] == nil);
    }
  }
  assert(SetWindowTrafficLightScale(window, 1));
  for (size_t i = 0; i < 3; ++i) {
    NSRect actual = WindowFrame(buttons[i]);
    Near(NSWidth(actual), NSWidth(original[i]));
    Near(NSMinX(actual), NSMinX(original[i]));
    Near(NSHeight(window.frame) - NSMidY(actual), topCenter);
  }
  assert(!SetWindowTrafficLightScale(window, 0));
  assert(!SetWindowTrafficLightScale(window, 1.1));
  assert(!SetWindowTrafficLightScale(window, std::numeric_limits<double>::quiet_NaN()));
  assert(SetWindowTrafficLightScale(window, 0.8));
  Near(NSWidth(WindowFrame(buttons[0])), NSWidth(original[0]) * 0.8);
  assert(SetWindowTrafficLightScale(window, 1));
}
}

int main() {
  @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    for (int i = 0; i < 2; ++i) {
      NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 600 + i * 100, 400)
          styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable
              | NSWindowStyleMaskResizable | NSWindowStyleMaskFullSizeContentView
          backing:NSBackingStoreBuffered defer:NO];
      window.releasedWhenClosed = NO;
      window.titlebarAppearsTransparent = YES;
      window.titleVisibility = NSWindowTitleHidden;
      CheckWindow(window);
      [window close];
    }
    assert(!SetWindowTrafficLightScale(nil, 0.8));
    std::puts("Native traffic light geometry, hit regions, actions and restoration passed.");
  }
}
