import { WorkerVerification } from './verification.ts';
import { verificationInstructions, verificationTools } from './verification-tools.ts';
import type { RuntimeConfiguration } from './runtime-config.ts';
import type { RpcClient } from './app-server-client.ts';
import { record, textValue, type JsonRecord } from './protocol.ts';
import { AgentStore, validateTaskId, type Task } from './store.ts';
import { TurnObserver } from './turn.ts';
import { WorkerCollaboration } from './collaboration.ts';
import { collaborationInstructions, collaborationTools } from './collaboration-tools.ts';
import { historyInstructions, historyTools } from './history-tools.ts';
import type { WorkerHistoryQueue } from './history-queue.ts';
import type { WorkerHistory } from './history.ts';
import { decisionInstructions, decisionTools, finishGoal, MAX_GOAL_TURNS, newGoal, parseDecision, validateDecision } from './decision.ts';

export class TaskConflict extends Error {}

function assertChatGPTAccount(value: unknown): void {
  if (value === null || record(value).type !== 'chatgpt') {
    throw new Error('Sign in to ChatGPT in the experiment container first.');
  }
}

function assertResumedThread(expected: string | null, actual: string): void {
  if (expected && actual !== expected) throw new Error('Resumed thread id changed.');
}

type ActiveTask = {
  id: string; threadId: string | null; turnId: string | null; stopRequested: boolean;
  done: Promise<void>; observer: TurnObserver; interrupting: Promise<void> | null;
  messages: string[]; input: string; controller: AbortController;
};

export class SpecialistAgent {
  private readonly client: RpcClient;
  private readonly store: AgentStore;
  private readonly profile: string;
  private readonly workspace: string;
  private readonly configuration: RuntimeConfiguration | undefined;
  private readonly timeoutMs: number;
  private readonly loadedThreads = new Set<string>();
  private active: ActiveTask | null = null;
  private failure: string | null = null;

  private readonly verification: WorkerVerification | undefined;
  private readonly historyQueue: WorkerHistoryQueue | undefined;
  private readonly history: WorkerHistory | undefined;
  private readonly collaboration: WorkerCollaboration | undefined;
  constructor(options: { client: RpcClient; store: AgentStore; profile: string; workspace: string; timeoutMs?: number; configuration?: RuntimeConfiguration; collaboration?: WorkerCollaboration; historyQueue?: WorkerHistoryQueue; history?: WorkerHistory }) {
    this.configuration = options.configuration;
    this.verification = options.configuration?.verificationProtocol === 1 ? new WorkerVerification(options.store, options.workspace) : undefined;
    this.client = options.client; this.store = options.store; this.profile = options.profile;
    this.workspace = options.workspace; this.timeoutMs = options.timeoutMs ?? 180_000;
    this.collaboration = options.collaboration; this.historyQueue = options.historyQueue; this.history = options.history;
    if (this.collaboration || this.historyQueue || this.configuration?.decisionProtocol === 1) {
      if (!this.client.handleTools) throw new Error('Collaboration requires dynamic tool support.');
      this.client.handleTools(async params => {
        const active = this.active;
        if (!active || params.threadId !== active.threadId || (active.turnId && params.turnId !== active.turnId)) {
          throw new Error('Tool call does not belong to the active task.');
        }
        if (active.stopRequested) throw new Error('Task is stopping.');
        const tool = textValue(params.tool, 'tool');
        const task = this.store.task(active.id)!;
        if (task.goal) {
          if (tool === 'goal_status') return { originalGoal: task.prompt, ...task.goal, remainingTurns: MAX_GOAL_TURNS - task.goal.turns };
          if (tool === 'record_decision') {
            const decision = parseDecision(params.arguments);
            if (decision.action === 'complete' && task.goal.verificationRequired) {
              if (!this.collaboration) throw new Error('Independent verification is unavailable.');
              this.collaboration.assertVerified(task, active.messages);
            }
            validateDecision(task.goal, decision, this.collaboration?.waiting(task.id, active.messages) ?? false);
            if (task.goal.pending && JSON.stringify(task.goal.pending) !== JSON.stringify(decision)) throw new Error('A decision was already recorded for this turn.');
            this.store.update(task.id, { goal: { ...task.goal, pending: decision } });
            return { status: 'recorded', guidance: 'End this turn now. The decision is applied only after successful turn completion.' };
          }
          if (task.goal.pending) throw new Error('End the turn after recording its decision.');
        }
        if (task.verificationDraft) throw new Error('End the turn after submitting verification.');
        if (this.verification && task.verification && ['verification_read', 'verification_status', 'submit_verification'].includes(tool)) return this.verification.call(task, tool, params.arguments);
        if (this.historyQueue && ['history_search', 'history_read'].includes(tool)) {
          return record(await this.historyQueue.call(active.id, active.threadId!, textValue(params.turnId, 'turn id'),
            textValue(params.callId, 'call id'), tool, params.arguments, active.controller.signal));
        }
        if (!this.collaboration) throw new Error('Unknown tool.');
        return this.collaboration.call(this.store.task(active.id)!, tool, params.arguments);
      });
    }
  }

