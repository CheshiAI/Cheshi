# Agent Git platform and isolated Homie tasks

This service coordinates isolated Git changes and verifies their combined result.
The host API can submit a task to an assigned Homie in its own worktree and Docker worker.
The host records the result commit, runs the requested check against an integration
candidate, and displays its diff and evidence. GitHub PR creation, publication and
automatic merging remain separate integration work.

## Chats workflow

The separate **Isolated task** button and submission dialog have been removed.
Existing task cards still show their saved results and support inspection and stop
actions. Ordinary Worker messages go to the room's default Homie unless an explicit
mention or reply selects another participant. Worktrees are keyed by project,
Docker engine, Homie, account and task ID. Independent tasks start from the source
checkout's committed HEAD when their workspace is created. A follow-up routed to
an existing task reuses that task's files and native conversation, including after
restart. Read-only intake uses a separate baseline worktree, shared by intake requests
using that source commit. Only promotion to a new goal creates a task worktree;
routing a follow-up resumes the existing goal's workspace.
There is no automatic remote pull or update of an ongoing task's baseline.

Before a turn can run, the Worker durably queues its input and required workspace.
If the mount differs, the host freezes admission, prepares the task worktree and
replaces the idle container with that worktree mounted at `/workspace`. Its private
conversation volume survives replacement. The queued turn starts only in the
matching workspace. Unknown executions block switching and are never replayed.
Only the selected worktree is mounted; the source and other tasks are not exposed.
Existing tasks retain their legacy workspace without resetting uncommitted files;
new tasks do not inherit it. SESSION behavior is unchanged.

Intake is temporarily read-only even when saved project permissions allow writes.
The Homie records or routes the work before execution begins. If it confirms that
permissions are already allowed but ends intake without recording an action, the
Worker rechecks intake once. A second actionless response is interrupted rather
than reported as completed. Actual permission requests still wait for the user.

Worker message file links resolve `/workspace/` and relative paths against the
producing task's saved worktree, including while its container is stopped. Links
cannot escape that workspace through parent traversal or symlinks. Normal SESSION
file links retain their existing local-file behavior.

Persistent Worker worktrees live under
`userData/agents/platform/<project-and-engine-hash>/worker-workspaces/`.
The current committed source branch supplies the initial baseline; uncommitted
source changes are excluded. Worker files and Git metadata persist separately
from the source checkout, and the host protects the worktree's Git link in Docker.

## Explicit isolated-task API

The host API and existing task cards below use separate per-task executions and
candidate verification, rather than the persistent Worker conversation workflow.

The host `isolated-submit` request accepts a Homie, task, repository-relative scope
and verification command. Directory scopes end with `/`. It saves a durable request
before execution; repeating its message ID never dispatches the model again.

The selected Homie must have a ChatGPT account, project assignment, and saved file
write and command execution permissions. Its account, model, reasoning effort,
service tier and resolved profile/project instructions are preserved. This slice
supports local file/shell tools; Homies requiring external tools or enabled custom
tools are excluded. Git operations belong to the host. The starting point is the
current committed local branch, excluding uncommitted source changes.

The existing `cheshi-specialist:1` image must be available locally. For Colima,
the host `isolated-setup` action shares only this platform's project/engine directory.
This explicit action uses the existing setup service,
requires all selected-engine containers to be stopped, and restarts Colima.
Normal task submission never restarts the engine or changes its shares.

The Homie worker has network access for its model connection and no published host
port. The host exchanges authenticated requests using `docker exec` and the worker's
loopback endpoint. Credentials, runtime configuration and native session state live
in private `/agent` tmpfs and disappear when the container stops. Only the assigned
worktree is exposed. The shared Git directory and Docker socket are not mounted.
Session ID, model choice, output, commits, diff and verification evidence are saved
on the host; native thread continuation is not supported after container shutdown.

Only observed completion followed by confirmed container shutdown can produce a
successful result commit. Verification uses a separate container with a read-only
workspace and no network access. Its tools/dependencies must already be in the
image, and temporary output must go in `/tmp`. The supplied check determines what
was verified; passing it is not an automatic approval to merge.

