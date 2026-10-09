import { randomUUID } from 'node:crypto';
import { executionPlan, executionReceipt, identifier, taskInput, text,
  type ExecutionPlan, type IntegrationCandidate, type PlatformExecutor, type PlatformState, type PlatformTask, type TaskInput } from './contracts.mts';
import { PlatformStore, event } from './store.mts';
import { assertCleanCommit, baseReference, commitResult, GitConflict, mergeResult, platformPaths, revision } from './git-workspaces.mts';
import { assertWorktree, createWorktree, initializeRepository, managedRepository, worktreeLocation } from './managed-worktrees.mts';

export interface PlatformOptions {
  repository: string;
  directory: string;
  baseRef: string;
  maxConcurrent: number;
  executor: PlatformExecutor;
}
const now = () => new Date().toISOString();
const active = new Set<string>();
function ownerAlive(pid: number): boolean {
  if (pid === process.pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
const message = (error: unknown) => error instanceof Error ? error.message.slice(0, 4000) : 'Platform operation failed.';
function task(state: PlatformState, id: string): PlatformTask {
  const found = state.tasks.find(task => task.id === identifier(id));
  if (!found) throw new Error('Unknown platform task.');
  return found;
}
function candidate(state: PlatformState, id: string): IntegrationCandidate {
  const found = state.candidates.find(candidate => candidate.id === identifier(id));
  if (!found) throw new Error('Unknown integration candidate.');
  return found;
}
function availableSlot(state: PlatformState): void {
  const count = state.tasks.filter(t => ['running', 'unknown'].includes(t.status)).length
    + state.candidates.filter(c => ['preparing', 'checking', 'unknown'].includes(c.status)).length;
  if (count >= state.maxConcurrent) throw new Error('Platform execution slots are full. Inspect unknown runs before retrying.');
}
function completed(state: PlatformState, id: string) {
  const t = task(state, id), attempt = t.attempts.at(-1);
  if (t.status !== 'succeeded' || !attempt?.resultCommit) throw new Error(`Dependency ${id} has no successful result.`);
  return attempt;
}
function assertCurrentAttempt(t: PlatformTask, id: string): void {
  if (t.status !== 'running' || t.attempts.at(-1)?.id !== id) throw new Error('The task attempt is no longer active.');
}

/** Headless orchestration: source repository and GitHub are never mutated by this service. */
export class AgentPlatform {
  private readonly store: PlatformStore;
  private readonly options: PlatformOptions;
  private constructor(options: PlatformOptions) {
    this.options = options;
    this.store = new PlatformStore(options.directory, { repository: options.repository, baseRef: options.baseRef,
      maxConcurrent: options.maxConcurrent, executorIdentity: options.executor.identity });
  }
  static async open(options: PlatformOptions): Promise<AgentPlatform> {
    const baseRef = baseReference(options.baseRef);
    const paths = await platformPaths(options.repository, options.directory);
    await revision(paths.repository, baseRef);
    const platform = new AgentPlatform({ ...options, ...paths, baseRef });
    const state = platform.snapshot();
    await initializeRepository(paths.directory, paths.repository, state.tasks.some(t => t.attempts.length > 0) || state.candidates.length > 0);
    return platform;
  }
  snapshot(): PlatformState { return this.store.snapshot(); }
  coordination() {
    const state = this.snapshot();
    return state.tasks.map(t => ({ id: t.id, assignee: t.assignee, status: t.status,
      waitingOn: t.dependencies.filter(id => task(state, id).status !== 'succeeded'),
      overlaps: state.tasks.filter(other => other.id !== t.id && ['queued', 'running', 'unknown'].includes(other.status)
        && t.scope.some(a => other.scope.some(b => a === b || (a.endsWith('/') && b.startsWith(a)) || (b.endsWith('/') && a.startsWith(b)))))
        .map(other => other.id) }));
  }
  enqueue(input: TaskInput): PlatformTask {
    const spec = taskInput(input);
    return this.store.update(state => {
      const existing = state.tasks.find(t => t.id === spec.id);
      if (existing) {
        if (JSON.stringify(taskInput(existing)) !== JSON.stringify(spec)) throw new Error('Task ID already belongs to a different request.');
        return existing;
      }
      // Only existing dependencies are accepted, so cycles cannot be introduced.
      spec.dependencies.forEach(id => task(state, id));
      const created: PlatformTask = { ...spec, status: 'queued', attempts: [] };
      state.tasks.push(created); event(state, 'task.queued', spec.id, spec.reason);
      return created;
    });
  }
  retry(id: string, reason: string): PlatformTask {
    text(reason, 'retry reason');
    return this.store.update(state => {
      const t = task(state, id);
      if (t.status !== 'failed') throw new Error('Only a confirmed failed task can be retried.');
      t.status = 'queued'; event(state, 'task.requeued', id, reason);
      return t;
    });
  }
  async runTask(id: string, signal?: AbortSignal): Promise<PlatformTask> {
    identifier(id); signal?.throwIfAborted();
    const baseCommit = await revision(this.options.repository, this.options.baseRef);
    const runId = randomUUID(), location = worktreeLocation(this.options.directory, 'task', runId);
    const { workspace, branch } = location;
    const claimed = this.store.update(state => {
      const t = task(state, id);
      if (t.status !== 'queued') throw new Error('This task is not queued. Inspect its existing attempt.');
      availableSlot(state);
      const dependencies = t.dependencies.map(id => completed(state, id));
      t.status = 'running';
      t.attempts.push({ id: runId, ownerPid: process.pid, baseCommit, inputCommit: null, resultCommit: null,
        dependencyCommits: dependencies.map(d => d.resultCommit!), workspace, branch, receipt: null, error: null,
        status: 'running', startedAt: now(), finishedAt: null });
      event(state, 'task.claimed', id, runId);
      return { task: t, dependencies };
    });
    active.add(runId);
    let executionStarted = false, receiptConfirmed = false;
    try {
      await createWorktree(this.options.directory, this.options.repository, baseCommit, location);
      for (const dep of claimed.dependencies) await mergeResult(workspace, dep.resultCommit!);
      const inputCommit = await revision(workspace, 'HEAD');
      this.store.update(state => { const t = task(state, id); assertCurrentAttempt(t, runId); t.attempts.at(-1)!.inputCommit = inputCommit; });
      signal?.throwIfAborted();
      executionStarted = true;
      const receipt = executionReceipt(await this.options.executor.execute({ ...claimed.task.execution, id: runId, workspace, writable: true,
        task: { assignee: claimed.task.assignee, goal: claimed.task.goal, reason: claimed.task.reason, scope: claimed.task.scope, criteria: claimed.task.criteria } }, signal),
        { id: runId, image: claimed.task.execution.image });
      receiptConfirmed = true;
      this.store.update(state => { const t = task(state, id); assertCurrentAttempt(t, runId); t.attempts.at(-1)!.receipt = receipt; });
      if (receipt.exitCode !== 0) throw new Error(`Worker exited with code ${receipt.exitCode}.`);
      await assertWorktree(this.options.directory, location);
      const resultCommit = await commitResult(workspace, inputCommit, claimed.task.scope, id, claimed.task.reason);
      return this.store.update(state => {
        const t = task(state, id); assertCurrentAttempt(t, runId);
        t.status = 'succeeded'; Object.assign(t.attempts.at(-1)!, { status: 'succeeded', resultCommit, finishedAt: now() });
        event(state, 'task.succeeded', id, resultCommit); return t;
      });
    } catch (error) {
      return this.store.update(state => {
        const t = task(state, id); assertCurrentAttempt(t, runId);
        t.status = executionStarted && !receiptConfirmed ? 'unknown' : 'failed';
        Object.assign(t.attempts.at(-1)!, { status: t.status, error: message(error), finishedAt: now() });
        event(state, `task.${t.status}`, id, message(error)); return t;
      });
    } finally { active.delete(runId); }
  }
  async prepareCandidate(taskIds: string[], checks: ExecutionPlan[]): Promise<IntegrationCandidate> {
    if (!taskIds.length || taskIds.length > 32 || new Set(taskIds).size !== taskIds.length) throw new Error('Select 1–32 unique tasks.');
    if (!checks.length || checks.length > 32) throw new Error('Provide 1–32 required checks.');
    const plans = checks.map(executionPlan), baseCommit = await revision(this.options.repository, this.options.baseRef);
    const id = randomUUID(), location = worktreeLocation(this.options.directory, 'integration', id);
    const { workspace, branch } = location;
    const selected = this.store.update(state => {
      availableSlot(state);
      const tasks = taskIds.map(id => task(state, id));
      if (tasks.some(t => t.dependencies.some(dep => !taskIds.includes(dep)))) throw new Error('Include all dependency tasks in the candidate.');
      // Enqueue order is topological because dependencies must already exist.
      const ordered = state.tasks.filter(t => taskIds.includes(t.id));
      const attempts = ordered.map(t => completed(state, t.id));
      state.candidates.push({ id, ownerPid: process.pid, baseCommit, taskIds: ordered.map(t => t.id), taskCommits: attempts.map(a => a.resultCommit!),
        workspace, branch, commit: null, status: 'preparing', error: null,
        checks: plans.map(plan => ({ id: randomUUID(), plan, receipt: null })) });
      event(state, 'candidate.preparing', id, ordered.map(t => t.id).join(', '));
      return attempts;
    });
    active.add(id);
    try {
      await createWorktree(this.options.directory, this.options.repository, baseCommit, location);
      for (const attempt of selected) await mergeResult(workspace, attempt.resultCommit!);
      const commit = await revision(workspace, 'HEAD');
      await assertCleanCommit(workspace, commit);
      const current = await revision(this.options.repository, this.options.baseRef);
      return this.store.update(state => {
        const c = candidate(state, id); c.commit = commit; c.status = current === baseCommit ? 'prepared' : 'stale';
        event(state, `candidate.${c.status}`, id, commit); return c;
      });
    } catch (error) {
      return this.store.update(state => {
        const c = candidate(state, id); c.status = error instanceof GitConflict ? 'conflict' : 'failed'; c.error = message(error);
        event(state, `candidate.${c.status}`, id, c.error); return c;
      });
    } finally { active.delete(id); }
  }
  async verifyCandidate(id: string, signal?: AbortSignal): Promise<IntegrationCandidate> {
    const c = this.store.update(state => {
      const c = candidate(state, id);
      if (c.status !== 'prepared' || !c.commit) throw new Error('Create a prepared candidate before verifying.');
      availableSlot(state); c.status = 'checking'; c.ownerPid = process.pid; event(state, 'candidate.checking', id, c.commit); return c;
    });
    active.add(id);
    let unresolvedExecution = false;
    try {
      await this.assertCandidate(c);
      for (const check of c.checks) {
        signal?.throwIfAborted();
        unresolvedExecution = true;
        const receipt = executionReceipt(await this.options.executor.execute({ ...check.plan, id: check.id, workspace: c.workspace, writable: false }, signal),
          { id: check.id, image: check.plan.image });
        unresolvedExecution = false;
        this.store.update(state => { candidate(state, id).checks.find(item => item.id === check.id)!.receipt = receipt; });
        await this.assertCandidate(c);
        if (receipt.exitCode !== 0) throw new Error(`Required check exited with code ${receipt.exitCode}.`);
      }
      await this.assertCandidate(c);
      return this.store.update(state => { const c = candidate(state, id); c.status = 'passed'; event(state, 'candidate.passed', id, c.commit!); return c; });
    } catch (error) {
      return this.store.update(state => {
        const c = candidate(state, id); c.status = unresolvedExecution ? 'unknown' : error instanceof StaleCandidate ? 'stale' : 'failed'; c.error = message(error);
        event(state, `candidate.${c.status}`, id, c.error); return c;
      });
    } finally { active.delete(id); }
  }
  private async assertCandidate(c: IntegrationCandidate): Promise<void> {
    if (await revision(this.options.repository, this.options.baseRef) !== c.baseCommit) throw new StaleCandidate('The base branch changed. Create and verify a new candidate.');
    await assertWorktree(this.options.directory, c);
    await assertCleanCommit(c.workspace, c.commit!);
  }
  /** A fresh check is mandatory before presenting a candidate as ready to publish. No push or PR creation. */
  async publication(id: string) {
    const state = this.snapshot(), c = candidate(state, id);
    if (c.status !== 'passed') throw new Error('Only a verified candidate can be prepared for publication.');
    try { await this.assertCandidate(c); }
    catch (error) {
      this.store.update(state => { const c = candidate(state, id); c.status = 'stale'; c.error = message(error); event(state, 'candidate.stale', id, c.error); });
      throw error;
    }
    return { candidateId: id, repository: state.repository, baseRef: state.baseRef, baseCommit: c.baseCommit, headCommit: c.commit!,
      managedRepository: managedRepository(this.options.directory), workspace: c.workspace, branch: c.branch,
      tasks: c.taskIds.map(id => { const t = task(state, id); return { id, goal: t.goal, reason: t.reason, criteria: t.criteria, attempts: t.attempts }; }),
      checks: c.checks, guidance: 'Recheck the target branch and required checks when publishing. Publication and merge require separate authorization.' };
  }
  /** Restart inspection never replays an execution or promotes an unrecorded result to success. */
  async inspectInterrupted(): Promise<PlatformState> {
    const initial = this.snapshot();
    for (const t of initial.tasks.filter(t => t.status === 'running')) {
      const attempt = t.attempts.at(-1)!;
      if (active.has(attempt.id) || ownerAlive(attempt.ownerPid) || await this.options.executor.inspect(attempt.id) === 'running') continue;
      this.store.update(state => {
        const current = task(state, t.id);
        if (current.status !== 'running' || current.attempts.at(-1)?.id !== attempt.id) return;
        current.status = 'unknown'; current.attempts.at(-1)!.status = 'unknown';
        event(state, 'task.unknown', t.id, 'Stopped or missing execution has no confirmed completion.');
      });
    }
    for (const c of initial.candidates.filter(c => ['preparing', 'checking'].includes(c.status))) {
      if (active.has(c.id) || ownerAlive(c.ownerPid)) continue;
      const statuses = await Promise.all(c.checks.map(check => this.options.executor.inspect(check.id)));
      if (statuses.includes('running')) continue;
      this.store.update(state => {
        const current = candidate(state, c.id);
        if (!['preparing', 'checking'].includes(current.status)) return;
        current.status = 'unknown'; event(state, 'candidate.unknown', c.id, 'Interrupted preparation or verification requires inspection.');
      });
    }
    return this.snapshot();
  }
}

class StaleCandidate extends Error {}
