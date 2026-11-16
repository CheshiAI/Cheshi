#include "window_traffic_lights.h"
#import <objc/runtime.h>
#include <cmath>

@interface CheshiTrafficLightGeometry : NSObject {
 @public
  NSRect frames[3];
  NSRect bounds[3];
  CGFloat offsetX[3];
  CGFloat centerFromTop[3];
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
      geometry->frames[i] = buttons[i].frame;
      geometry->bounds[i] = buttons[i].bounds;
      NSRect frame = [buttons[i].superview convertRect:buttons[i].frame toView:nil];
      group = i == 0 ? frame : NSUnionRect(group, frame);
    }
    for (size_t i = 0; i < 3; ++i) {
      NSView *parent = buttons[i].superview;
      NSRect frame = [parent convertRect:buttons[i].frame toView:nil];
      geometry->offsetX[i] = NSMinX(frame) - NSMinX(group);
      geometry->centerFromTop[i] = parent.isFlipped
          ? NSMidY(buttons[i].frame) - NSMinY(parent.bounds)
          : NSMaxY(parent.bounds) - NSMidY(buttons[i].frame);
    }
    objc_setAssociatedObject(window, &GeometryKey, geometry, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  }

  // AppKit/Electron can reset or replace the buttons during layout. Always
  // derive geometry from the initial unscaled values, never the last frame.
  for (size_t i = 0; i < 3; ++i) {
    NSRect original = geometry->frames[i];
    NSButton *button = buttons[i];
    NSView *parent = button.superview;
    // Stay in the titlebar's local coordinates: the animated window frame and
    // the titlebar's coordinate conversion need not advance in the same phase.
    const CGFloat center = parent.isFlipped
        ? NSMinY(parent.bounds) + geometry->centerFromTop[i]
        : NSMaxY(parent.bounds) - geometry->centerFromTop[i];
    NSRect frame = NSMakeRect(
        NSMinX(original) - geometry->offsetX[i] * (1 - scale),
        center - NSHeight(original) * scale / 2,
        NSWidth(original) * scale, NSHeight(original) * scale);
    button.frame = frame;
    // Retain the original drawing coordinates so the glyph and its hit region
    // shrink together. Changing only frame size would resize the button cell.
    button.bounds = geometry->bounds[i];
    button.needsDisplay = YES;
  }
  if (scale == 1) objc_setAssociatedObject(window, &GeometryKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  return true;
}
