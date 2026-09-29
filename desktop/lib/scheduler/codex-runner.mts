import type { ScheduleRun, SchedulerAttention } from '../../shared/scheduler.ts';
import type { ChatUserInputResponse } from '../../shared/chat-user-input.ts';
import type { CodexChatContexts } from '../codex-chat-contexts.mts';
import type { CodexChatService } from '../codex-chat-service.mts';
import type { CodexChatSessionDeletion } from '../codex-chat-session-deletion.mts';
import { approvalPresentation } from '../codex-chat-permissions.mts';
import { recordValue, stringValue } from '../codex-service-utils.mts';
import type { SchedulerRunner } from './engine.mts';

const OWNER = -1;
export class SchedulerCodexRunner implements SchedulerRunner {
  private readonly options: {
    contexts: CodexChatContexts; deletion: CodexChatSessionDeletion; beforeMessage(): Promise<void>; profileId(): string;
    assertThreadAvailable?(threadId: string): void;
  };
  private active: { id: string; service: CodexChatService; controller: AbortController; done: Promise<void>; cancelled?: () => void } | null = null;
  private job: { id: string; controller: AbortController; done: Promise<void> } | null = null;
  busy = false;
  private readonly listeners = new Set<() => void>();
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed(): void { this.listeners.forEach(listener => listener()); }
  constructor(options: SchedulerCodexRunner['options']) { this.options = options; }
  attention(): SchedulerAttention[] {
    if (!this.active) return [];
    const { id: runId, service } = this.active;
    return [{ runId, approvals: [...service.pendingApprovals].map(([id, request]) => ({ id, ...approvalPresentation(request.method, request.params) })),
      inputs: service.userInputs.list() }];
  }
  async respondApproval(runId: string, id: string, decision: 'accept' | 'decline'): Promise<void> {
    if (this.active?.id !== runId) throw new Error('This task is no longer running.');
    await this.active.service.respondToApproval(id, decision);
  }
  async respondInput(runId: string, id: string, response: ChatUserInputResponse): Promise<void> {
    if (this.active?.id !== runId) throw new Error('This task is no longer running.');
    await this.active.service.userInputs.respond(id, response);
  }
  run(run: ScheduleRun, update: (patch: Partial<ScheduleRun>) => void): Promise<void> {
    if (this.job) return Promise.reject(new Error('A scheduled task is already running.'));
    const controller = new AbortController();
    const done = this.perform(run, update, controller).finally(() => { this.job = null; });
    this.job = { id: run.id, controller, done };
    return done;
  }
  private async perform(run: ScheduleRun, update: (patch: Partial<ScheduleRun>) => void, controller: AbortController): Promise<void> {
    let submitted = false;
    try {
      await this.options.beforeMessage();
      controller.signal.throwIfAborted();
      this.busy = true;
      const service = this.options.contexts.get(OWNER, `scheduler-${run.id}`);
      this.active = { id: run.id, service, controller, done: Promise.resolve() };
      this.changed();
      this.active.done = this.execute(service, controller, run, update, () => { submitted = true; });
      await this.active.done;
    } catch (error) {
      update({ status: submitted && !(error instanceof Error && error.name === 'CodexMessageNotSent') ? 'unknown' : controller.signal.aborted ? 'cancelled' : 'failed',
        summary: error instanceof Error ? error.message : String(error), finishedAt: new Date().toISOString() });
    } finally {
      this.active = null;
      this.changed();
      try { await this.options.contexts.disposeOwner(OWNER); }
      finally { this.busy = false; }
    }
  }
  private async execute(service: CodexChatService, controller: AbortController, run: ScheduleRun,
    update: (patch: Partial<ScheduleRun>) => void, submitting: () => void): Promise<void> {
    const input = run.snapshot;
    if (!input) throw new Error('Missing task configuration');
    let threadId: string | null = null;
    let turnId: string | null = null;
    const buffered: Record<string, unknown>[] = [];
    const messages = new Map<string, string>();
    let settled = false;
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const finished = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    if (this.active) this.active.cancelled = () => {
      if (settled) return;
      settled = true;
      update({ status: 'cancelled', finishedAt: new Date().toISOString(), summary: 'Task stopped by the user.' });
      resolve();
    };
    // Observe immediately, including completion arriving before turn/start acknowledges.
    void finished.catch(() => {});
    const consume = (notification: Record<string, unknown>) => {
      const params = recordValue(notification.params);
      const turn = recordValue(params?.turn);
      if (!threadId || !turnId || params?.threadId !== threadId) return;
      if (notification.method === 'error') {
        if (params.willRetry === true || settled || (params.turnId != null && params.turnId !== turnId)) return;
        settled = true;
        update({ status: 'failed', summary: stringValue(recordValue(params.error)?.message) ?? stringValue(params.message) ?? 'Codex could not complete the task.',
          finishedAt: new Date().toISOString() });
        resolve(); return;
      }
      if ((params.turnId ?? turn?.id) !== turnId) return;
      const accept = (value: unknown) => {
        const item = recordValue(value);
        if (item?.type === 'agentMessage' && (item.phase == null || item.phase === 'final_answer')) {
          const text = stringValue(item.text); if (text) messages.set(String(item.id), text.slice(0, 8000));
        }
      };
      if (notification.method === 'item/completed') accept(params.item);
      if (notification.method !== 'turn/completed' || settled) return;
      settled = true;
      if (Array.isArray(turn?.items)) turn.items.forEach(accept);
      const status = turn?.status === 'completed' ? 'completed' : turn?.status === 'interrupted' ? 'cancelled' : 'failed';
      update({ status, summary: (stringValue(recordValue(turn?.error)?.message) ?? [...messages.values()].join('\n\n')).slice(0, 8000),
        finishedAt: new Date().toISOString() });
      resolve();
    };
    const remove = service.client.onNotification(notification => {
      if (!['item/completed', 'turn/completed', 'error'].includes(String(notification.method))) return;
      if (!turnId) buffered.push(notification); else consume(notification);
    });
    const removeFailure = service.client.onDidFail(error => reject(error instanceof Error ? error : new Error(String(error))));
    const removeAttention = service.onEvent(event => {
      if (['approval-requested', 'approval-resolved', 'user-input-requested', 'user-input-resolved'].includes(String(event.type))) this.changed();
    });
    try {
      await this.options.deletion.mutation(async () => {
        controller.signal.throwIfAborted();
        await service.listModels();
        await service.configure({ ...(input.model ? { model: input.model } : {}), effort: input.effort });
        await service.setPermissionMode(input.permissionMode);
        controller.signal.throwIfAborted();
        const target = input.threadId && service.conversations ? await service.conversations.resolve(input.threadId, service.client) : input.threadId;
        if (target) this.options.assertThreadAvailable?.(target);
        controller.signal.throwIfAborted();
        update({ profileId: this.options.profileId(), snapshot: { ...input, model: service.currentModel()?.model ?? null, effort: service.selectedReasoningEffort } });
        submitting();
        const result = await service.sendMessage(input.prompt, run.id, null, [], target, controller.signal);
        threadId = result.threadId; turnId = result.turnId;
        if (!threadId || !turnId) throw new Error('Codex did not return the accepted task identifiers.');
        update({ threadId, turnId, status: 'running' });
        for (const notification of buffered) consume(notification);
        buffered.length = 0;
        if (controller.signal.aborted && !settled) {
          await service.cancelResponse(threadId);
          this.active?.cancelled?.();
        }
      });
      await finished;
    } finally { remove(); removeFailure(); removeAttention(); }
  }
  async cancel(id: string): Promise<void> {
    const job = this.job;
    if (!job || job.id !== id) return;
    job.controller.abort(new Error('Scheduled task stopped.'));
    const active = this.active;
    if (active) {
      for (const threadId of active.service.activeTurns.keys()) await active.service.cancelResponse(threadId);
      // Pending turn/start observes the same signal and confirms its own interruption.
      if (!active.service.pendingTurnStarts.size && !active.service.pendingNewTurnClientMessageId) active.cancelled?.();
    }
    await job.done;
  }
}
