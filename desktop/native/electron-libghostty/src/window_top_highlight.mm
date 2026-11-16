#include "window_top_highlight.h"
#import <objc/runtime.h>

namespace {
char OriginalVisibilityKey;
}

bool SetWindowTopHighlightHidden(NSWindow *window, bool hidden) {
  if (!window || ![NSThread isMainThread]) return false;
  // AppKit's decoration draws the two-pixel highlight above transparent titlebars.
  // This is an internal view, not a stable API: leave unknown window structures
  // untouched rather than hiding the titlebar, its buttons, or the window shadow.
  Class decorationClass = NSClassFromString(@"_NSTitlebarDecorationView");
  NSView *frame = window.contentView.superview;
  if (!decorationClass || !frame) return false;
  bool found = false;
  for (NSView *container in frame.subviews) {
    for (NSView *decoration in container.subviews) {
      if (decoration.class != decorationClass) continue;
      NSNumber *original = objc_getAssociatedObject(decoration, &OriginalVisibilityKey);
      if (hidden) {
        if (!original) objc_setAssociatedObject(decoration, &OriginalVisibilityKey,
            @(decoration.hidden), OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        decoration.hidden = YES;
      } else if (original) {
        decoration.hidden = original.boolValue;
        objc_setAssociatedObject(decoration, &OriginalVisibilityKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
      }
      found = true;
    }
  }
  return found;
}
