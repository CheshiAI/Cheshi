# Native window glass verification — 2026-09-22

Implemented MonoCode's transparent NSWindow + WindowServer background blur approach,
including its 1% NSVisualEffectView backing. Source reference:
[MonoCode ec094811](https://github.com/hardbeat920/monocode/blob/ec09481127d4d8c0f2de2a8cddf41bbbf949cd2b/src-tauri/src/macos.rs).
The adapted native source includes the upstream MIT license.

Appearance settings apply automatically. Opacity previews change only the CSS tint;
blur changes are coalesced while dragging and flushed on release. There is no
continuous effect update loop. Unsupported native APIs and native failures fall back
to an opaque window. macOS Reduce Transparency is respected on activation/focus.

## Actual application checks

- Current checkout's Cheshi Development app, Electron 41.2.0, Chromium 146.0.7680.179,
  macOS Darwin 25.6.0, Apple Silicon.
- Final desktop composition capture showed the wallpaper and another window through
  the sidebar and main pane, with native background blur (30% opacity, radius 24).
  Renderer-only captures cannot establish the appearance of the desktop behind it.
- Clicked the actual Appearance toggle: OFF returned `active: false`, ON returned
  `active: true`, without an Apply button. The app was left enabled.
- The first automated benchmark conflicted with manual settings changes and was
  stopped. Its partial results are not used in the comparison below.

## CPU comparison

Actual Settings / Appearance screen, 1440 × 900 window, main pane glass enabled,
background opacity 15%, blur radius 64. The user-selected values were preserved.
Each phase settled for 4 seconds and sampled cumulative CPU time for approximately
20 seconds. All app descendants were included, plus WindowServer separately.
100% means one fully used CPU core. Preferences remained unchanged within each sample.

| Process group | Effect OFF | Effect ON |
| --- | ---: | ---: |
| Cheshi, all measured processes | 0.099% | 0.050% |
| WindowServer (system-wide) | 47.212% | 44.557% |

No idle CPU increase was observed in this pair. WindowServer includes other
applications, so its decrease cannot be attributed to this change. These short idle
samples do not establish performance during continuous terminal output, scrolling,
resizing, or changing background content. GPU utilization/power was not measured;
the GPU process's CPU time is included above.

## Automated validation

- Native bridge compiled and signed; initial sandbox failure was rerun successfully
  with the necessary permissions.
- Desktop, renderer, desktop-test, renderer-test typechecks passed.
- Renderer production build and preload build passed.
- Appearance service, renderer, and existing Settings tests: 22 passed.
- Packaging/import coverage and window-readiness tests: 20 passed.
- Native Node strip-only imports of the new main-process modules passed.
- Startup-paint suite has one pre-existing failure: its settings IPC source regex
  expects `getTypeSafeKey` to be immediately followed by the closing options brace,
  but HEAD already has history recall and account-selection options there. The
  unrelated assertion was not weakened. The changed first-paint test passes.
