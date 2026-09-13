# App updates

Cheshi checks published releases in [CheshiAI/Cheshi](https://github.com/CheshiAI/Cheshi/releases)
once during startup and once per hour while the app is running. Startup does not
wait for the network request. After waking from sleep, the app checks again if
at least one hour has passed since the last attempt. Offline checks and request
failures do not interrupt work or remove an already discovered update.

A newer eligible release adds a **Bell / Update available** indicator to the
workspace status bar and the project picker. Select it to see the installed and
available versions, a plain-text release-notes excerpt, and **View full release**.
**Cancel** closes the dialog and keeps the indicator. **Update** downloads and
verifies the package, prepares workspace recovery, and restarts the app. Failed
installation attempts remain retryable.

## Previewing the update UI locally

Close the current development app, then run:

```sh
bun run desktop:dev:update-preview
```

This command sets `CHESHI_UPDATE_PREVIEW=1` for the development session. The
status bar and project picker show a simulated `v0.0.2-alpha` update with English
sample release notes. Click **Update available** to open the dialog, or **Cancel**
to close it while keeping the indicator. **Update** simulates download and install
progress, then shows an intentional error so the retry UI can be checked.
**View full release** is disabled because this release has not been published.

The preview makes no update-check requests, downloads, installation changes,
workspace checkpoints, or restart attempts. It does not publish a release.
Regular app startup still runs normally. The flag is ignored by packaged apps.
Restart with `bun run desktop:dev` to return to real update checks (unset
`CHESHI_UPDATE_PREVIEW` first if it was exported in your shell).

## Versions and release channels

- Internal testing uses `v0.0.1-alpha`, `v0.0.2-alpha`, and so on.
- Public Homebrew distribution starts separately at `v0.0.1-preview`, followed
  by `v0.0.2-preview` and subsequent preview versions.
- Preview installations consider newer preview and stable releases, never alpha
  releases. Stable installations consider only stable releases. Alpha builds can
  detect newer alpha, preview, and stable releases for internal testing.
- Every comparison uses SemVer precedence. There is no special downgrade from
  a higher-numbered alpha to `v0.0.1-preview`; internal builds are replaced
  manually when public preview distribution begins.
- Draft releases are ignored. Supported prerelease tags are included in the
  release-list query, so GitHub's **Pre-release** setting does not hide alpha or
  preview updates. Release notes retain their original language.

## Preparing an installable release

Set the app version before building and use the matching GitHub tag, for example
app version `0.0.2-alpha` and tag `v0.0.2-alpha`. Attach a ZIP containing the signed
macOS application for each supported architecture. The updater accepts either
of these asset names, with the actual version and architecture substituted:

- `Cheshi-0.0.2-alpha-darwin-arm64.zip`
- `Cheshi-darwin-arm64-0.0.2-alpha.zip`

The version comes from `APP_VERSION` in `.env.product`; increase
`APP_BUILD_NUMBER` for each distribution build as well. The existing Forge
configuration does not yet provision signing credentials. Configure signing
before producing an installer intended for automatic updates.

For Intel macOS builds, use `x64` in place of `arm64`. The asset must belong to
that exact release in CheshiAI/Cheshi and have a positive size and a GitHub asset
`digest` containing `sha256:` followed by the SHA-256 hash. The download is checked
against the recorded size and hash before Electron stages installation.

Automatic installation currently requires a packaged macOS app with a valid
Developer ID Application signature, running from a writable installation
location outside a mounted image or App Translocation. The replacement app must
also satisfy Electron's signed-update requirements. Development runs can show
update notifications but cannot install updates. Unsupported platforms and
releases without a matching verified ZIP show the release with installation
disabled and an explanation.

## Workspace recovery

Before restart, Cheshi saves workspace recovery state, including unsaved editor
content. Active chat work and nonempty chat drafts block installation until the
user finishes or clears them. Restoring a workspace does not restart running
terminal commands; those processes stop when the app exits and must be started
again manually.

Adding this feature does not publish a GitHub release or upload an installer.
An end-to-end installation test requires a separately published, signed release
and a packaged older app.