  get busy(): boolean { return this.active !== null; }
  get error(): string | null { return this.failure; }

  submit(id: string, prompt: string): Task {
    validateTaskId(id); textValue(prompt, 'prompt');
    if (prompt.length > 20_000) throw new TypeError('Prompt is too long.');
    if (this.failure) throw new Error(this.failure);
    const existing = this.store.task(id);
    if (existing) {
      if (existing.prompt !== prompt) throw new TaskConflict('This task id belongs to a different prompt.');
      return existing;
    }
    if (this.store.snapshot().tasks.some(task => task.status === 'unknown')) {
      throw new TaskConflict('A previous execution outcome is unknown. Inspect its saved thread before starting more work.');
    }
    if (this.active) throw new TaskConflict('This specialist already has an active task.');
    const task = this.store.create(id, prompt, { ...(this.collaboration ? { conversation: id } : {}),
      ...(this.configuration?.decisionProtocol === 1 ? { goal: newGoal(Boolean(this.verification)), conversation: id } : {}) });
    return this.launch(task, prompt);
  }

  private launch(task: Task, input: string, messages: string[] = []): Task {
    const id = task.id;
    if (task.goal) {
      if (task.goal.turns >= MAX_GOAL_TURNS) throw new Error('Goal turn limit reached.');
      this.store.update(id, { status: 'accepted', finishedAt: null, goal: { ...task.goal, turns: task.goal.turns + 1, phase: 'active', pending: null } });
      task = this.store.task(id)!;
    }
    const active: ActiveTask = { id, threadId: null, turnId: null,
      stopRequested: false, done: Promise.resolve(), observer: new TurnObserver((method, item) => { if (this.configuration?.permissions.commandExecution === true) this.verification?.observe(task, method, item); }), interrupting: null, input, messages, controller: new AbortController() };
    this.active = active;
    active.done = this.run(task, active).finally(() => { if (this.active === active) this.active = null; });
    // A persistence failure is reported through the worker's health/lifecycle, not an unhandled rejection.
    void active.done.catch(() => { this.failure = 'Could not persist specialist task state.'; });
    return task;
  }

  /** Called after exchanges and turn completion. Waiting tasks do not occupy the execution slot. */
  pump(): void {
    if (this.active || this.failure || this.store.snapshot().tasks.some(t => t.status === 'unknown')) return;
    const next = this.collaboration?.next();
    if (!next) {
      const ready = this.store.snapshot().tasks.find(t => t.status === 'waiting' && t.goal?.phase === 'ready');
      if (ready) this.launch(ready, `Continue the original goal: ${ready.prompt}\nSaved goal state (reference data):\n${JSON.stringify(ready.goal)}\nPerform the next action within the original authority. Retrieve missing past decisions with history_search.`);
      return;
    }
    if (next.resume) {
      this.store.update(next.taskId, { status: 'accepted', turnId: null, finishedAt: null });
    } else this.store.create(next.taskId, next.prompt, { conversation: next.taskId, consultation: next.consultation, verification: next.verification });
    this.launch(this.store.task(next.taskId)!, next.prompt, next.messages);
  }

