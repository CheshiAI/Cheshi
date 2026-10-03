import { WorkerWork } from './work.ts';
import { workTools, workInstructions } from './work-tools.ts';
import { WorkerIntegration, integrationTools, integrationInstructions, candidateVerificationInstructions } from './integration.ts';
import { closeQuestion, setQuestionDeadline } from './question-control.ts';
import { WorkerVerification } from './verification.ts';
import { SCRATCH_PROFILE, TaskScratch } from './task-scratch.ts';
import { verificationInstructions, verificationTools } from './verification-tools.ts';
import type { RuntimeConfiguration } from './runtime-config.ts';
import type { RpcClient } from './app-server-client.ts';
import { record, textValue, type JsonRecord } from './protocol.ts';
import { AgentStore, validateTaskId, type Task } from './store.ts';
import { TurnObserver } from './turn.ts';
import { inspectRecovery } from './recovery.ts';
import { WorkerCollaboration } from './collaboration.ts';
import { collaborationInstructions, collaborationTools } from './collaboration-tools.ts';
import { historyInstructions, historyTools } from './history-tools.ts';
import type { WorkerHistoryQueue } from './history-queue.ts';
import type { WorkerHistory } from './history.ts';
import { decisionInstructions, decisionTools, finishGoal, goalContext, newGoal, parseDecision, validateDecision } from './decision.ts';
import { GoalObservations, isStalled, STALLED_GOAL } from './goal-progress.ts';

export class TaskConflict extends Error {}

function assertChatGPTAccount(value: unknown): void {
  if (value === null || record(value).type !== 'chatgpt') {
    throw new Error('Sign in to ChatGPT in the experiment container first.');
  }
}

function requireWork(work: WorkerWork | undefined): WorkerWork {
  if (!work) throw new Error('Start this worker with implementation delegation enabled.');
  return work;
}

function assertResumedThread(expected: string | null, actual: string): void {
  if (expected && actual !== expected) throw new Error('Resumed thread id changed.');
}

