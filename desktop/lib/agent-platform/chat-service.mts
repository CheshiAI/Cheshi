import { createHash } from 'node:crypto';
import { access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { IsolatedWork } from '../../shared/isolated-work.ts';
import { createPlatformDockerExecutor } from '../agent-management/platform-executor.mts';
import { redactAgentLogs, type DockerCommand } from '../agent-management/docker.mts';
import { createHomieExecutor, type HomieExecutionProfile } from './homie-executor.mts';
import { AgentPlatform } from './service.mts';
import { baseReference, git } from './git-workspaces.mts';
import type { PlatformExecutor } from './contracts.mts';

export interface PlatformChatContext { workspace: string; engineId: string; agentId: string; accountId: string; prompt: string }
export type UpdateIsolatedWork = (patch: Partial<IsolatedWork>) => void;
export interface PlatformChats {
  run(context: PlatformChatContext, saved: IsolatedWork, update: UpdateIsolatedWork, signal: AbortSignal): Promise<void>;
  inspect(context: PlatformChatContext, saved: IsolatedWork): Promise<Partial<IsolatedWork>>;
  setup(context: Pick<PlatformChatContext, 'workspace' | 'engineId'>): Promise<void>;
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export function createPlatformChats(options: {
  directory: string; buildContext: string;
  profile(workspace: string, agentId: string, accountId: string): Promise<HomieExecutionProfile>;
  prepareEnvironment(engineId: string, directory: string): Promise<void>;
  run?: DockerCommand;
  /** Test boundary: retain real Git/store behavior while replacing only model/container execution. */
  executor?: (context: PlatformChatContext, update: UpdateIsolatedWork) => Promise<{ executor: PlatformExecutor; image: string; cleanup(id: string): Promise<void> }>;
}): PlatformChats {
  const root = (context: Pick<PlatformChatContext, 'workspace' | 'engineId'>) => join(options.directory, digest(`${context.workspace}\n${context.engineId}`));
  const directory = (context: PlatformChatContext, baseRef: string) => join(root(context), digest(baseReference(baseRef)));
  async function execution(context: PlatformChatContext, update: UpdateIsolatedWork, live: boolean) {
    if (options.executor) return options.executor(context, update);
    const offline = await createPlatformDockerExecutor({ engineId: context.engineId, permissions: { fileWrite: true, commandExecution: true }, run: options.run });
    const profile = live ? await options.profile(context.workspace, context.agentId, context.accountId) : undefined;
    const homie = await createHomieExecutor({ engineId: context.engineId, buildContext: options.buildContext, profile, run: options.run,
      changed: progress => update(progress) });
    return { image: live ? await offline.resolveImage('cheshi-specialist:1') : '',
      executor: { identity: homie.identity, execute: (request, signal) => request.writable ? homie.execute(request, signal) : offline.execute(request, signal),
        inspect: async id => { const status = await homie.inspect(id); return status === 'missing' ? offline.inspect(id) : status; } } satisfies PlatformExecutor,
      cleanup: async (id: string) => { await homie.cleanup(id); await offline.cleanup(id); } };
  }
  return {
    async setup(context) {
      const path = root(context); await mkdir(path, { recursive: true, mode: 0o700 });
      await options.prepareEnvironment(context.engineId, path);
    },
    async run(context, saved, update, signal) {
      let current = { ...saved };
      const publish = (patch: Partial<IsolatedWork>) => { current = { ...current, ...patch }; update(patch); };
      const baseRef = baseReference((await git(context.workspace, ['symbolic-ref', 'HEAD'])).trim());
      publish({ baseRef });
      const runtime = await execution(context, publish, true);
      signal.throwIfAborted();
      const platform = await AgentPlatform.open({ repository: context.workspace, directory: directory(context, baseRef), baseRef,
        maxConcurrent: 4, executor: runtime.executor });
      const plan = { image: runtime.image, command: ['homie-task'], timeoutMs: 15 * 60_000, cpus: 2, memoryMb: 2048 };
      // Persist the caller's exact request before dispatch. A repeated message never dispatches twice.
      platform.enqueue({ id: saved.taskId, assignee: context.agentId, goal: context.prompt, reason: context.prompt,
        criteria: [saved.check], scope: saved.scope, dependencies: [], execution: plan });
      try {
        publish({ phase: 'running' });
        const result = await platform.runTask(saved.taskId, signal), attempt = result.attempts.at(-1)!;
        publish({ workspace: attempt.workspace, branch: attempt.branch, commit: attempt.resultCommit,
          sessionId: attempt.receipt?.session?.threadId ?? current.sessionId,
          output: attempt.receipt?.output ?? current.output, error: attempt.error });
        if (result.status !== 'succeeded') { publish({ phase: result.status === 'unknown' ? 'unknown' : 'failed' }); return; }
        const diff = redactAgentLogs(await git(attempt.workspace, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', attempt.inputCommit!, attempt.resultCommit!, '--']));
        publish({ phase: 'checking', diff });
        signal.throwIfAborted();
        const prepared = await platform.prepareCandidate([saved.taskId], [{ ...plan, command: ['sh', '-lc', saved.check], timeoutMs: 120_000 }]);
        publish({ candidateId: prepared.id });
        const candidate = prepared.status === 'prepared' ? await platform.verifyCandidate(prepared.id, signal) : prepared;
        if (candidate.status === 'passed') await platform.publication(candidate.id);
        publish({ phase: candidate.status === 'passed' ? 'passed' : candidate.status === 'stale' ? 'stale' : candidate.status === 'unknown' ? 'unknown' : 'failed',
          workspace: candidate.workspace, branch: candidate.branch, commit: candidate.commit, error: candidate.error,
          output: redactAgentLogs(`${current.output}\n\nVerification:\n${candidate.checks.map(c => c.receipt?.output ?? '').join('\n')}`) });
      } catch (error) {
        const state = platform.snapshot(), task = state.tasks.find(t => t.id === saved.taskId);
        const uncertain = task && ['running', 'unknown'].includes(task.status);
        const stale = state.candidates.find(c => c.id === current.candidateId)?.status === 'stale';
        publish({ phase: uncertain || signal.aborted ? 'unknown' : stale ? 'stale' : 'failed', error: safeError(error) });
      } finally {
        // Remove only this task's stopped containers. Preserve worktrees and all recorded evidence.
        const state = platform.snapshot();
        const ids = [...(state.tasks.find(t => t.id === saved.taskId)?.attempts.map(a => a.id) ?? []),
          ...state.candidates.filter(c => c.id === current.candidateId).flatMap(c => c.checks.map(check => check.id))];
        for (const id of ids) {
          try { if (await runtime.executor.inspect(id) === 'stopped') await runtime.cleanup(id); }
          catch { /* Retain an unconfirmed container; never replace execution evidence with cleanup success. */ }
        }
      }
    },
    async inspect(context, saved) {
      if (!saved.baseRef) throw new Error('No platform execution was recorded. Create a new task after correcting its setup.');
      await access(join(directory(context, saved.baseRef), 'state.json'));
      const runtime = await execution(context, () => {}, false);
      const platform = await AgentPlatform.open({ repository: context.workspace, directory: directory(context, saved.baseRef), baseRef: saved.baseRef,
        maxConcurrent: 4, executor: runtime.executor });
      const state = await platform.inspectInterrupted(), task = state.tasks.find(t => t.id === saved.taskId);
      if (!task || task.assignee !== context.agentId) throw new Error('Saved platform task is unavailable.');
      const attempt = task.attempts.at(-1), candidate = state.candidates.find(c => c.id === saved.candidateId);
      if (candidate && (candidate.taskIds.length !== 1 || candidate.taskIds[0] !== task.id)) throw new Error('Candidate belongs to another task.');
      if (candidate?.status === 'passed') {
        await platform.publication(candidate.id);
        return { phase: 'passed', error: null, workspace: candidate.workspace, branch: candidate.branch, commit: candidate.commit,
          sessionId: attempt?.receipt?.session?.threadId ?? saved.sessionId,
          output: redactAgentLogs(`${attempt?.receipt?.output ?? saved.output}\n\nVerification:\n${candidate.checks.map(c => c.receipt?.output ?? '').join('\n')}`) };
      }
      return { phase: candidate?.status === 'stale' ? 'stale' : candidate?.status === 'failed' || candidate?.status === 'conflict' || task.status === 'failed' ? 'failed' : 'unknown',
        error: candidate?.error ?? attempt?.error ?? 'No complete verified result is recorded. This task will not be replayed automatically.',
        ...(attempt?.receipt ? { sessionId: attempt.receipt.session?.threadId ?? null, output: attempt.receipt.output } : {}) };
    },
  };
}
export function safeError(error: unknown): string {
  return redactAgentLogs(error instanceof Error ? error.message : 'Isolated task failed.').slice(0, 4000);
}
