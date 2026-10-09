import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { commitId, concurrency, executionPlan, executionReceipt, identifier, record, taskInput, text, type PlatformState } from './contracts.mts';
import { worktreeLocation } from './managed-worktrees.mts';

type Identity = Pick<PlatformState, 'repository' | 'baseRef' | 'maxConcurrent' | 'executorIdentity'>;
function validState(value: unknown, identity: Identity, directory: string): PlatformState {
  const v = record(value);
  if (v.version === 1) throw new Error('Legacy clone-based platform state is preserved. Choose a new state directory for worktrees; automatic migration is not supported.');
  if (v.version !== 2 || v.repository !== identity.repository || v.baseRef !== identity.baseRef || v.maxConcurrent !== identity.maxConcurrent || v.executorIdentity !== identity.executorIdentity
    || !Array.isArray(v.tasks) || !Array.isArray(v.candidates) || !Array.isArray(v.events)) throw new Error('Invalid platform state or changed platform configuration.');
  // Saved state is local, but malformed records must never be interpreted as success.
  for (const raw of v.tasks) {
    const task = record(raw); taskInput(task);
    if (!['queued', 'running', 'succeeded', 'failed', 'unknown'].includes(String(task.status)) || !Array.isArray(task.attempts)) throw new Error('Invalid task state.');
    for (const item of task.attempts) {
      const attempt = record(item); identifier(attempt.id); commitId(attempt.baseCommit); text(attempt.workspace, 'workspace');
      const location = worktreeLocation(directory, 'task', String(attempt.id));
      if (attempt.workspace !== location.workspace || attempt.branch !== location.branch) throw new Error('Attempt workspace does not belong to this platform.');
      if (!Number.isSafeInteger(attempt.ownerPid) || Number(attempt.ownerPid) <= 0) throw new Error('Invalid execution owner.');
      if (attempt.inputCommit !== null) commitId(attempt.inputCommit);
      if (attempt.resultCommit !== null) commitId(attempt.resultCommit);
      if (attempt.receipt !== null) executionReceipt(attempt.receipt, { id: String(attempt.id), image: record(task.execution).image as string });
      if (!Array.isArray(attempt.dependencyCommits)) throw new Error('Invalid dependency commits.');
      attempt.dependencyCommits.forEach(commitId);
      if (!['running', 'succeeded', 'failed', 'unknown'].includes(String(attempt.status))) throw new Error('Invalid attempt status.');
      if (attempt.status === 'succeeded' && (!attempt.resultCommit || !attempt.inputCommit || record(attempt.receipt).exitCode !== 0)) throw new Error('Incomplete successful attempt.');
    }
    const last = task.attempts.at(-1) as { status?: unknown } | undefined;
    if (task.status !== 'queued' && last?.status !== task.status) throw new Error('Task and attempt disagree.');
    if (task.status === 'queued' && last && last.status !== 'failed') throw new Error('Only a failed attempt can be requeued.');
  }
  for (const raw of v.candidates) {
    const candidate = record(raw); identifier(candidate.id); commitId(candidate.baseCommit); text(candidate.workspace, 'workspace');
    const location = worktreeLocation(directory, 'integration', String(candidate.id));
    if (candidate.workspace !== location.workspace || candidate.branch !== location.branch) throw new Error('Candidate workspace does not belong to this platform.');
    if (!Number.isSafeInteger(candidate.ownerPid) || Number(candidate.ownerPid) <= 0) throw new Error('Invalid candidate owner.');
    if (candidate.commit !== null) commitId(candidate.commit);
    if (!['preparing', 'prepared', 'conflict', 'checking', 'passed', 'failed', 'stale', 'unknown'].includes(String(candidate.status))
      || !Array.isArray(candidate.taskIds) || !candidate.taskIds.length || !Array.isArray(candidate.taskCommits)
      || candidate.taskIds.length !== candidate.taskCommits.length || !Array.isArray(candidate.checks)) throw new Error('Invalid candidate state.');
    candidate.taskIds.forEach(identifier); candidate.taskCommits.forEach(commitId);
    for (const rawCheck of candidate.checks) {
      const check = record(rawCheck); identifier(check.id); const plan = executionPlan(check.plan);
      if (check.receipt !== null) executionReceipt(check.receipt, { id: String(check.id), image: plan.image });
    }
    if (candidate.status === 'passed' && (!candidate.commit || !candidate.checks.length
      || candidate.checks.some(c => record(record(c).receipt).exitCode !== 0))) throw new Error('Incomplete candidate verification.');
  }
  const state = v as unknown as PlatformState;
  if (new Set(state.tasks.map(t => t.id)).size !== state.tasks.length || new Set(state.candidates.map(c => c.id)).size !== state.candidates.length) throw new Error('Duplicate saved identity.');
  return state;
}

/** Transactions reload under an exclusive filesystem lock, including across service instances. */
export class PlatformStore {
  private readonly directory: string;
  private readonly filename: string;
  private readonly identity: Identity;
  constructor(directory: string, identity: Identity) {
    this.directory = directory; this.filename = join(directory, 'state.json');
    this.identity = { ...identity, executorIdentity: text(identity.executorIdentity, 'executor identity'), maxConcurrent: concurrency(identity.maxConcurrent) };
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.update(() => {});
  }
  snapshot(): PlatformState {
    return validState(JSON.parse(readFileSync(this.filename, 'utf8')), this.identity, this.directory);
  }
  update<T>(operation: (state: PlatformState) => T): T {
    const lock = join(this.directory, 'state.lock');
    // Never remove somebody else's lock, including a lock retained by a crashed writer.
    mkdirSync(lock, { mode: 0o700 });
    const temporary = join(this.directory, `state-${randomUUID()}.tmp`);
    try {
      let state: PlatformState;
      try { state = this.snapshot(); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        state = { version: 2, ...this.identity, tasks: [], candidates: [], events: [] };
      }
      const result = operation(state);
      validState(state, this.identity, this.directory);
      writeFileSync(temporary, JSON.stringify(state), { mode: 0o600, flag: 'wx', flush: true });
      renameSync(temporary, this.filename);
      const fd = openSync(this.directory, 'r');
      try { fsyncSync(fd); } finally { closeSync(fd); }
      return structuredClone(result);
    } finally {
      rmSync(temporary, { force: true });
      rmSync(lock, { recursive: true });
    }
  }
}

export function event(state: PlatformState, kind: string, subject: string, detail: string): void {
  state.events.push({ at: new Date().toISOString(), kind, subject, detail });
}