Task cards distinguish working, checking, passed, failed, stale and unknown states.
**Stop isolated task** stops a live execution conservatively. After transport loss,
an interactive wait, or a desktop restart, **Check saved result** inspects existing
evidence without replaying the task. It can restore an already verified candidate;
an unfinished native session cannot currently be resumed or adjudicated in Chats.
The bridge removes only its own confirmed stopped containers and retains worktrees.

Chat records live in `userData/agents/chats.json`; platform ledgers and repositories
live under `userData/agents/platform/<project-and-engine-hash>/<base-ref-hash>/`.
Each project/engine/base configuration reuses one managed clone, with a maximum of
four active task executions. The app starts no isolated task until submission.

## Boundaries

- `contracts.mts`: task goals, assignees, scope, dependencies, resource limits and
  execution/session receipts. Chats validates scope and the user-supplied check;
  the host chooses images, paths, engine bindings and resource limits.
- `store.mts`: atomic JSON transactions under an exclusive directory lock. Requests
  are persisted before dispatch; state is reloaded for each transaction. A crashed
  writer's retained `state.lock` requires inspection, never automatic removal.
- `managed-worktrees.mts`: one dedicated bare clone per platform directory, with
  sibling worktrees and unique branches for attempts and integration candidates.
  The source checkout, its uncommitted files, worktrees and refs are not changed.
  Shared provisioning is serialized across processes with `repository.lock`;
  contenders wait up to 120 seconds, and a crash lock needs operator inspection.
- `git-workspaces.mts`: host-side commits, merges, scope checks and base validation.
- `service.mts`: claims, dependency inputs, candidate merges, required checks,
  interrupted-run inspection, and a publication record linking reasons to evidence.
- `../agent-management/platform-executor.mts`: the existing Homie Docker transport
  with an explicitly selected local socket, literal execution permissions, pinned
  local image IDs, resource limits and ownership-checked container operations.
- `homie-executor.mts`: per-task instances of the existing Homie worker, lazy account
  credentials, saved configuration checks, authenticated transport and stop evidence.
- `chat-service.mts` and `../agent-chats/isolated-tasks.mts`: persistent chat submission,
  isolated execution, candidate checks, interruption handling and saved-result inspection.

The caller must select a full local reference such as `refs/heads/main` or
`refs/remotes/origin/main`. Remote-tracking refs are local snapshots: this service
does not fetch GitHub, publish branches or create PRs. The caller must fetch and
recheck remote state when preparing a real publication.

## Usage

```typescript
import { AgentPlatform } from './service.mts';
import { createPlatformDockerExecutor } from '../agent-management/platform-executor.mts';

const executor = await createPlatformDockerExecutor({
  engineId: 'docker:colima-cheshi',
  permissions: { commandExecution: true, fileWrite: true },
});
const image = await executor.resolveImage('cheshi-specialist:1');
const platform = await AgentPlatform.open({
  repository: '/absolute/path/to/project',
  directory: '/absolute/path/outside/project/platform-state',
  baseRef: 'refs/heads/main', maxConcurrent: 4, executor,
});
const execution = {
  image, command: ['bun', 'scripts/implement-task.ts'],
  timeoutMs: 60_000, cpus: 1, memoryMb: 512,
};
platform.enqueue({
  id: 'api-change', assignee: 'api-worker',
  goal: 'Implement the requested API change', reason: 'Explain the user requirement',
  criteria: ['The API contract tests pass'], scope: ['src/api/'], dependencies: [], execution,
});
await platform.runTask('api-change');
const candidate = await platform.prepareCandidate(['api-change'], [
  { ...execution, command: ['bun', 'test', 'test/api-contract.test.ts'] },
]);
await platform.verifyCandidate(candidate.id);
const publication = await platform.publication(candidate.id);
```

The image must already exist locally and contain the tools/dependencies needed by
the commands. The service never pulls images or installs dependencies. Commands
run without network access or host credentials; this executor alone does not call
a model provider. Development mounts only the assigned worktree as writable;
its `.git` link file is mounted read-only so workers cannot replace it. The shared
Git directory and other worktrees are not mounted. Git commands belong to the host
orchestrator; workers receive source files and cannot run repository Git operations.
Verification mounts the complete workspace read-only; temporary outputs belong in
`/tmp`. Submodule provisioning is not supported in this slice.

