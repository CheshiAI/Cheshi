#include "window_traffic_lights.h"
#import <objc/runtime.h>
#include <cmath>

@interface CheshiTrafficLightGeometry : NSObject {
 @public
  NSRect frames[3];
  NSRect bounds[3];
  CGFloat left;
  CGFloat centerFromTop;
  CGFloat centerY;
}
@end

@implementation CheshiTrafficLightGeometry
@end

namespace {
char GeometryKey;
}

bool SetWindowTrafficLightScale(NSWindow *window, CGFloat scale) {
  if (!window || ![NSThread isMainThread] || !std::isfinite(scale) || scale <= 0 || scale > 1) return false;
  NSButton *buttons[] = {
    [window standardWindowButton:NSWindowCloseButton],
    [window standardWindowButton:NSWindowMiniaturizeButton],
    [window standardWindowButton:NSWindowZoomButton],
  };
  for (NSButton *button : buttons) {
    if (!button.superview || NSIsEmptyRect(button.frame)) return false;
  }

  CheshiTrafficLightGeometry *geometry = objc_getAssociatedObject(window, &GeometryKey);
  if (!geometry) {
    if (scale == 1) return true;
    geometry = [CheshiTrafficLightGeometry new];
    NSRect group = NSZeroRect;
    for (size_t i = 0; i < 3; ++i) {
      geometry->frames[i] = [buttons[i].superview convertRect:buttons[i].frame toView:nil];
      geometry->bounds[i] = buttons[i].bounds;
      group = i == 0 ? geometry->frames[i] : NSUnionRect(group, geometry->frames[i]);
    }
    geometry->left = NSMinX(group);
    geometry->centerY = NSMidY(group);
    geometry->centerFromTop = NSHeight(window.frame) - geometry->centerY;
    objc_setAssociatedObject(window, &GeometryKey, geometry, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  }

  // AppKit/Electron can reset or replace the buttons during layout. Always
  // derive geometry from the initial unscaled values, never the last frame.
  const CGFloat center = NSHeight(window.frame) - geometry->centerFromTop;
  for (size_t i = 0; i < 3; ++i) {
    NSRect original = geometry->frames[i];
    NSRect frame = NSMakeRect(
        geometry->left + (NSMinX(original) - geometry->left) * scale,
        center + (NSMinY(original) - geometry->centerY) * scale,
        NSWidth(original) * scale, NSHeight(original) * scale);
    NSButton *button = buttons[i];
    button.frame = [button.superview convertRect:frame fromView:nil];
    // Retain the original drawing coordinates so the glyph and its hit region
    // shrink together. Changing only frame size would resize the button cell.
    button.bounds = geometry->bounds[i];
    button.needsDisplay = YES;
  }
  if (scale == 1) objc_setAssociatedObject(window, &GeometryKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  return true;
}
