# Local host tools

Homies can own tools that need this computer's operating system. Set
`"execution": "host"` on an otherwise normal [custom tool](custom-tools.md).
The logical name, runtime, entry script, parameters and complete text bundle
travel with the pack. Local executable paths and grants do not.

## Register and use

1. Save or apply the Homie package and assign its account and project.
2. Open the saved Homie's settings and find its tool under **Local host tools**.
3. Choose **Review host access…**, select the actual local Bun, Node or Python
   executable, and review the concise native confirmation. **View details** opens
   a read-only, scrollable panel with full paths, account/Homie IDs, entry point,
   bundle files, content hashes and temporary output location. **Back to confirmation**
   returns to the native dialog; viewing details never grants access. Closing the
   details panel or choosing **Cancel** cancels the approval.
4. Allow only a reviewed bundle. This is separate from project command permission.
   Both are required to execute. macOS Accessibility and Screen Recording grants
   remain separate OS decisions; the tool must check them itself.
5. Start the saved Homie and use a new conversation. **Run test** performs a real
   call with the same permissions and can have external effects.

Use **Revoke host access** to cancel an active invocation and deny later calls.
Changing the bundle or local executable invalidates the content-bound grant.
Reassigning the project/account does not transfer approval. A changed saved
profile cancels an active call. Grants are stored under this installation's
user-data `agents/host-tools/grants`, never in repository or exported package files.

## Automatic approval

**Local host tools → Automatically approve local tools** defaults to off. The
switch saves immediately for the saved Homie, project and account on this computer.
Its policy lives under `agents/host-tools/policies` and is never exported in a pack.

When enabled, **Configure host access…** still requires selecting each tool's
local executable initially, but skips the confirmation dialog. Later bundle
versions automatically renew their grant when invoked with that same runtime and
unchanged executable. New tools, revoked tools, replaced executables and runtime
changes require executable selection again. Existing grants from older app
versions may need one new selection to record the runtime.

Turning the switch off stops automatically approved calls and invalidates their
automatic grants. Use **Review host access…** to approve them manually. Explicit
manual grants remain valid for their reviewed bundle. **Revoke host access**
removes that tool's grant even while automatic approval remains on. Neither mode
changes project command permissions or macOS privacy permissions.

## Execution contract

The runner starts the selected executable with one fixed argument: the entry
script in a fresh copy of the reviewed pack. JSON arguments arrive on stdin.
There is no shell interpolation. Include application dependencies in the pack;
the runtime and its OS libraries must already be installed locally. The runner
does not install local software or automatically grant OS permissions.

Environment variables supplied to the program:

| Variable | Meaning |
| --- | --- |
| `HOMIE_TOOL_OUTPUT_DIR` | Private per-call output directory |
| `HOMIE_TOOL_CACHE_DIR` | Private per-call cache directory |
| `HOME` | Same per-call cache directory |
| `TMPDIR` | Same per-call output directory |
| `PATH` | `/usr/bin:/bin:/usr/sbin:/sbin` |

Locale and Python bytecode settings are also supplied; credentials and the
parent process environment are not inherited. This is **not an OS sandbox**:
the approved code still runs as the logged-in user, can read files and contact
services available to that user, and can invoke other installed programs.
The container HTTPS broker is not used; `network` and `execution: host` cannot
be declared together. Host-specific functionality belongs to the tool bundle.

Return one JSON object on stdout, at most 256 KiB:

```json
{"result":{"observed":true},"images":["capture.png"]}
```

`images` is optional; when present it contains at most one simple PNG filename
within the supplied output directory. Absolute paths, traversal, symlinks and
hard-linked evidence are rejected. PNG CRC, dimensions and decompression are
validated. Supported evidence is non-interlaced 8-bit grayscale, grayscale with
alpha, RGB or RGBA; at most 4 MiB, 8192 pixels on each side and 16 million pixels.

The worker verifies the image/hash again, writes a private temporary artifact,
and returns `{result, artifacts: [{path, sha256, width, height}]}`. Codex receives
an `inputImage` content item alongside the JSON text. Copy evidence into the
authorized report directory before replacing the worker; temporary artifacts
are not durable reports. Host call folders are removed after result collection.

The process timeout is 50 seconds within the existing 60-second request deadline.
Only one call per tool/project/account executes at a time. Cancellation and
revocation stop the process group; detached or escaped processes cannot be
guaranteed stopped without an OS sandbox. Tools must cooperate, remain one-shot
and avoid background services. A sent input or external write cannot be undone.
Interrupted operations must not be replayed automatically.

The relay keeps request receipts to prevent duplicate execution. Image bytes are
not saved in the receipt journal. Restart during image delivery reports an
unknown result rather than rerunning the tool. HTTP exchanges are bounded at
6 MiB. Existing container tools retain their previous text result format.

## Validation scope

`desktop/test/host-tools.test.ts` covers local grants, bundle/executable changes,
scope, cancellation, process limits, evidence validation, relay delivery and the
app-server JSON-RPC image response using synthetic fixtures. IPC and settings
tests cover local review actions and window ownership. These tests do not assert
actual macOS permission grants, device connectivity or rendered-app appearance.
