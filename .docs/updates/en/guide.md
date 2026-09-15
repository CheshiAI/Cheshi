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
`APP_BUILD_NUMBER` for each distribution build as well. Forge uses this same
version for the app and the ZIP filename, independently of the root
`package.json` development version.

Build a signed and notarized macOS ZIP with `bun run desktop:make:signed`.
This loads the Git-ignored `.env.signing` file and enables
`CHESHI_SIGN_RELEASE=1` for Forge. Set these variables in that local file
or provide them through the build environment:

```dotenv
MACOS_SIGNING_IDENTITY="Developer ID Application: Your Company (YOURTEAMID)"
MACOS_NOTARY_PROFILE="YourNotaryProfile"
```

The identity includes the company name and Team ID. `.env.signing` is excluded
from Git and the packaged app. Both values are required
for signed builds; missing values fail configuration instead of falling back
to another identity or profile. The build machine must have
the certificate with its private key and a validated notarization profile.
Credentials stay in the macOS keychain; do not add passwords or private keys
to the repository. A signing or notarization failure fails the build.

Signed macOS builds normalize freshly compiled Bun executables before Forge
signs them. Some Bun versions leave bytes from the compiler template after
the Mach-O code signature, which causes `main executable failed strict
validation`. The build validates the declared binary ranges before removing
that unused tail; it does not skip signature verification. Forge stops at the
first signing error rather than attempting notarization of an unsigned app.
See the [Bun signing defect analysis](https://github.com/oven-sh/bun/pull/32162)
for the compiler's stale signature tail and final-page hash issues. Forge
replaces the compiler's ad-hoc signature with a verified Developer ID signature.

The ordinary `desktop:make` and `desktop:package` commands do not request
signing or notarization unless `CHESHI_SIGN_RELEASE=1` is explicitly set.
The signed build command uses the current machine's architecture and the
configured app version. It does not change the version, publish a release,
or upload to GitHub. Notarization uploads the packaged app to Apple.
Before public distribution, verify the produced app's signature, notarization
ticket, clean installation, and a real update between signed builds.

## Publishing and updating Homebrew

Merge the release changes into `main` before tagging. Build from the reviewed
commit with `bun run desktop:make:signed`, using the matching `.env.product`
version and build number. Create a draft GitHub release, upload the verified
`Cheshi-darwin-arm64-<version>.zip`, then publish the release. Uploading the ZIP
before publication ensures the Homebrew workflow can find it immediately.

[Update Homebrew tap](../../../.github/workflows/update-homebrew.yml) runs on
`release: published` for both stable and preview releases. Alpha releases are
skipped. It reads the automation from `main` and runs
[`scripts/update-homebrew-tap.mts`](../../../scripts/update-homebrew-tap.mts).
The script downloads the exact release ZIP, checks its size and SHA256 against
GitHub's asset metadata, then updates `CheshiAI/homebrew-tap` on `main`:

- `Casks/cheshi.rb` version and SHA256 are updated in one commit.
- The existing URL template resolves to the new tag and versioned ZIP name.
- App dependencies and installation settings are preserved.
- Repeating the same release creates no duplicate commit. Older releases cannot
  downgrade the cask. A changed checksum for an existing version fails; publish
  a new version instead of replacing a distributed asset.

The workflow requires an Actions repository secret named `HOMEBREW_TAP_TOKEN`
in `CheshiAI/Cheshi`. Use a fine-grained personal access token owned by an
account with access to `CheshiAI/homebrew-tap`, limited to that repository with
**Contents: read and write** permission. Complete any organization approval
required for the token. Register the value in GitHub's Actions secrets UI;
never place it in source, release notes, shell arguments, or chat. The workflow's
ordinary `GITHUB_TOKEN` has read access only and cannot write another repository.
Check the dedicated token's expiry when diagnosing permission failures.

Publish using an authorized local GitHub CLI session or the GitHub UI.
Publishing with a workflow's `GITHUB_TOKEN` does not trigger downstream release
workflows. If publishing is later moved into Actions, use an appropriately
scoped GitHub App/token or explicitly dispatch this workflow.

To retry a failed Homebrew update after correcting its cause, use Actions →
Update Homebrew tap → Run workflow on `main` with the existing published tag,
or run:

```sh
gh workflow run update-homebrew.yml --repo CheshiAI/Cheshi --ref main -f tag=v0.0.3-preview
```

Do not republish the release just to retry the tap update. If a write response
was interrupted, inspect the current cask and run result first. A conflicting
tap edit fails the original blob-SHA check instead of overwriting someone else's
change. Review that edit before retrying.

A read-only rehearsal downloads and validates an existing public ZIP without
requiring the tap token or writing a commit:

```sh
RELEASE_TAG=v0.0.2-preview bun run scripts/update-homebrew-tap.mts --dry-run
```

After publication, confirm the Actions run succeeded and the tap version, URL,
and SHA256 match the published asset. The release is published even if the
Homebrew update fails; report these stages separately and resume only the
failed stage. Local tests and a dry run do not prove the remote write permission.
Users can then run `brew update` followed by
`brew upgrade --cask --greedy cheshiai/tap/cheshi`.

## Installable asset requirements

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
