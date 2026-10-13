#include "window_top_highlight.h"
#include <cassert>
#include <cstdio>

int main() {
  @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 600, 400)
        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable
            | NSWindowStyleMaskResizable
        backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO;
    window.titlebarAppearsTransparent = YES;
    window.titleVisibility = NSWindowTitleHidden;
    NSView *frame = window.contentView.superview;
    NSView *decoration = nil;
    for (NSView *container in frame.subviews) for (NSView *child in container.subviews)
      if ([NSStringFromClass(child.class) isEqualToString:@"_NSTitlebarDecorationView"]) decoration = child;
    const NSRect originalFrame = window.frame;
    const NSWindowStyleMask originalStyle = window.styleMask;
    const BOOL originalShadow = window.hasShadow;
    const BOOL originalVisibility = decoration.hidden;
    NSButton *button = [window standardWindowButton:NSWindowCloseButton];
    const NSRect buttonFrame = button.frame;
    SEL action = button.action;
    id target = button.target;
    for (int pass = 0; pass < 3; ++pass) {
      assert(SetWindowTopHighlightHidden(window, true) == (decoration != nil));
      if (decoration) assert(decoration.hidden);
      assert(NSEqualRects(window.frame, originalFrame));
      assert(window.styleMask == originalStyle && window.hasShadow == originalShadow);
      assert(NSEqualRects(button.frame, buttonFrame));
      assert(!button.hidden && button.action == action && button.target == target);
      assert(!frame.hidden && !window.contentView.hidden);
    }
    SetWindowTopHighlightHidden(window, false);
    assert(decoration.hidden == originalVisibility);
    if (decoration) {
      decoration.hidden = YES;
      SetWindowTopHighlightHidden(window, true);
      SetWindowTopHighlightHidden(window, false);
      assert(decoration.hidden);
      decoration.hidden = originalVisibility;
    }
    assert(!SetWindowTopHighlightHidden(nil, true));
    NSWindow *borderless = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 100, 100)
        styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    borderless.releasedWhenClosed = NO;
    assert(!SetWindowTopHighlightHidden(borderless, true));
    [borderless close];
    [window close];
    std::puts("Native top highlight targeting, frame preservation and restoration passed.");
  }
}
