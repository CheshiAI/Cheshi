import { stat } from 'node:fs/promises';
import path from 'node:path';
import { createWorkspaceChatHistory } from '../workspace-chat-history.mts';
import { workspaceChatServiceOptions } from '../workspace-chat-service-options.mts';
import { CodexChatService } from '../codex-chat-service.mts';
import { CodexChatContexts } from '../codex-chat-contexts.mts';
import { CodexChatSessionDeletion } from '../codex-chat-session-deletion.mts';
import { assertWorkspaceThreadIdle, holdWorkspaceJob, registerWorkspaceChatServices } from '../codex-workspace-activity.mts';
import { SchedulerCodexRunner } from './codex-runner.mts';
import type { SchedulerRunner } from './engine.mts';
import type { WorkspaceAccountSelection } from '../settings-service.mts';
import type { ChatUserInputResponse } from '../../shared/chat-user-input.ts';

type HistoryOptions = Parameters<typeof createWorkspaceChatHistory>[0];
export type BackgroundOptions = Omit<HistoryOptions, 'cwd' | 'historyDirectory' | 'accountSelection'> & {
  historyDirectory(workspace: string): string;
  accountSelection(workspace: string): WorkspaceAccountSelection;
};

/** A window owns no scheduler transport. Transports are acquired for a job and released afterward. */
export function createBackgroundScheduler(options: BackgroundOptions, makeHistory = createWorkspaceChatHistory) {
  const runners = new Map<string, SchedulerRunner & {
    respondApproval(id: string, request: string, decision: 'accept' | 'decline'): Promise<void>;
    respondInput(id: string, request: string, response: ChatUserInputResponse): Promise<void>;
  }>();
  const get = (workspace: string) => {
    const existing = runners.get(workspace); if (existing) return existing;
    let active: SchedulerCodexRunner | undefined;
    let cancelled = false;
    let job: Promise<void> | undefined;
    const listeners = new Set<() => void>();
    const changed = () => listeners.forEach(listener => listener());
    const runner = {
      attention: () => active?.attention() ?? [],
      subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
      async respondApproval(id: string, request: string, decision: 'accept' | 'decline') {
        if (!active) throw new Error('Task is no longer running.'); await active.respondApproval(id, request, decision);
      },
      async respondInput(id: string, request: string, response: ChatUserInputResponse) {
        if (!active) throw new Error('Task is no longer running.'); await active.respondInput(id, request, response);
      },
      async cancel(id: string) { cancelled = true; await active?.cancel(id); await job; },
      run: ((run, update) => {
        if (job) return Promise.reject(new Error('A scheduled task is already running in this workspace.'));
        cancelled = false;
        let finished = false;
        const record: typeof update = patch => {
          if (patch.status && ['completed', 'failed', 'cancelled', 'unknown'].includes(patch.status)) finished = true;
          update(patch);
        };
        job = (async () => {
          const releaseJob = holdWorkspaceJob(workspace);
          try {
            if (!path.isAbsolute(workspace) || workspace === '/' || !(await stat(workspace)).isDirectory()) throw new Error('Workspace folder is unavailable.');
            if (cancelled) { update({ status: 'cancelled', finishedAt: new Date().toISOString() }); return; }
            const history = makeHistory({ ...options, cwd: workspace,
              historyDirectory: options.historyDirectory(workspace), accountSelection: options.accountSelection(workspace) });
            const accounts = history.accounts;
            let primary: CodexChatService | undefined;
            let contexts: CodexChatContexts | undefined;
            let selection: ReturnType<typeof accounts.register> | undefined;
            let removeServices = () => {};
            let remove = () => {};
            try {
              const client = accounts.createClient();
              const serviceOptions = workspaceChatServiceOptions(workspace, accounts.conversations, accounts.createClient);
              primary = new CodexChatService({ ...serviceOptions, client });
              contexts = new CodexChatContexts({ createClient: accounts.createClient, service: serviceOptions, emit() {} });
              const deletion = new CodexChatSessionDeletion({ service: primary, contexts, relays: { get: () => null } });
              const service = primary; const panes = contexts;
              removeServices = registerWorkspaceChatServices(workspace, () => [service, ...panes.allServices().map(item => item.service)]);
              const accountSelection = accounts.register({ ipc: { handle() {} }, assertSender() {}, retained: [client], service: primary,
                contexts, deletion, relays: { get: () => null }, accountUsage: { async stop() {} }, temporaryBusy: () => false,
                resetTemporary() {}, emit() {} });
              selection = accountSelection;
              active = new SchedulerCodexRunner({ contexts, deletion, profileId: () => accountSelection.activeId,
                assertThreadAvailable: thread => assertWorkspaceThreadIdle(workspace, thread),
                async beforeMessage() {
                  await accountSelection.initialize(() => {});
                  if (cancelled) throw new Error('Scheduled task stopped.');
                  await accounts.beforeMessage();
                } });
              remove = active.subscribe(changed);
              await active.run(run, record);
            }
            finally {
              remove(); active = undefined; changed(); removeServices();
              const cleanup = await Promise.allSettled([contexts?.stop(), primary?.stop(), history.search.stop()]);
              if (selection) await selection.stop(); else await accounts.stop();
              for (const result of cleanup) if (result.status === 'rejected') console.warn('[cheshi:scheduler] Background cleanup failed:', String(result.reason));
            }
          } finally { releaseJob(); }
        })().catch(error => {
          if (!finished) record({ status: cancelled ? 'cancelled' : 'failed', summary: String(error), finishedAt: new Date().toISOString() });
          else console.warn('[cheshi:scheduler] Background cleanup failed:', String(error));
        })
          .finally(() => { job = undefined; });
        return job;
      }) satisfies SchedulerRunner['run'],
    };
    runners.set(workspace, runner); return runner;
  };
  return { get };
}
