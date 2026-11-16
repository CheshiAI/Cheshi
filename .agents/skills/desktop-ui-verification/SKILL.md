---
name: desktop-ui-verification
description: Verify requested Cheshi development-app behavior in the current checkout using real Electron input, DOM assertions, screenshots, before/after reproduction, and verified state restoration. Use for running development-app reviews, rendered UI checks, and verification after UI fixes. This is the complete verification workflow; desktop-ui-check provides the shared Inspector/CDP transport.
---

# Development App UI Verification

Verify user interactions and outcomes in the current checkout's running development
app. The five stages and pass criteria below are mandatory. Running a script alone
does not establish successful verification. Keep the scope defined by the user;
this skill does not authorize code changes, message delivery, or data deletion.
Do not request authorization again for an already approved scope.

Use the [verification runner](scripts/verify-desktop.mts) and
[scenario template](scenarios/template.mts) for this workflow. The runner reuses
the existing Inspector/CDP transport from `desktop-ui-check`; do not duplicate
or modify that transport merely to run a verification.

## 1. Identify the Target App

- Read the repository's `AGENTS.md` and applicable local instructions. Resolve
  the absolute path of the current checkout.
- The runner verifies the macOS checkout's
  `desktop/.development/Cheshi Development.app/Contents/MacOS/Electron` process,
  launch arguments, Inspector port owner, and connected process identity.
  Never bypass these checks or substitute another Electron app.
- Stop interactions if process/window selection is ambiguous or identity does
  not match. If the app is absent, use `bun run desktop:dev` only within the
  authorized rendered-review scope.
- Do not forcibly detach existing DevTools or debuggers. Handle permission
  denials through the normal approval process. Connection failures do not
  establish product defects.

## 2. Reproduce User Actions

Write the reproduction scenario as an `.mts` script and inspect it before running.
Keep one-off scripts and reports in `/tmp`. Define:

- Preconditions: view, selected conversation/file, panels, split layout, CSS
  viewport size, and relevant zoom settings.
- Actions: click targets, input text, keys, scrolling, and viewport changes.
- Expected outcomes: focus, input value, enabled state, panel state, and layout
  after each relevant action.
- Restoration: capture affected state and register cleanup before the first mutation.

Use `ui.click()`, `ui.type()`, and `ui.key()` for test actions. These helpers send
CDP mouse and keyboard input. Reproduce first-click typing, Tab navigation,
and Escape with actual input events. Do not replace the action under test with
`element.click()`, `focus()`, or React state changes that bypass the original bug.
Direct state access is for observation, necessary preparation, and restoration;
keep preparation distinct from the actions being verified.

Use bounded `waitFor()` calls for actual completion conditions. Distinguish a
button disabled during loading from a control that still fails after completion.
Test supported minimum and ordinary window sizes as relevant; distinguish CSS
pixels from physical screenshot pixels. The bundled runner does not yet automate
window resizing, zoom, dragging, or scrolling. Use separately authorized,
state-restoring transport scenarios for these operations and report their results
separately; do not claim they ran through this runner.

Ordinary UI review does not send messages, stop responses, confirm deletion,
save files, or write to external apps. Exercise those operations only when the
user separately authorizes their verification on defined test targets. Otherwise
report them as untested.

## 3. Check Outcomes

Declare every required outcome in `requiredChecks` and await `ui.check(name,
expression)` for each one. Only literal `true` passes. Missing, duplicate,
undeclared, throwing, or false checks fail the run, including failures caught
inside a scenario. The `run` function must return nothing: returning a verdict
object is rejected. At least one completed real input action is required.

- Input and keyboard: inspect `document.activeElement`, actual input values,
  and relevant composition behavior.
- Control state: use meaningful properties such as `disabled`, `aria-expanded`,
  `aria-selected`, and `aria-current`. A closed panel may remain mounted;
  element existence alone does not establish that it is open.
- Layout: measure `getBoundingClientRect()`, scroll regions, clipping, and overlap.
  Use `elementFromPoint()` when necessary to verify a control is actually reachable.
- Visual review: when appearance, alignment, borders, colors, or clipping are in
  scope, capture the current app and open the screenshot for inspection. DOM
  measurements or successful capture alone do not prove visual correctness.
- Errors: record runtime exceptions and visible error notices. Distinguish bad
  selectors, failed preconditions, permissions, and connection errors from defects.

Example outcome assertion:

```ts
await ui.check('search focused', `document.activeElement === document.querySelector('input[aria-label="Search messages, tool activity, and file paths"]')`);
```

Do not dump conversation bodies, document contents, or credentials into logs.
Return only necessary verdicts, counts, geometry, and non-identifying state.
Keep screenshots containing user content as temporary local artifacts.

## 4. Compare Before and After

For a bug fix, establish the failing user action and expected outcome before
editing. After the fix, rerun the same scenario, inputs, viewport conditions,
and assertions. Relevant reproduction scripts and evidence from earlier turns
may be reused.

Do not add an extra click or force focus only in the post-fix run to obtain a pass.
If the verification script itself was wrong, disclose the correction and compare
both versions with the corrected scenario when possible. If the earlier version
cannot be checked, report current behavior verification without claiming a
before/after comparison.

For inspection-only requests, report reproduction, cause, and impact; code edits
still require applicable authorization. Reproduction evidence satisfies this
stage during inspection and does not require making unnecessary fixes. After
an authorized fix, run relevant regression tests, typechecks, and necessary builds,
and report them separately from app verification. HMR, builds, and tests do not
substitute for checking the actual interaction.

## 5. Restore the Original State