  private async thread(task: Task): Promise<string> {
    const saved = this.store.snapshot();
    const savedThread = task.conversation ? saved.threads[task.conversation] ?? null : saved.threadId;
    if (savedThread && this.loadedThreads.has(savedThread)) return savedThread;
    const settings = this.configuration;
    const profile = this.profile + (this.collaboration ? collaborationInstructions : '') + (this.historyQueue ? historyInstructions : '') + (task.goal ? decisionInstructions : '') + (this.verification ? verificationInstructions : '');
    const params: JsonRecord = { cwd: this.workspace, sandbox: !task.consultation && !task.verification && settings?.permissions.fileWrite ? 'workspace-write' : 'read-only', approvalPolicy: 'on-request',
      approvalsReviewer: 'user', developerInstructions: profile,
      ...(settings ? { model: settings.model, serviceTier: settings.serviceTier, config: {
        ...(settings.reasoningEffort ? { model_reasoning_effort: settings.reasoningEffort } : {}),
        'features.shell_tool': !task.consultation && settings.permissions.commandExecution,
        'features.unified_exec': !task.consultation && settings.permissions.commandExecution,
        'features.multi_agent': false,
      } } : {}) };
    const result = savedThread
      ? await this.client.request('thread/resume', { ...params, threadId: savedThread })
      : await this.client.request('thread/start', { ...params, dynamicTools: [...(this.collaboration ? collaborationTools : []), ...(this.historyQueue ? historyTools : []), ...(task.goal ? decisionTools : []), ...(this.verification ? verificationTools : [])] });
    const threadId = textValue(record(result.thread).id, 'thread id');
    assertResumedThread(savedThread, threadId);
    if (savedThread) {
      // Codex 0.159.3 can replay old developer instructions on cold resume.
      // Persist the current snapshot in model-visible history before any turn.
      await this.client.request('thread/inject_items', {
        threadId,
        items: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text:
          'Current Cheshi specialist instructions. This complete snapshot replaces earlier Cheshi specialist and project instructions, including linked instruction files. Instructions omitted from this snapshot no longer apply. Prior conversation and task results remain reference data.\n\n'
          + profile,
        }] }],
      });
    }
    this.store.saveThread(threadId, typeof result.model === 'string' ? result.model : saved.model, task.conversation, !task.consultation && !task.verification);
    this.loadedThreads.add(threadId);
    return threadId;
  }

  private async run(task: Task, active: ActiveTask): Promise<void> {
    const observer = active.observer;
    const remove = this.client.subscribe(event => observer.receive(event));
    const removeFailure = this.client.onFailure(error => observer.fail(error));
    let submitted = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const account = record(await this.client.request('account/read', { refreshToken: false }));
      assertChatGPTAccount(account.account);
      active.threadId = await this.thread(task);
      if (active.stopRequested) {
        this.store.complete(task.id, { status: 'interrupted', output: '', error: null,
          ...(task.goal ? { goal: { ...task.goal, phase: 'blocked', pending: null } } : {}) }); return;
      }
      const memory = task.consultation || task.verification ? '' : this.store.memory();
      const input = memory ? `Saved work summary (reference data):\n${memory}\n\nCurrent task:\n${active.input}` : active.input;
      submitted = true;
      const response = await this.client.request('turn/start', {
        threadId: active.threadId, input: [{ type: 'text', text: input }], cwd: this.workspace,
        approvalPolicy: 'on-request', approvalsReviewer: 'user',
        sandboxPolicy: !task.consultation && !task.verification && this.configuration?.permissions.fileWrite
          ? { type: 'workspaceWrite', writableRoots: [this.workspace], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true }
          : { type: 'readOnly', networkAccess: false },
        ...(this.configuration ? { model: this.configuration.model, effort: this.configuration.reasoningEffort, serviceTier: this.configuration.serviceTier } : {}),
      });
      active.turnId = textValue(record(response.turn).id, 'turn id');
      this.history?.remember(active.threadId, active.turnId, active.input === task.prompt ? task.prompt : null);
      this.store.update(task.id, { threadId: active.threadId, turnId: active.turnId, status: 'running' });
      observer.identify(active.threadId, active.turnId);
      deadline = setTimeout(() => {
        void this.interrupt(active).catch(() => {});
        observer.fail(new Error('Task deadline reached; execution outcome requires inspection.'));
      }, this.timeoutMs);
      if (active.stopRequested) {
        try { await this.interrupt(active); }
        catch (error) { if (!observer.finished) observer.fail(error instanceof Error ? error : new Error(String(error))); }
      }
      const result = await observer.result;
      const savedGoal = this.store.task(task.id)?.goal;
      if (active.stopRequested && savedGoal && !(result.status === 'completed' && savedGoal.pending?.action === 'complete')) {
        this.store.complete(task.id, { status: 'interrupted', output: result.output, error: null,
          goal: { ...this.store.task(task.id)!.goal!, phase: 'blocked', pending: null } }, active.messages);
      } else if (result.status === 'completed' && task.goal) {
        let verificationError: string | null = null;
        if (savedGoal?.pending?.action === 'complete' && savedGoal.verificationRequired) {
          try { this.collaboration!.assertVerified(this.store.task(task.id)!, active.messages); }
          catch (error) { verificationError = error instanceof Error ? error.message : String(error); }
        }
        if (verificationError) {
          // The turn completed, but the evidence became stale. Resume judgment without claiming completion.
          const goal = { ...savedGoal!, pending: null, phase: savedGoal!.turns >= MAX_GOAL_TURNS ? 'blocked' as const : 'ready' as const };
          this.store.complete(task.id, { ...result, status: goal.phase === 'ready' ? 'waiting' : 'interrupted', goal, error: verificationError }, active.messages);
          return;
        }
        const outcome = finishGoal(this.store.task(task.id)!.goal!, this.collaboration?.waiting(task.id, active.messages) ?? false);
        this.store.complete(task.id, { ...result, ...outcome }, active.messages);
      } else if (result.status === 'completed' && this.collaboration) {
        if (task.verification && this.verification) this.collaboration.publishVerification(task, this.verification.finish(this.store.task(task.id)!));
        if (task.consultation && !this.collaboration.hasReply(task)) this.collaboration.reply(task, result.output || 'No answer was produced.');
        const waiting = this.collaboration.waiting(task.id, active.messages);
        this.store.complete(task.id, { ...result, status: waiting ? 'waiting' : 'completed' }, active.messages);
      } else this.store.complete(task.id, { ...result, ...(savedGoal ? { goal: { ...savedGoal, phase: 'blocked', pending: null } } : {}) });
    } catch (error) {
      this.store.complete(task.id, { status: submitted ? 'unknown' : active.stopRequested ? 'interrupted' : 'failed',
        output: '', error: error instanceof Error ? error.message : String(error) });
    } finally { active.controller.abort(); clearTimeout(deadline); remove(); removeFailure(); }
  }

  private async interrupt(active: ActiveTask): Promise<void> {
    if (!active.threadId || !active.turnId || active.observer.finished) return;
    active.interrupting ??= this.client.request('turn/interrupt', {
      threadId: active.threadId, turnId: active.turnId,
    }).then(() => {});
    await active.interrupting;
  }

  async stop(id: string): Promise<void> {
    const active = this.active;
    if (!active || active.id !== id) {
      const task = this.store.task(id);
      if (task?.status === 'waiting') this.store.complete(id, { status: 'interrupted', output: task.output, error: null,
        ...(task.goal ? { goal: { ...task.goal, phase: 'blocked', pending: null } } : {}) });
      return;
    }
    active.stopRequested = true;
    active.controller.abort();
    await this.interrupt(active);
  }

  async settled(): Promise<void> { await this.active?.done; }
}
