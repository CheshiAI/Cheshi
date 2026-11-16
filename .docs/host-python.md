# Managed Python for Homie host tools

Host tools with `runtime: "python3"` use a Cheshi-managed Python, not a system
interpreter. An optional exact `runtimeVersion` pins the tool's required version:

```json
{"runtime":"python3","runtimeVersion":"3.14.8","execution":"host","script":"scripts/run.py"}
```

The initial catalog supports CPython 3.14.8 on Apple Silicon and Intel Macs.
Omitting `runtimeVersion` selects the catalog default. Unsupported versions/platforms
fail explicitly; they never fall back to Homebrew, PATH or a file picker.
Shared service declarations must use matching runtime versions. Container Python
continues to use `resources.programs`; it is independent of the host runtime.

On **Review host access**, Cheshi prepares Python under its user-data directory at
`agents/host-tools/runtimes/<distribution-id>/`. The download URL, release, architecture,
archive size and SHA-256 are pinned in `host-python-catalog.mts`. There is no runtime
"latest" query or package-provided download URL. First preparation needs network
access; tools and Homies reuse the same local installation, including offline after
restart. Concurrent preparation is shared. The installer uses private staging,
verifies the archive before extraction and probes the exact interpreter version and
standard-library modules before atomically publishing the installation. Original
license files remain in the distribution. No administrator access or shell profile
changes are needed.

The publisher is [Astral's python-build-standalone](https://github.com/astral-sh/python-build-standalone/blob/main/docs/running.rst),
release [20261013](https://github.com/astral-sh/python-build-standalone/releases/tag/20261013).
Catalog checksums are taken from the publisher's GitHub release asset digests.
A catalog update requires reviewing the new publisher artifacts and testing them;
it does not silently upgrade an installed or explicitly pinned interpreter.

Runtime preparation does not approve a tool. The user still reviews the bundle's
Mac access, project and account. Existing system-Python grants need one review to
switch to the managed runtime. Subsequent reviews have no Python chooser. Package
changes still invalidate grants unless the existing local auto-approval policy is
on; revocation and command permission checks remain in force. The grant records the
managed distribution and executable fingerprint. Replaced executables or a changed
version cannot reuse a grant. Cached executable checks are not a sandbox or a full
runtime tree integrity audit. Host Python ignores user site-packages and does not
inherit PYTHONPATH or credentials. It still runs with the user's OS permissions.

Preparation failures do not grant access or execute the tool, and temporary downloads
are cleaned up. A damaged published installation is reported rather than silently
replaced while another tool could be using it. No system Python fallback is attempted.
The current distribution supplies Python and its standard library; per-Homie pip
packages are not installed. Atlas uses only the standard library. Node/Appium and
Xcode/WDA remain separate setup requirements.

Validation: `bun test desktop/test/host-python-runtime.test.ts desktop/test/host-python-registration.test.ts`
and the existing host-tool/service suites. Native Node import and package import
allowlist checks cover Electron's strip-only runtime. Actual Mac smoke validation
must run the downloaded interpreter with a PATH that cannot find system Python.