Before the first action, snapshot the affected state in memory: drafts, selected
conversations/files, open panels, split layout, input settings, focus, scrolling,
and window size/zoom as applicable. Keep private snapshots in renderer memory
in the runner-owned private slot; do not return or log their contents.

- Supply `snapshot`, `restore`, and `restored` renderer expressions. The runner
  registers cleanup before capturing the snapshot or allowing actions. The
  snapshot must be synchronous and read-only. Restoration expressions can access
  the private `snapshot` variable. Preserve both original values and their
  existence when restoring storage entries. Do not write drafts back over new
  user input; detect concurrent changes and report them instead.
- Attempt restoration on success, exception, and timeout. Compare the restored
  state with the snapshot; executing cleanup commands alone is insufficient.
  Throw on restoration failures so they appear in `cleanupErrors` or a separate
  follow-up verification result.
- App crashes or forced termination may prevent restoration. If the user changes
  state during verification, do not overwrite their new work. Report the current
  state that can be confirmed and any unrestored items.
- Release Inspector/debugging connections opened by the runner while preserving
  pre-existing connection settings. Leave unrelated apps, windows, and files alone.

## Run a Scenario

Copy the [template](scenarios/template.mts) to a local `.mts` file and adapt its
precondition, snapshot, restoration, assertions, and actions together. If copied
to `/tmp`, update its type-only import to the absolute location of
[scripts/verification.mts](scripts/verification.mts). The bundled template is a
runnable Saved turns open/Escape example; it requires SESSION with the panel
closed. It never submits a message or deletes data.

```sh
bun .agents/skills/desktop-ui-verification/scripts/verify-desktop.mts \
  --workspace "$PWD" \
  --scenario .agents/skills/desktop-ui-verification/scenarios/template.mts \
  --phase current \
  --timeout-ms 20000
```

Default-export a `VerificationScenario` object. Its `run: async function (ui)`
executes in Electron's main process. Functions and renderer expressions must be
self-contained: runtime imports, module constants, and enclosing variables are
not available after serialization. Await every helper. Scenario modules are
trusted local code; inspect them before importing. The runner is not a sandbox
for arbitrary scripts.

| Contract / API | Purpose |
| --- | --- |
| `name`, `requiredChecks` | Identify the scenario and its mandatory named assertions |
| `precondition` | Renderer expression that must return literal `true` before capture/actions |
| `snapshot` | Synchronous read-only expression retained privately in renderer memory |
| `restore`, `restored` | Restore affected state, then verify literal `true`, even on failure |
| `ui.evaluate(expression)` | Observe or perform explicitly described preparation; not a replacement for input |
| `ui.click(selector)` | Hit-test one visible enabled target and send real mouse input |
| `ui.type(text)` | Send nonempty text through CDP Input.insertText |
| `ui.key('Escape' / 'Tab', modifiers?)` | Send non-submitting keyboard input |
| `ui.waitFor(expression, timeoutMs?)` | Wait within the deadline for a literal `true` condition |
| `ui.check(name, expression)` | Record a required assertion; fail on anything except literal `true` |
| `ui.screenshot(name)` | Capture a PNG with a unique lowercase file stem for subsequent visual inspection |

Each renderer/CDP operation has a five-second limit; scenarios allow at most
60 seconds. Split longer reviews into independently restorable scenarios.
Cleanup runs after success, exceptions, or cancellation, with a five-second
limit for restoration and its verification together. Keep restoration bounded.
Pending renderer JavaScript cannot be forcibly undone, so never schedule delayed
mutations in `evaluate()`; use the input helpers for actions.

The CLI writes reports and screenshots to a unique directory under
`/tmp/cheshi-ui-verification` by default. `--output-dir PATH` changes that root.
It does not log private snapshots or image data. `--phase before|after|current`
labels evidence; the serialized scenario hash lets you check that before/after
runs used the same contract and actions. The phase label alone is not a comparison.
Compare both reports and their actual starting conditions. Screenshots are marked
as pending visual review until an agent opens and inspects them. A failed scenario
may have no screenshot artifact; rerun a focused capture if authorized and useful.

Validate changes to the skill with:

```sh
bun test ./.agents/skills/desktop-ui-verification/tests/verification.test.ts
bun x tsc --noEmit -p .agents/skills/desktop-ui-verification/tsconfig.json
```

The [regression tests](tests/verification.test.ts) exercise the serialized runner
through the shared transport with a fake Electron boundary. They cover missing
checks, false and caught failures, runtime errors, deadlines, restoration, and
connection release. They do not substitute for a real development-app run.

## Pass Criteria and Reporting

Report a check as passed only when all applicable criteria hold:

1. The target app belongs to the current checkout.
2. Real input reproduced the actions from the defined starting state.
3. Every required assertion passed, and requested visual inspection was performed.
4. For a fix, the post-fix run passed under the same reproduction conditions.
5. Restoration to the original state was verified.
6. Runner `ok === true`, `runtimeExceptions === 0`, and `cleanupErrors.length === 0`,
   with no failed required checks inside the result.

Summarize the tested actions/window conditions, defects and reproduction steps,
before/after results when applicable, automated checks, runtime exceptions,
restoration outcome, and untested areas. Do not generalize limited scenarios
into a claim that the entire app works correctly.

The runner enforces the declared contract, real-input count, required assertions,
restoration checks, and shared transport errors. It cannot determine whether an
assertion covers the right behavior, whether a snapshot includes all affected
state, or whether a screenshot looks correct. Review the scenario and evidence;
do not claim universal correctness from a passing script.
