# Agent management

The Docker page manages engines, container lifecycle, logs and interactive shells. The Agents page
shows agent readiness, sign-in, conversations and task results. Both pages share
engine and worker selection within a workspace window. The manager does not install an engine,
start a provider VM, build images, create workers, delete volumes, or submit model
tasks. The current adapter adopts the verifier from
`experiments/codex-specialists/compose.yaml` using its exact Compose project and
service labels. One-off login containers are excluded.

## Boundaries

- `desktop/shared/agent-management.ts`: renderer/preload contracts and validation.
- `engine.mts`: engine-independent discovery, inspection and lifecycle interface.
- `docker.mts`: Docker CLI context adapter. Every command names its context;
  only Unix-socket engines are supported. The default Docker context is untouched.
- `service.mts`: worker health, account status, task results and control guards.
- `ipc.mts`: workspace-window and main-frame ownership checks.
- `terminal.mts`: window-owned native Ghostty sessions with backend-selected commands.
- `../agent-management-preload.cts`: validated renderer API.
- `../agent-terminal-preload.cts` and `desktop/shared/agent-terminal.ts`: validated terminal IPC.
- `desktop/frontend/src/features/docker/` and `features/agents/`: separate views.
- `desktop/frontend/src/shared/agent-management/`: shared UI and versioned state.
- `desktop/frontend/src/features/shell/AgentManagementViews.tsx`: view lifecycle;
  refreshes while either page is open and retains selection when navigating away.

The CLI is resolved from Homebrew/common installation paths, then PATH. No
Compose plugin or provider application API is needed. Docker context metadata
comes from the user's standard `.docker` directory; environment variables cannot
silently redirect the selected engine. The initial selection prefers
`colima-cheshi`, then another supported context. Navigation and refresh preserve
the chosen engine and worker while they remain available.

Start/stop/restart only target existing, labelled containers by their full IDs.
The adapter rechecks identity before actions. The service serializes actions for
the same engine/container across windows and refuses stop/restart if worker
activity cannot be verified or is busy. This health check is not an atomic lock
against tasks submitted by another client between the check and Docker's action.
Container and volume deletion are absent from the management interface.

Logs are the default view. The terminal button opens `/bin/sh` through Docker
`exec --interactive --tty` for the selected running worker, using its existing
user and permissions. Verification and execution use the same resolved local
engine socket. The renderer cannot provide a host command. This requires the
built macOS Ghostty runtime; restart the development app after native/preload changes.
Switching back to logs retains that shell, while selecting another container or
leaving Docker closes it. An exited shell can be reconnected. Shell output is
interactive terminal output, separate from the redacted log viewer below.

Automatic refresh runs every ten seconds while a management page is open, without
toggling foreground loading controls. Identical responses do not notify the UI;
existing logs and selection remain in place during background reads.

Worker reads use the inspected container's single published `127.0.0.1` port.
Remote contexts and redirects are rejected. Responses have deadlines and size
limits. Only account sign-in status is exposed; authentication files are never
read. Logs are limited to the last 200 lines, with common token forms redacted.
Task output is rendered as text. History shows up to the latest 100 tasks within
the 2 MiB API response limit; stopped workers retain data but must start before
their HTTP task history can be read. Switching engines does not migrate volumes.

## Validation

```sh
bun test desktop/test/agent-management-docker.test.ts desktop/test/agent-management-service.test.ts desktop/test/agent-management-model.test.ts desktop/test/agent-management-ipc.test.ts
bun test desktop/test/agent-management-views.test.tsx
bun test desktop/test/agent-terminal.test.ts
node --test desktop/test/agent-terminal-electron.test.ts desktop/test/ghostty-surface-host.test.ts
bun run desktop:typecheck
bun run codegraph:server:typecheck
bun run viewer:typecheck
bun run desktop:preload
bun run viewer:build
```

The HTTP test needs permission to bind a loopback port. Tests also check native
Node imports and the package inclusion filter. Rendered review of the app is
separate from these checks.

On 2026-10-02, the service was also exercised against Colima's `cheshi` profile:
discovery, worker status, logs and two saved task results succeeded. Stop/start
and restart preserved authentication, the native thread and both task records.
The verifier was left running. Other Docker-compatible providers share the
adapter contract but have not been exercised by this validation.
The terminal path also ran a real PTY command in that Colima worker as UID 1000;
the temporary verification file was removed afterward.