The managed layout is:

```text
platform-state/
  state.json
  repository/                         # dedicated bare clone and common object store
  repository-task-<attempt-id>/        # branch: worktree/feature/task-<attempt-id>
  repository-integration-<id>/         # branch: worktree/experiment/integration-<id>
```

Each attempt has its own files, branch and Git index. Reopening the same state
directory reuses its clone; a new local source base is imported only when missing.
Task and candidate commits share objects, so merging them requires no inter-task
fetch. The source ref is resolved at dispatch and its exact commit is retained.
The publication record includes the managed repository and integration branch.
Use one stable state directory per project/configuration to retain this reuse.

State version 2 records worktree branches and paths. Version 1 clone-based state
is rejected without rewriting it: keep that directory for inspection and select a
new directory. There is no automatic migration or deletion. A missing managed
repository with saved attempts must be restored, never silently recreated.

`coordination()` shows assignees, unsatisfied dependencies and overlapping scopes.
Scope overlap is advisory because each run has a private checkout. Results outside
the declared scope fail admission. Dependencies must already exist, preventing
cycles, and their successful commits are merged before the dependent command runs.

Tasks have immutable requests; reusing an ID with different input is rejected.
`retry(id, reason)` creates a new attempt after a confirmed failure, retaining earlier
evidence. Unknown outcomes cannot be retried automatically. `inspectInterrupted()`
checks stopped/missing executions without replaying them or declaring success.
Running/unknown tasks occupy execution slots. Unresolved outcomes currently require
operator inspection; this slice has no UI for adjudicating them. Existing workspaces
and stopped containers are retained; `executor.cleanup(runId)` removes only an owned
stopped/created container. It never removes source files or workspace evidence.

Required check commands are fixed when a candidate is created. Every receipt is
bound to its run and image, and every check belongs to a specific candidate commit.
The base ref and candidate contents are checked before/after verification and again
before publication. A failed/stale candidate needs a new candidate and fresh checks.
The publication record is a snapshot, not an atomic authorization to merge: GitHub
must still validate the expected base/head and required checks at publication time.
Passing supplied commands does not establish that every natural-language criterion
was tested. Choosing adequate checks remains the caller/reviewer's responsibility.

This prototype shares one Git object store and uses a local JSON ledger. It is
not a distributed scheduler. Thousands of workers, remote Docker engines,
high-volume logs and artifact retention policies need a separate scaling phase.

## Validation and demonstration

From the repository root:

```sh
bun test desktop/test/agent-platform
bun run desktop:typecheck
bun run codegraph:server:typecheck
bun run viewer:typecheck
bun run viewer:build
node --input-type=module -e "await import('./desktop/lib/agent-platform/chat-service.mts'); await import('./desktop/lib/agent-chats/isolated-tasks.mts')"
```

Real Docker validation is opt-in and requires a running local engine plus the
existing `cheshi-specialist:1` image. It uses only temporary fixture repositories
and dedicated labelled containers, without model calls or account credentials:

```sh
CHESHI_PLATFORM_DOCKER_CONTEXT=colima-cheshi bun test desktop/test/agent-platform-docker.test.ts
CHESHI_PLATFORM_DOCKER_CONTEXT=colima-cheshi bun test desktop/test/agent-platform-homie-docker.test.ts
bun run scripts/agent-platform-demo.mts docker:colima-cheshi
```

On Colima, the temporary root must be shared with the VM at the same absolute
path. Set `TMPDIR` to that shared temporary directory if the default is not shared.
Workers still receive only their assigned worktree, not the whole VM share.
The Homie Docker test replaces the model-facing worker response with a fixture,
while exercising the real transport, native Codex sandbox, protected Git metadata,
container shutdown and host commit. It does not call a model or use real credentials.

The demo runs three deterministic workers concurrently, detects an API/consumer
contract failure after a clean Git merge, applies a dependent repair, and verifies
the new candidate. It prints the shared repository, worktree count and integration
branch. It retains its temporary repository and `publication.json` for
inspection, and removes its stopped containers. It demonstrates orchestration and
verification mechanics; it does not measure autonomous model behavior or scale.
