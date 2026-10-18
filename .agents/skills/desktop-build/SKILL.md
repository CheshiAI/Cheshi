---
name: desktop-build
description: Build a Cheshi desktop app into a dated out folder, verify the package, and reveal the new build in Finder without changing view or sort settings. Use when asked to build or rebuild the app; not for renderer-only checks or publishing a release.
---

# Desktop build

Use this repository's shared packaging command from its root:

```sh
bun run desktop:package
```

- The command creates `out/YYYYMMDD-HHmmss/` using Asia/Seoul time. Concurrent or same-second builds receive a numeric suffix. Preserve previous builds.
- Builds remain in hidden `.building-*` folders until packaging and verification succeed. Report a failed build's staging path; never present it as a completed app or delete unrelated output.
- On macOS the app is inside `Cheshi-darwin-arm64/Cheshi.app` (use the actual platform/architecture printed by the command). `build.json` records the revision, dirty state, version and archive hash. Uncommitted approved changes are included; a commit is not a prerequisite.
- The command checks packaged resources and macOS signing, then reveals and selects the new build folder in Finder. Preserve the user's existing view and sort settings. It does not launch the app. If Finder automation fails, report that separately from build success. Use `--no-finder` only for headless checks or when requested.
- Run directly affected tests and typechecks for changes not already validated. Packaging alone does not verify rendered behavior.
- If working through the development app, defer automatic main-process restarts while editing so the active conversation survives. Restore any temporarily paused watcher once the work is complete. Do not terminate the active app in the middle of a build.
- Report a clickable absolute app path, build verification results and any limitations. Launching the app, UI review, release signing/notarization, commits and pushes require their own task authorization.

Implementation: [package runner](../../../scripts/package-desktop.mts), [output allocation and Finder reveal](../../../scripts/desktop-build-output.mts).