type ActiveTask = {
  id: string; threadId: string | null; turnId: string | null; stopRequested: boolean;
  done: Promise<void>; observer: TurnObserver; interrupting: Promise<void> | null;
  observations: GoalObservations; messages: string[]; input: string; controller: AbortController;
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
  private recovering = false;
  private failure: string | null = null;
  private readonly retainedScratch = new Set<TaskScratch>();

  private readonly work: WorkerWork | undefined;
  private readonly integration: WorkerIntegration | undefined;
  private readonly verification: WorkerVerification | undefined;
  private readonly historyQueue: WorkerHistoryQueue | undefined;
  private readonly history: WorkerHistory | undefined;
  private readonly collaboration: WorkerCollaboration | undefined;
  constructor(options: { client: RpcClient; store: AgentStore; profile: string; workspace: string; timeoutMs?: number; configuration?: RuntimeConfiguration; collaboration?: WorkerCollaboration; historyQueue?: WorkerHistoryQueue; history?: WorkerHistory }) {
    this.configuration = options.configuration;
    this.work = options.configuration?.workProtocol === 1 ? new WorkerWork(options.store, options.workspace, options.configuration.profileId, options.configuration.permissions.fileWrite) : undefined;
    this.integration = options.configuration?.integrationProtocol === 1 ? new WorkerIntegration(options.store, options.workspace, options.configuration.profileId, options.configuration.permissions.fileWrite) : undefined;
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
          if (tool === 'goal_status') return { originalGoal: task.prompt, ...goalContext(task.goal) };
          if (tool === 'record_decision') {
            const decision = parseDecision(params.arguments);
            if (decision.action === 'complete' && task.integration) throw new Error('An integration candidate is not applied to the project. Candidate verification alone cannot complete the goal.');
            if (decision.action === 'complete') this.work?.assertReviewed(task);
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
        if (task.workDraft) throw new Error('End the turn after submitting work.');
        if (this.integration && integrationTools.some(t => t.name === tool)) {
          const result = this.integration.call(task, tool, params.arguments);
          active.observations.add({ tool: 'integration', result });
          return result;
        }
        if (this.work && workTools.some(t => t.name === tool)) {
          const result = this.work.call(task, tool, params.arguments);
          if (tool === 'request_work' || tool === 'review_work' || tool === 'work_write') active.observations.add({ tool, result });
          return result;
        }
        if (task.verificationDraft) throw new Error('End the turn after submitting verification.');
        if (this.verification && task.verification && ['verification_read', 'verification_status', 'submit_verification'].includes(tool)) return this.verification.call(task, tool, params.arguments);
        if (this.historyQueue && ['history_search', 'history_read'].includes(tool)) {
          const result = record(await this.historyQueue.call(active.id, active.threadId!, textValue(params.turnId, 'turn id'),
            textValue(params.callId, 'call id'), tool, params.arguments, active.controller.signal));
          if (result.isError !== true && result.error == null) active.observations.history(result);
          return result;
        }
        if (!this.collaboration) throw new Error('Unknown tool.');
        const candidate = tool === 'request_verification' && task.integration && this.configuration?.candidateVerificationProtocol === 1
          ? this.integration?.snapshot(task) : undefined;
        const result = this.collaboration.call(this.store.task(active.id)!, tool, params.arguments, candidate);
        if (tool === 'ask_agent' || tool === 'request_verification') {
          const request = this.store.snapshot().collaboration.outgoing.find(m => m.id === (result.questionId ?? result.requestId));
          if (request) active.observations.add({ kind: request.kind, to: request.to,
            text: request.kind === 'verification_request' ? JSON.parse(request.text) : request.text });
        }
        return result;
      });
    }
  }

  get busy(): boolean { return this.active !== null || this.recovering; }
  get error(): string | null { return this.failure; }

  activity() {
    const state = this.store.snapshot();
    return { ...state, tasks: state.tasks.map(task => task.integration && this.integration
      ? { ...task, integration: this.integration.inspect(task)! } : task) };
  }

  submit(id: string, prompt: string, chat?: { roomId: string; conversation: string; goal: boolean }): Task {
    if (chat) { validateTaskId(chat.roomId); validateTaskId(chat.conversation); if (typeof chat.goal !== 'boolean') throw new TypeError('Invalid chat mode.'); }
    validateTaskId(id); textValue(prompt, 'prompt');
    if (prompt.length > 20_000) throw new TypeError('Prompt is too long.');
    if (this.failure) throw new Error(this.failure);
    const existing = this.store.task(id);
    if (existing) {
      if (existing.prompt !== prompt || existing.roomId !== chat?.roomId || (chat && (existing.conversation !== chat.conversation || Boolean(existing.goal) !== (chat.goal && this.configuration?.decisionProtocol === 1)))) throw new TaskConflict('This task id belongs to a different prompt.');
      return existing;
    }
    if (this.store.snapshot().tasks.some(task => task.status === 'unknown')) {
      throw new TaskConflict('A previous execution outcome is unknown. Inspect its saved thread before starting more work.');
    }
    if (this.busy) throw new TaskConflict('This specialist already has an active task.');
    const task = this.store.create(id, prompt, { ...(this.collaboration ? { conversation: id } : {}),
      ...(this.configuration?.decisionProtocol === 1 && (!chat || chat.goal) ? { goal: newGoal(Boolean(this.verification)), conversation: id } : {}), ...(chat ? { roomId: chat.roomId, conversation: chat.conversation } : {}) });
    return this.launch(task, prompt);
  }

  input(id: string, inputId: string, prompt: string, roomId: string): Task {
    validateTaskId(inputId); textValue(prompt, 'prompt');
    if (prompt.length > 20_000) throw new TypeError('Prompt is too long.');
    const task = this.store.task(id);
    if (!task || task.roomId !== roomId || !task.goal) throw new TaskConflict('Unknown room goal.');
    const previous = task.inputs?.find(i => i.id === inputId);
    if (previous) {
      if (previous.prompt !== prompt) throw new TaskConflict('Input identity conflict.');
      return task;
    }
    if (this.busy || this.failure || this.store.snapshot().tasks.some(t => t.status === 'unknown')) throw new TaskConflict('Worker cannot safely resume yet.');
    if (task.status === 'completed') throw new TaskConflict('This goal is completed. Start a new goal.');
    this.store.update(id, { inputs: [...(task.inputs ?? []), { id: inputId, prompt }], goal: { ...task.goal, progressCheck: { unchanged: 0, observations: [] } }, status: 'accepted', finishedAt: null });
    return this.launch(this.store.task(id)!, `Continue the original goal: ${task.prompt}\nUser follow-up:\n${prompt}`);
  }

  question(taskId: string, roomId: string, questionId: string, recipient: string | null): Task {
    if (!this.collaboration || this.busy || this.failure || this.store.snapshot().tasks.some(t => t.status === 'unknown')) throw new TaskConflict('Worker cannot safely change a question yet.');
    return closeQuestion(this.store, this.collaboration.agentId, taskId, roomId, questionId, recipient);
  }

  questionDeadline(taskId: string, roomId: string, questionId: string, expiresAt: unknown): Task {
    if (!this.collaboration || this.busy || this.failure || this.store.snapshot().tasks.some(t => t.status === 'unknown')) throw new TaskConflict('Worker cannot safely change a question yet.');
    return setQuestionDeadline(this.store, this.collaboration.agentId, taskId, roomId, questionId, expiresAt);
  }

  private launch(task: Task, input: string, messages: string[] = []): Task {
    const id = task.id;
    // A lost acknowledgement must never reuse the preceding turn's identity.
    this.store.update(id, { threadId: null, turnId: null, recovery: undefined });
    if (task.goal) {
      this.store.update(id, { status: 'accepted', finishedAt: null, goal: { ...task.goal, turns: task.goal.turns + 1, phase: 'active', pending: null } });
      task = this.store.task(id)!;
    }
    const observations = new GoalObservations();
    for (const message of this.store.snapshot().collaboration.incoming.filter(m => messages.includes(m.id))) {
      if (message.kind === 'reply' || message.kind === 'verification_result' || message.kind === 'work_result') {
        const text: unknown = message.kind === 'verification_result' ? JSON.parse(message.text) : message.text;
        observations.add({ kind: message.kind, from: message.from, text });
      }
    }
    const active: ActiveTask = { id, threadId: null, turnId: null, observations,
      stopRequested: false, done: Promise.resolve(), observer: new TurnObserver((method, item) => { observations.item(method, item); if (this.configuration?.permissions.commandExecution === true) this.verification?.observe(task, method, item); }), interrupting: null, input, messages, controller: new AbortController() };
    this.active = active;
    active.done = this.run(task, active).finally(() => { if (this.active === active) this.active = null; });
    // A persistence failure is reported through the worker's health/lifecycle, not an unhandled rejection.
    void active.done.catch(() => { this.failure = 'Could not persist specialist task state.'; });
    return task;
  }

  /** Called after exchanges and turn completion. Waiting tasks do not occupy the execution slot. */
  pump(): void {
    this.collaboration?.expire();
    if (this.busy || this.failure || this.store.snapshot().tasks.some(t => t.status === 'unknown')) return;
    const next = this.collaboration?.next();
    if (!next) {
      const ready = this.store.snapshot().tasks.find(t => t.status === 'waiting' && t.goal?.phase === 'ready');
      if (ready) this.launch(ready, `Continue the original goal: ${ready.prompt}\nSaved goal state (reference data):\n${JSON.stringify(goalContext(ready.goal!))}\nPerform the next action within the original authority. Retrieve missing past decisions with history_search.`);
      return;
    }
    if (next.resume) {
      this.store.update(next.taskId, { status: 'accepted', turnId: null, finishedAt: null });
    } else this.store.create(next.taskId, next.prompt, { conversation: next.taskId, consultation: next.consultation, verification: next.verification, delegation: next.delegation, roomId: next.roomId });
    this.launch(this.store.task(next.taskId)!, next.prompt, next.messages);
  }

  private async thread(task: Task, scratch?: TaskScratch, workspace = this.workspace): Promise<string> {
    const saved = this.store.snapshot();
    const savedThread = task.conversation ? saved.threads[task.conversation] ?? null : saved.threadId;
    // Reload turn-specific permission roots and TMPDIR, including warm resumes.
    if (!scratch && savedThread && this.loadedThreads.has(savedThread)) return savedThread;
    if (scratch && savedThread && this.loadedThreads.has(savedThread)) {
      // Codex 0.159.3 ignores config overrides for an already-loaded thread.
      // Unsubscribe unloads the idle execution session, not its persisted history.
      await this.client.request('thread/unsubscribe', { threadId: savedThread });
      this.loadedThreads.delete(savedThread);
    }
    const settings = this.configuration;
    // Native resumed conversations retain the dynamic tool set from their creation.
    const integrationAvailable = this.integration && (!savedThread || task.integrationTools === true);
    const profile = this.profile + (this.collaboration ? collaborationInstructions : '') + (this.historyQueue ? historyInstructions : '') + (task.goal ? decisionInstructions : '') + (this.verification ? verificationInstructions : '') + (this.work ? workInstructions : '') + (integrationAvailable ? integrationInstructions : '')
      + (integrationAvailable && settings?.candidateVerificationProtocol === 1 ? candidateVerificationInstructions : '');
    const params: JsonRecord = { cwd: workspace,
      ...(scratch ? { permissions: SCRATCH_PROFILE } : { sandbox: !task.consultation && !task.verification && !task.delegation && settings?.permissions.fileWrite === true ? 'workspace-write' : 'read-only' }), approvalPolicy: 'on-request',
      approvalsReviewer: 'user', developerInstructions: profile,
      ...(settings ? { model: settings.model, serviceTier: settings.serviceTier, config: {
        ...(settings.reasoningEffort ? { model_reasoning_effort: settings.reasoningEffort } : {}),
        'features.shell_tool': !task.consultation && settings.permissions.commandExecution,
        'features.unified_exec': !task.consultation && settings.permissions.commandExecution,
        'features.multi_agent': false,
        ...(scratch ? scratch.config(workspace) : {}),
      } } : {}) };
    const result = savedThread
      ? await this.client.request('thread/resume', { ...params, threadId: savedThread })
      : await this.client.request('thread/start', { ...params, dynamicTools: [...(this.collaboration ? collaborationTools : []), ...(this.historyQueue ? historyTools : []), ...(task.goal ? decisionTools : []), ...(this.verification ? verificationTools : []), ...(this.work ? workTools : []), ...(this.integration ? integrationTools : [])] });
    const threadId = textValue(record(result.thread).id, 'thread id');
    assertResumedThread(savedThread, threadId);
    scratch?.assertApplied(result);
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
    this.store.saveThread(threadId, typeof result.model === 'string' ? result.model : saved.model, task.conversation, !task.consultation && !task.verification && !task.delegation);
    if (integrationAvailable) this.store.update(task.id, { integrationTools: true });
    this.loadedThreads.add(threadId);
    return threadId;
  }

  private async run(task: Task, active: ActiveTask): Promise<void> {
    const observer = active.observer;
    const remove = this.client.subscribe(event => observer.receive(event));
    const removeFailure = this.client.onFailure(error => observer.fail(error));
    let submitted = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let scratch: TaskScratch | undefined;
    let workspace = this.workspace;
    try {
      if (task.delegation) {
        const work = requireWork(this.work);
        work.assertWritable(task);
        workspace = work.files(task).directory;
        scratch = new TaskScratch(); this.retainedScratch.add(scratch);
      }
      if (task.verification && this.verification) {
        const savedConversation = this.store.snapshot().threads[task.conversation ?? task.id];
        workspace = this.verification.workspaceFor(task, Boolean(savedConversation));
      }
      const account = record(await this.client.request('account/read', { refreshToken: false }));
      assertChatGPTAccount(account.account);
      if (!task.delegation && !task.consultation && this.configuration?.permissions.commandExecution === true
        && (task.verification || this.configuration.permissions.fileWrite !== true)) {
        scratch = new TaskScratch(); this.retainedScratch.add(scratch);
      }
      active.threadId = await this.thread(task, scratch, workspace);
      if (active.stopRequested) {
        this.store.complete(task.id, { status: 'interrupted', output: '', error: null,
          ...(task.goal ? { goal: { ...task.goal, phase: 'blocked', pending: null } } : {}) }, active.messages,
          task.delegation && this.work ? this.work.resultMessage(task, 'interrupted', 'Stopped before execution.') : undefined); return;
      }
      const memory = task.consultation || task.verification || task.delegation ? '' : this.store.memory();
      const input = memory ? `Saved work summary (reference data):\n${memory}\n\nCurrent task:\n${active.input}` : active.input;
      this.store.update(task.id, { threadId: active.threadId, turnId: null });
      submitted = true;
      const response = await this.client.request('turn/start', {
        threadId: active.threadId, input: [{ type: 'text', text: input }], cwd: workspace,
        approvalPolicy: 'on-request', approvalsReviewer: 'user',
        ...(scratch ? { permissions: SCRATCH_PROFILE } : { sandboxPolicy: !task.consultation && !task.verification && !task.delegation && this.configuration?.permissions.fileWrite === true
          ? { type: 'workspaceWrite', writableRoots: [this.workspace], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true }
          : { type: 'readOnly', networkAccess: false } }),
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
      const currentGoal = this.store.task(task.id)?.goal, reported = observer.usage;
      const savedGoal = currentGoal && reported ? { ...currentGoal, usage: {
        reportedThroughTurn: currentGoal.turns, ...reported,
      } } : currentGoal;
      if (task.delegation && this.work) {
        const outgoing = this.work.resultMessage(this.store.task(task.id)!, result.status, result.error || result.output);
        this.store.complete(task.id, result, active.messages, outgoing);
      } else if (active.stopRequested && savedGoal && !(result.status === 'completed' && savedGoal.pending?.action === 'complete')) {
        this.store.complete(task.id, { status: 'interrupted', output: result.output, error: null,
          goal: { ...savedGoal, phase: 'blocked', pending: null } }, active.messages);
      } else if (result.status === 'completed' && task.goal) {
        let verificationError: string | null = null;
        if (savedGoal?.pending?.action === 'complete' && savedGoal.verificationRequired) {
          try { this.collaboration!.assertVerified(this.store.task(task.id)!, active.messages); }
          catch (error) { verificationError = error instanceof Error ? error.message : String(error); }
        }
        if (verificationError) {
          // Resume judgment after stale evidence, but do not loop forever on the same failed completion.
          const progressCheck = active.observations.finish(savedGoal?.progressCheck);
          const goal = { ...savedGoal!, progressCheck, pending: null, phase: isStalled(progressCheck) ? 'blocked' as const : 'ready' as const };
          this.store.complete(task.id, { ...result, status: goal.phase === 'ready' ? 'waiting' : 'interrupted', goal,
            error: goal.phase === 'blocked' ? `${STALLED_GOAL} ${verificationError}` : verificationError }, active.messages);
          return;
        }
        const outcome = finishGoal({ ...savedGoal!, progressCheck: active.observations.finish(savedGoal?.progressCheck) }, this.collaboration?.waiting(task.id, active.messages) ?? false);
        this.store.complete(task.id, { ...result, ...outcome }, active.messages);
      } else if (result.status === 'completed' && this.collaboration) {
        if (task.verification && this.verification) this.collaboration.publishVerification(task, this.verification.finish(this.store.task(task.id)!));
        if (task.consultation && !this.collaboration.hasReply(task)) this.collaboration.reply(task, result.output || 'No answer was produced.');
        const waiting = this.collaboration.waiting(task.id, active.messages);
        this.store.complete(task.id, { ...result, status: waiting ? 'waiting' : 'completed' }, active.messages);
      } else this.store.complete(task.id, { ...result, ...(savedGoal ? { goal: { ...savedGoal, phase: 'blocked', pending: null } } : {}) });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const outgoing = !submitted && task.delegation && this.work ? this.work.resultMessage(task, 'failed', reason) : undefined;
      this.store.complete(task.id, { status: submitted ? 'unknown' : active.stopRequested ? 'interrupted' : 'failed',
        output: '', error: reason }, outgoing ? active.messages : [], outgoing);
    } finally {
      active.controller.abort(); clearTimeout(deadline); remove(); removeFailure();
      // Unknown executions may still own child processes. Retain their scratch until
      // app-server shutdown; the existing unknown-task gate prevents another turn.
      if (scratch && this.store.task(task.id)?.status !== 'unknown') {
        let released = true;
        if (active.threadId) {
          try {
            // Unload also releases lingering unified-exec sessions before deleting
            // their files. The saved conversation remains available for cold resume.
            await this.client.request('thread/unsubscribe', { threadId: active.threadId });
            this.loadedThreads.delete(active.threadId);
          } catch {
            this.failure = 'Could not close the test command session. Restart the worker before continuing.';
            released = false;
          }
        }
        if (released) { scratch.dispose(); this.retainedScratch.delete(scratch); }
      }
    }
  }

  private async interrupt(active: ActiveTask): Promise<void> {
    if (!active.threadId || !active.turnId || active.observer.finished) return;
    active.interrupting ??= this.client.request('turn/interrupt', {
      threadId: active.threadId, turnId: active.turnId,
    }).then(() => {});
    await active.interrupting;
  }

  async recover(id: string, roomId: string): Promise<Task> {
    validateTaskId(id); validateTaskId(roomId);
    const task = this.store.task(id);
    if (!task || task.roomId !== roomId || (!task.goal && !task.consultation && !task.verification && !task.delegation)
      || (task.verification && (task.goal || task.consultation)) || (task.delegation && (task.goal || task.consultation || task.verification))) throw new TaskConflict('Unknown room goal, consultation or verification.');
    if (task.delegation && !this.work) throw new TaskConflict('Delegation recovery is unavailable.');
    if (task.verification && (!this.verification || !this.collaboration)) throw new TaskConflict('Independent verification recovery is unavailable.');
    if (task.status !== 'unknown') {
      if (task.recovery) return task;
      throw new TaskConflict('Only an unknown execution can be inspected.');
    }
    if (this.busy || this.failure) throw new TaskConflict('Worker cannot safely inspect yet.');
    if (this.retainedScratch.size) throw new TaskConflict('Restart the worker before inspecting retained command sessions.');
    if (!task.threadId || !task.turnId) throw new TaskConflict('The execution has no acknowledged turn ID. Its outcome remains unknown.');
    this.recovering = true;
    try {
      const workspace = task.delegation && this.work ? this.work.files(task, true).directory
        : task.verification && this.verification ? this.verification.recoveryWorkspace(task) : this.workspace;
      const result = inspectRecovery(task, await this.client.request('thread/read', { threadId: task.threadId, includeTurns: true }), workspace);
      // Close any retained execution session before removing the unknown-task gate.
      await this.client.request('thread/unsubscribe', { threadId: task.threadId });
      this.loadedThreads.delete(task.threadId);
      assertUnchangedRecovery(task, this.store.task(id));
      if (task.delegation) {
        const outgoing = this.work!.resultMessage(task, result.receipt.status, result.output || 'Execution inspected without a submitted result.');
        this.store.complete(id, { status: 'interrupted', output: result.output, recovery: result.receipt,
          error: 'Execution ended. The proposed work result was delivered for review; no project files were applied.' }, [task.delegation], outgoing);
        return this.store.task(id)!;
      }
      if (task.verification) {
        const outgoing = this.collaboration!.verificationRecoveryMessage(task, this.verification!.recover(task, result.receipt));
        this.store.complete(id, { status: 'interrupted', output: result.output, recovery: result.receipt,
          error: `Execution ended (${result.receipt.status}). The verification result is recorded separately. The owner must process it before deciding goal completion.` }, [task.verification], outgoing);
        return this.store.task(id)!;
      }
      const goal = task.goal;
      this.store.complete(id, { status: 'interrupted', output: result.output, recovery: result.receipt,
        error: task.consultation
          ? `Execution ended (${result.receipt.status}). Consultation output recovered for review only. Inspection did not send or replay a reply. Reassign the question if another answer is needed.`
          : `Execution ended (${result.receipt.status}). Review the recovered output and provide a follow-up to resume goal judgment.`,
        ...(goal ? { goal: { ...goal, phase: 'blocked' as const, pending: null, criteria: goal.criteria.length ? goal.criteria : goal.pending?.criteria ?? [] } } : {}) });
      return this.store.task(id)!;
    } finally { this.recovering = false; }
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

  /** Only after app-server and its command processes have stopped. */
  disposeScratch(): void {
    for (const scratch of this.retainedScratch) scratch.dispose();
    this.retainedScratch.clear();
  }
}

function assertUnchangedRecovery(expected: Task, current: Task | undefined): void {
  if (JSON.stringify(expected) !== JSON.stringify(current)) throw new TaskConflict('Task changed during inspection. Refresh before trying again.');
}
