---
name: desktop-ui-check
description: Verify Cheshi development-app interactions through Node Inspector and Electron CDP, including DOM measurements, real mouse input, and state-preserving scenarios. Use when the user requests checking the running development app or rendered behavior, including 개발앱에서 확인해줘.
---

# Desktop UI check

Use this checkout's running macOS development app for authorized interaction
checks. This complements automated tests; it does not replace visual review of
colors, clipping, blur, or overlap. Use screenshots/Computer Use when those are
the acceptance criteria. Follow the repository's app-review authorization rules;
general code/test requests do not authorize app interaction. Do not ask again
when the conversation already authorizes the same review scope.

## Run

From the repository root:

```sh
# Read only pane visibility and geometry (no document or chat contents).
bun .agents/skills/desktop-ui-check/scripts/inspect-desktop.mts

# Exercise each visible file pane's maximize/restore button.
bun .agents/skills/desktop-ui-check/scripts/inspect-desktop.mts --scenario editor-maximize
```

The runner locates exactly one main process at this checkout's
`desktop/.development/Cheshi Development.app/Contents/MacOS/Electron` with this
checkout as its sole argument. It checks the listener's PID before connecting
and confirms the process identity through Inspector. It never chooses the first
arbitrary Electron app or kills/restarts an app. If none is running, start
`bun run desktop:dev` within the authorized review scope, then retry. An
ambiguous process/window or another application's port is a stop condition.

Default Inspector port is 9229. `--port N` can select an already-open Inspector
owned by the same process; SIGUSR1 activation is supported only on the default
port. The runner closes an Inspector it opened, and preserves a pre-existing
one. It refuses an already-attached renderer debugger or open DevTools.
Sandbox process, loopback, signal, or filesystem denials require the normal
authorized escalation; they are not product defects. Never bypass a rejection.

`editor-maximize` requires at least two visible text editor panes in an initially
unmaximized workspace. It preserves documents, selections, scroll positions,
focus and layout; no file is saved. It checks the entire workspace content width,
including the mixed editor/chat layout. If prerequisites are missing, report
that condition or prepare the view only within the user's approved scope.

## Add a task-specific scenario

Pass `--scenario /absolute/path/to/scenario.mts`. The file is trusted executable
code, not data. Read it before running. Keep reusable scenarios in
[scenarios/](scenarios/); use `/tmp` for one-off probes and output. Never commit
captured document/chat contents, credentials, screenshots, or machine paths.

See [editor-maximize.mts](scenarios/editor-maximize.mts) for a complete example
and [renderer-session.mts](scripts/renderer-session.mts) for the `DesktopUI` API.
Export a default async function accepting `DesktopUI`. Its function body must be
self-contained: type-only imports are fine; runtime imports/module closures are
not serialized into the app. The runner strips TypeScript by loading with Bun,
then evaluates the function in Electron's main process with these helpers:

- `evaluate<T>(expression)`: evaluate a renderer expression and return its value.
- `click(selector)`: hit-test one visible enabled element and send CDP mouse input.
  Offscreen/obscured targets fail explicitly; scroll the relevant container into
  position first when needed, and preserve its original scroll state.
- `cdp(method, params)`: other CDP input/read commands within the review scope.
- `waitFor(expression)`: bounded polling of a renderer boolean expression.
- `cleanup(expression)`: register renderer restoration before the first action.
  Cleanup runs in reverse order on success, exception, timeout, or handled SIGINT.
- `key`: unique renderer-memory key for private snapshots. Return only checks,
  counts and geometry; keep original file/chat content in renderer memory.

Use `try/finally` or registered cleanup for transient state. Avoid reloads and
navigation unless necessary and explicitly preserve the affected drafts first.
Do not send messages, save files, run terminal commands, or perform unrelated
actions merely to test UI. Avoid concurrent user interaction during a scenario;
if it changes the expected state, report the inconclusive result.

The default deadline is 20 seconds (`--timeout-ms`, 1–60 seconds). Helpers stop
accepting actions after cancellation/deadline and restoration is attempted for
up to 5 seconds per cleanup. JavaScript already running in the renderer cannot
be forcibly cancelled: use bounded expressions and never infinite loops or
unbounded timers. Abrupt process termination/app crashes cannot guarantee
restoration; report cleanup failures and inspect the current state before retrying.

## Evidence and maintenance

Report the scenario, observed checks, runtime exception count, and any untested
visual aspects. A failed precondition is not a passed test. Nonzero exit means
failure; do not infer success from a `Debugger attached` log. Vite HMR logs show
source updates, not verification. Run only the checks needed for the change.

Validate helper changes with:

```sh
bun test ./.agents/skills/desktop-ui-check/tests/*.test.ts
bun run --bun tsc -p .agents/skills/desktop-ui-check/tsconfig.json
```

Then verify the affected scenario in the development app when authorized.
The transport follows the official [Electron Debugger API](https://www.electronjs.org/docs/latest/api/debugger)
and [Node Inspector API](https://nodejs.org/api/inspector.html).
