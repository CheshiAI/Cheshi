import { TaskWorkspaceGate } from './task-workspace.ts';
import { customToolArguments, customToolDefinition } from './custom-tool-contract.ts';
import type { WorkerCustomToolQueue } from './custom-tool-queue.ts';
import { packToolAllowed, assertPackToolAllowed } from './pack-tools.ts';
import { WorkerCodeGraphQueue } from './codegraph-queue.ts';
import { codegraphTools, codegraphInstructions } from './codegraph-tools.ts';
import { randomUUID } from 'node:crypto';
import { coversPermissions, shouldRequestPermissions, parsePermissionRequest, permissionTools, permissionInstructions } from './execution-permissions.ts';
import { projectTaskActivities, recordTaskActivity } from './activity.ts';
import { readNativeTurnUsage } from './native-usage.ts';
import { mergeTurnUsage } from './usage-contract.ts';
import { WorkerConversation, conversationTools, conversationInstructions, intakeGuidance, intakeNeedsAction } from './conversation.ts';
import { waitingForUser } from './conversation-contract.ts';
import { WorkerWork } from './work.ts';
import { workTools, workInstructions } from './work-tools.ts';
import { WorkerIntegration, integrationTools, integrationInstructions, candidateVerificationInstructions, applicationTools, applicationInstructions } from './integration.ts';
import { closeQuestion, setQuestionDeadline } from './question-control.ts';
import { WorkerVerification } from './verification.ts';
import { SCRATCH_PROFILE, TaskScratch } from './task-scratch.ts';
import { assertWritableWorkspace } from './workspace-sandbox.ts';
import { verificationInstructions, verificationTools } from './verification-tools.ts';
import type { RuntimeConfiguration } from './runtime-config.ts';
import type { RpcClient } from './app-server-client.ts';
import { record, textValue, type JsonRecord } from './protocol.ts';
import { AgentStore, validateTaskId, type Task } from './store.ts';
import { TurnObserver } from './turn.ts';
import { CommandSessions } from './command-stop.ts';
import { ExecutionHealth } from './execution-health.ts';
import { inspectRecovery } from './recovery.ts';
import { WorkerCollaboration } from './collaboration.ts';
import { collaborationInstructions, collaborationTools } from './collaboration-tools.ts';
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
  health: ExecutionHealth; commands: CommandSessions;
  intakePermissionsConfirmed?: true; intakeRetry: boolean;
};

export class SpecialistAgent {
  private readonly client: RpcClient;
  private readonly store: AgentStore;
  private readonly profile: string;
  private readonly workspace: string;
  private readonly configuration: RuntimeConfiguration | undefined;
  private readonly loadedThreads = new Set<string>();
  private readonly threadPaths = new Map<string, string>();
  private active: ActiveTask | null = null;
  private recovering = false;
  private failure: string | null = null;
  private readonly retainedScratch = new Set<TaskScratch>();

  private readonly workspaceGate: TaskWorkspaceGate | undefined;
  private readonly conversations: WorkerConversation;
  private readonly work: WorkerWork | undefined;
  private readonly integration: WorkerIntegration | undefined;
  private readonly verification: WorkerVerification | undefined;
  private readonly customTools: WorkerCustomToolQueue | undefined;
  private readonly codegraph: WorkerCodeGraphQueue | undefined;
  private readonly collaboration: WorkerCollaboration | undefined;
  constructor(options: { client: RpcClient; store: AgentStore; profile: string; workspace: string; configuration?: RuntimeConfiguration; collaboration?: WorkerCollaboration; codegraph?: WorkerCodeGraphQueue; customTools?: WorkerCustomToolQueue }) {
    this.workspaceGate = options.configuration?.taskWorkspace ? new TaskWorkspaceGate(options.store, options.configuration.taskWorkspace.key) : undefined;
    this.configuration = options.configuration; this.customTools = options.customTools;
    this.conversations = new WorkerConversation(options.store, options.configuration?.verificationProtocol === 1 && packToolAllowed(options.configuration.enabledTools, 'request_verification'));
    this.work = options.configuration?.workProtocol === 1 ? new WorkerWork(options.store, options.workspace, options.configuration.profileId, options.configuration.permissions.fileWrite) : undefined;
    this.integration = options.configuration?.integrationProtocol === 1 ? new WorkerIntegration(options.store, options.workspace, options.configuration.profileId, options.configuration.permissions.fileWrite, options.configuration.applicationProtocol === 1) : undefined;
    this.verification = options.configuration?.verificationProtocol === 1 ? new WorkerVerification(options.store, options.workspace) : undefined;
    this.client = options.client; this.store = options.store; this.profile = options.profile;
    this.workspace = options.workspace;
    this.collaboration = options.collaboration; this.codegraph = options.codegraph;
    if (this.configuration?.permissionProtocol === 1) this.client.handleApprovals?.((method, params) => {
      const active = this.active;
      if (!active || active.stopRequested || params.threadId !== active.threadId || (active.turnId && params.turnId !== active.turnId)) return;
      const task = this.store.task(active.id);
      if (!task?.roomId) return;
      const fileWrite = method === 'item/fileChange/requestApproval' && !this.configuration!.permissions.fileWrite;
      const commandExecution = method === 'item/commandExecution/requestApproval' && !this.configuration!.permissions.commandExecution;
      if (shouldRequestPermissions(task.permissionRequest, { fileWrite, commandExecution })) this.store.update(task.id, { permissionRequest: { id: randomUUID(), fileWrite, commandExecution, status: 'pending',
        reason: fileWrite ? 'This task needs permission to modify project files.' : 'This task needs permission to run commands.' } });
    });
    if (this.customTools || this.collaboration || this.codegraph || this.configuration?.decisionProtocol === 1 || this.configuration?.permissionProtocol === 1) {
      if (!this.client.handleTools) throw new Error('Collaboration requires dynamic tool support.');
      this.client.handleTools(async params => {
        const active = this.active;
        if (!active || params.threadId !== active.threadId || (active.turnId && params.turnId !== active.turnId)) {
          throw new Error('Tool call does not belong to the active task.');
        }
        if (active.stopRequested) throw new Error('Task is stopping.');
        active.health.activity('tool');
        const tool = textValue(params.tool, 'tool');
        assertPackToolAllowed(this.configuration?.enabledTools, tool);
        const task = this.store.task(active.id)!;
        if (tool === 'request_execution_permissions' && this.configuration?.permissionProtocol === 1) {
          if (!task.roomId) throw new Error('Permission requests require a Chats task.');
          const requested = parsePermissionRequest({ ...record(params.arguments), id: randomUUID(), status: 'pending' });
          if (coversPermissions(this.configuration.permissions, requested)) {
            const intake = !!task.dialogue && !task.goal;
            if (intake) active.intakePermissionsConfirmed = true;
            return { status: 'already-allowed', phase: intake ? 'intake' : 'execution',
              permissions: this.configuration.permissions,
              message: intake ? intakeGuidance : 'These permissions are already enabled. Continue within the saved permissions, sandbox boundaries and instructions.' };
          }
          const missing = { ...requested, fileWrite: requested.fileWrite && !this.configuration.permissions.fileWrite,
            commandExecution: requested.commandExecution && !this.configuration.permissions.commandExecution };
          if (shouldRequestPermissions(task.permissionRequest, missing)) this.store.update(task.id, { permissionRequest: missing });
          const saved = this.store.task(task.id)!.permissionRequest!;
          return { ...saved, message: saved.status === 'denied' ? 'The user denied these permissions. Do not repeat the same request or treat it as approval.' : 'End this turn. The user must decide in Chats.' };
        }
        if (task.dialogue && conversationTools.some(t => t.name === tool)) {
          const result = this.conversations.call(task, tool, params.arguments);
          if (tool !== 'conversation_status') active.observations.add({ tool, result });
          return result;
        }
        if (task.dialogue && (!task.goal || task.goal.turns === 0) && ![...codegraphTools.map(t => t.name), 'list_agents', 'ask_agent', 'collaboration_status'].includes(tool)) throw new Error('Intake is read-only. Record the work goal, then end this turn.');
        if (task.goal) {
          if (tool === 'goal_status') return { originalGoal: task.dialogue?.objective ?? task.prompt, ...goalContext(task.goal) };
          if (tool === 'record_decision') {
            const decision = parseDecision(params.arguments);
            if (decision.action === 'complete' && task.integration) {
              if (!this.integration) throw new Error('Integration unavailable.');
              this.integration.assertComplete(task, active.messages);
            }
            if (decision.action === 'complete') this.work?.assertReviewed(task);
            if (decision.action === 'complete' && task.goal.verificationRequired && !task.integration) {
              if (!this.collaboration) throw new Error('Independent verification is unavailable.');
              this.collaboration.assertVerified(task, active.messages);
            }
            validateDecision(task.goal, decision, (waitingForUser(this.store.task(task.id)!) || (this.collaboration?.waiting(task.id, active.messages) ?? false)));
            if (task.goal.pending && JSON.stringify(task.goal.pending) !== JSON.stringify(decision)) throw new Error('A decision was already recorded for this turn.');
            this.store.update(task.id, { goal: { ...task.goal, pending: decision } });
            return { status: 'recorded', guidance: 'End this turn now. The decision is applied only after successful turn completion.' };
          }
          if (task.goal.pending) throw new Error('End the turn after recording its decision.');
        }
        if (task.workDraft) throw new Error('End the turn after submitting work.');
        if (this.integration && [...integrationTools, ...applicationTools].some(t => t.name === tool)) {
          if (applicationTools.some(t => t.name === tool) && task.applicationTools !== true) throw new Error('Start a new goal to acquire application tools.');
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
        if (tool.startsWith('homie_')) {
          const definition = this.configuration?.customTools?.find(t => `homie_${t.name}` === tool && t.enabled);
          if (!definition || !this.customTools) throw new Error('Custom tool is disabled or unavailable.');
          if (!this.configuration?.permissions.commandExecution || task.consultation) throw new Error('Custom scripts require command permission outside read-only consultation.');
          const result = record(await this.customTools.call(tool, customToolArguments(definition, params.arguments), active.controller.signal));
          active.observations.add({ tool, result });
          return result;
        }
        if (this.codegraph && codegraphTools.some(t => t.name === tool)) {
          const result = record(await this.codegraph.call(tool, params.arguments, active.controller.signal));
          if (result.isError !== true) active.observations.add({ tool, result });
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

  resolvePermissions(id: string, roomId: string, requestId: string, decision: 'allow' | 'deny') {
    if (this.busy || this.store.snapshot().tasks.some(t => t.status === 'unknown')) throw new TaskConflict('Wait for the worker or inspect unfinished execution before changing permissions.');
    const task = this.store.task(id), request = task?.permissionRequest;
    if (!task || task.roomId !== roomId || !request || request.id !== requestId) throw new TaskConflict('Permission request changed.');
    const status = decision === 'allow' ? 'allowed' : 'denied';
    if (request.status !== 'pending' && request.status !== status) throw new TaskConflict('Permission request already decided.');
    if (decision === 'allow' && (!this.configuration || !coversPermissions(this.configuration.permissions, request))) throw new TaskConflict('Start the worker with the approved project permissions first.');
    this.store.update(id, { permissionRequest: { ...request, status } });
    return { status };
  }

  prepareWorkspace() { return this.busy || this.store.snapshot().tasks.some(t => t.status === 'unknown') ? null : this.workspaceGate?.prepare(false) ?? null; }
  resumeWorkspace() { if (this.workspaceGate) this.workspaceGate.frozen = false; this.store.changed(); }
  private get workspaceWaiting(): boolean { return this.workspaceGate?.frozen === true || !!this.workspaceGate?.pending(); }
  private assertTaskWorkspace(task: Task): void {
    if (this.workspaceGate && !this.workspaceGate.allows(task)) throw new TaskConflict('This operation requires the task’s saved workspace.');
  }

  get busy(): boolean { return this.active !== null || this.recovering; }
  get error(): string | null { return this.failure; }
  get executionHealth() { return this.active?.health.snapshot() ?? null; }
  checkHealth(): Promise<void> { return this.active?.health.check(this.client, this.active.threadId) ?? Promise.resolve(); }

  activity() {
    const state = this.store.snapshot();
    return { ...state, tasks: projectTaskActivities(state.tasks).map(task => task.integration && this.integration && (!this.workspaceGate || this.workspaceGate.allows(task))
      ? { ...task, integration: this.integration.inspect(task)! } : task) };
  }

  submit(id: string, prompt: string, chat?: { roomId: string; conversation: string; goal: boolean; automatic?: true; userText?: string }): Task {
    if (chat) { validateTaskId(chat.roomId); validateTaskId(chat.conversation); if (typeof chat.goal !== 'boolean') throw new TypeError('Invalid chat mode.'); }
    if (chat?.automatic && (typeof chat.userText !== 'string' || !chat.userText.trim() || chat.userText.length > 16000)) throw new Error('Invalid original user message.');
    if (chat?.automatic && this.configuration?.conversationProtocol !== 1) throw new Error('Restart the worker to enable conversational tasks.');
    validateTaskId(id); textValue(prompt, 'prompt');
    if (prompt.length > 20_000) throw new TypeError('Prompt is too long.');
    if (this.failure) throw new Error(this.failure);
    const existing = this.store.task(id);
    if (existing) {
      if (existing.prompt !== prompt || existing.roomId !== chat?.roomId || (chat && (existing.conversation !== chat.conversation || (chat.automatic ? existing.dialogue?.userText !== chat.userText : Boolean(existing.goal) !== (chat.goal && this.configuration?.decisionProtocol === 1))))) throw new TaskConflict('This task id belongs to a different prompt.');
      return existing;
    }
    if (this.store.snapshot().tasks.some(task => task.status === 'unknown')) {
      throw new TaskConflict('A previous execution outcome is unknown. Inspect its saved thread before starting more work.');
    }
    if (this.busy || this.workspaceWaiting) throw new TaskConflict('This specialist already has an active task.');
    const task = this.store.create(id, prompt, { ...(this.collaboration || this.workspaceGate ? { conversation: id } : {}),
      ...(this.configuration?.decisionProtocol === 1 && (!chat || chat.goal) ? { goal: newGoal(Boolean(this.verification) && packToolAllowed(this.configuration?.enabledTools, 'request_verification')), conversation: id } : {}), ...(chat ? { roomId: chat.roomId, conversation: chat.conversation, ...(chat.automatic ? { dialogue: { userText: textValue(chat.userText, 'user message'), questions: [], revisions: [] } } : {}) } : {}) });
    return this.launch(task, prompt);
  }

  input(id: string, inputId: string, prompt: string, roomId: string, questionId?: string): Task {
    validateTaskId(inputId); textValue(prompt, 'prompt');
    if (prompt.length > 16_000) throw new TypeError('Follow-up is too long.');
    const task = this.store.task(id);
    if (!task || task.roomId !== roomId || (!task.goal && !task.dialogue)) throw new TaskConflict('Unknown room goal.');
    const previous = task.inputs?.find(i => i.id === inputId);
    if (previous) {
      if (previous.prompt !== prompt || previous.questionId !== questionId) throw new TaskConflict('Input identity conflict.');
      return task;
    }
    if (this.workspaceWaiting || (this.busy && this.active?.id !== id) || this.failure || this.store.snapshot().tasks.some(t => t.status === 'unknown')) throw new TaskConflict('Worker cannot safely resume yet.');
    if (task.status === 'completed') throw new TaskConflict('This goal is completed. Start a new goal.');
    const question = questionId ? task.dialogue?.questions.find(q => q.id === questionId) : undefined;
    if (questionId && (!question || question.answer)) throw new TaskConflict('Unknown or already answered user question.');
    const dialogue = task.dialogue && { ...task.dialogue, ...(task.dialogue.intakeRecovery === 'queued' ? { intakeRecovery: undefined } : {}),
      ...(task.dialogue.route && !task.dialogue.route.delivered ? { route: { ...task.dialogue.route, held: true as const } } : {}),
      questions: task.dialogue.questions.map(q => question && q.id === questionId ? { ...q, answer: { id: inputId, text: prompt } } : q) };
    if (this.active?.id === id) {
      this.store.update(id, { ...(dialogue ? { dialogue } : {}), inputs: [...(task.inputs ?? []), { id: inputId, prompt, pending: true, ...(questionId ? { questionId } : {}) }] });
      return this.store.task(id)!;
    }
    this.store.update(id, { ...(dialogue ? { dialogue } : {}), inputs: [...(task.inputs ?? []).map(({ pending, ...input }) => input), { id: inputId, prompt, ...(questionId ? { questionId } : {}) }], ...(task.goal ? { goal: { ...task.goal, progressCheck: { unchanged: 0, observations: [] } } } : {}), status: 'accepted', finishedAt: null });
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

  private launch(task: Task, input: string, messages: string[] = [], intakeRetry = false): Task {
    if (this.workspaceGate?.defer(task, { input, messages, intakeRetry })) return this.store.task(task.id)!;
    const id = task.id;
    // A lost acknowledgement must never reuse the preceding turn's identity.
    this.store.update(id, { status: 'accepted', finishedAt: null, threadId: null, turnId: null, recovery: undefined });
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
    const commands = new CommandSessions();
    const active: ActiveTask = { commands, id, threadId: null, turnId: null, observations, health: new ExecutionHealth(id), intakeRetry,
      stopRequested: false, done: Promise.resolve(), observer: new TurnObserver((method, item, turnId) => {
        recordTaskActivity(this.store, id, method, item, turnId); commands.observe(method, item); observations.item(method, item);
        if (this.configuration?.permissions.commandExecution === true) this.verification?.observe(task, method, item);
      }, (threadTotals, threadId, turnId) => {
        this.store.update(id, { usage: mergeTurnUsage(this.store.task(id)?.usage, {
          threadId, turnId, modelCalls: null, tokens: null, threadTotals,
        }) });
      }), interrupting: null, input, messages, controller: new AbortController() };
    this.active = active;
    active.done = this.run(task, active).finally(() => { if (this.active === active) this.active = null; this.store.changed(); });
    // A persistence failure is reported through the worker's health/lifecycle, not an unhandled rejection.
    void active.done.catch(() => { this.failure = 'Could not persist specialist task state.'; this.store.changed(); });
    return task;
  }

  /** Called after exchanges and turn completion. Waiting tasks do not occupy the execution slot. */
  pump(): void {
    this.collaboration?.expire();
    if (this.busy || this.failure || this.store.snapshot().tasks.some(t => t.status === 'unknown')) return;
    if (this.workspaceGate?.frozen) return;
    const pendingWorkspace = this.workspaceGate?.pending();
    if (pendingWorkspace) {
      if (this.workspaceGate!.allows(pendingWorkspace)) {
        const run = pendingWorkspace.workspaceRun!;
        this.launch(pendingWorkspace, run.input, run.messages, run.intakeRetry);
      }
      return;
    }
    const queued = this.store.snapshot().tasks.find(t => t.status === 'waiting' && t.inputs?.some(i => i.pending === true));
    if (queued) {
      const inputs = queued.inputs!.filter(i => i.pending === true);
      this.store.update(queued.id, { status: 'accepted', finishedAt: null, inputs: queued.inputs!.map(({ pending, ...input }) => input),
        ...(queued.goal ? { goal: { ...queued.goal, pending: null, progressCheck: { unchanged: 0, observations: [] } } } : {}) });
      this.launch(this.store.task(queued.id)!, `User corrections received during the preceding turn. Apply these before continuing; explain what already ran and what you will change.\n${inputs.map(i => i.prompt).join('\n\n')}`);
      return;
    }
    const intake = this.store.snapshot().tasks.find(t => t.status === 'waiting' && t.dialogue?.intakeRecovery === 'queued' && intakeNeedsAction(t));
    if (intake) {
      this.store.update(intake.id, { status: 'accepted', finishedAt: null,
        dialogue: { ...intake.dialogue!, intakeRecovery: 'attempted' } });
      this.launch(this.store.task(intake.id)!, `Reassess the previous intake once. The requested project permissions were already allowed, but no work action was recorded. ${intakeGuidance}\nUser request (unchanged authority):\n${intake.inputs?.at(-1)?.prompt ?? intake.dialogue!.userText}`, [], true);
      return;
    }
    const routed = this.store.snapshot().tasks.find(t => t.status === 'completed' && t.dialogue?.route && !t.dialogue.route.delivered && !t.dialogue.route.held);
    if (routed) {
      const target = this.store.task(routed.dialogue!.route!.taskId);
      const inputs = [{ id: routed.id, prompt: routed.dialogue!.userText }, ...(routed.inputs ?? []).map(i => ({ id: i.id, prompt: i.prompt }))];
      const userFollowup = inputs.map(i => `User input (${i.id}):\n${i.prompt}`).join('\n');
      if (target && (target.goal || waitingForUser(target)) && target.roomId === routed.roomId && target.status !== 'completed') {
        this.store.transaction(state => {
          state.tasks.find(t => t.id === routed.id)!.dialogue!.route!.delivered = true;
          const next = state.tasks.find(t => t.id === target.id)!;
          next.inputs = [...(next.inputs ?? []), ...inputs];
          if (next.goal) next.goal.progressCheck = { unchanged: 0, observations: [] };
          next.status = 'accepted'; next.finishedAt = null;
        });
        this.launch(this.store.task(target.id)!, `User follow-up (${routed.id}):\n${userFollowup}`);
        return;
      }
    }
    const next = this.collaboration?.next();
    if (!next) {
      const ready = this.store.snapshot().tasks.find(t => t.status === 'waiting' && t.goal?.phase === 'ready');
      if (ready) this.launch(ready, `Continue the original goal: ${ready.prompt}\nSaved goal state (reference data):\n${JSON.stringify(goalContext(ready.goal!))}\nPerform the next action within the original authority.`);
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
    if (!scratch && !task.dialogue && savedThread && this.loadedThreads.has(savedThread)) return savedThread;
    if ((scratch || task.dialogue) && savedThread && this.loadedThreads.has(savedThread)) {
      // Codex 0.159.3 ignores config overrides for an already-loaded thread.
      // Unsubscribe unloads the idle execution session, not its persisted history.
      await this.client.request('thread/unsubscribe', { threadId: savedThread });
      this.loadedThreads.delete(savedThread);
    }
    const settings = this.configuration;
    const intake = !!task.dialogue && !task.goal;
    const projectWritable = !intake && !task.consultation && !task.verification && !task.delegation && settings?.permissions.fileWrite === true;
    // Native resumed conversations retain the dynamic tool set from their creation.
    const integrationAvailable = this.integration && packToolAllowed(settings?.enabledTools, integrationTools[0]!.name) && (!savedThread || task.integrationTools === true);
    const applicationAvailable = integrationAvailable && settings?.applicationProtocol === 1 && (!savedThread || task.applicationTools === true);
    const codegraphAvailable = this.codegraph && packToolAllowed(settings?.enabledTools, codegraphTools[0]!.name) && (!savedThread || saved.tasks.some(t => t.threadId === savedThread && t.codegraphTools === true));
    const profile = this.profile + (settings?.enabledTools ? `\nEnabled Homie tool groups: ${settings.enabledTools.join(', ') || 'none'}. Disabled groups are unavailable even if older instructions mention them.\n` : '') + (codegraphAvailable ? codegraphInstructions : this.codegraph ? '\nThis older conversation has no CodeGraph tools. Use scoped source reads within existing permissions; a new conversation is required for CodeGraph tools.\n' : '') + (settings?.permissionProtocol === 1 ? permissionInstructions : '') + (this.collaboration ? collaborationInstructions : '') + (task.goal ? decisionInstructions : '') + (task.dialogue ? conversationInstructions : '') + (this.verification ? verificationInstructions : '') + (this.work ? workInstructions : '') + (integrationAvailable ? integrationInstructions : '')
      + (integrationAvailable && settings?.candidateVerificationProtocol === 1 ? candidateVerificationInstructions : '') + (applicationAvailable ? applicationInstructions : '')
      + (intake ? `\nCurrent stage: intake. Saved project permissions: fileWrite=${settings?.permissions.fileWrite === true}, commandExecution=${settings?.permissions.commandExecution === true}. ${intakeGuidance}\n` : '');
    const params: JsonRecord = { cwd: workspace,
      ...(scratch ? { permissions: SCRATCH_PROFILE } : { sandbox: !intake && !task.consultation && !task.verification && !task.delegation && settings?.permissions.fileWrite === true ? 'workspace-write' : 'read-only' }), approvalPolicy: 'on-request',
      approvalsReviewer: 'user', developerInstructions: profile,
      ...(settings ? { model: settings.model, serviceTier: settings.serviceTier, config: {
        ...(settings.reasoningEffort ? { model_reasoning_effort: settings.reasoningEffort } : {}),
        'features.shell_tool': !intake && !task.consultation && settings.permissions.commandExecution,
        'features.unified_exec': !intake && !task.consultation && settings.permissions.commandExecution,
        'features.multi_agent': false,
        ...(scratch ? scratch.config(workspace, projectWritable) : {}),
      } } : {}) };
    const result = savedThread
      ? await this.client.request('thread/resume', { ...params, threadId: savedThread })
      : await this.client.request('thread/start', { ...params, dynamicTools: [...(this.configuration?.customTools ?? []).filter(t => t.enabled).map(customToolDefinition), ...(this.codegraph ? codegraphTools : []), ...(settings?.permissionProtocol === 1 ? permissionTools : []), ...(this.collaboration ? collaborationTools : []), ...(task.goal || task.dialogue ? decisionTools : []), ...(task.dialogue ? conversationTools : []), ...(this.verification ? verificationTools : []), ...(this.work ? workTools : []), ...(this.integration ? integrationTools : []), ...(applicationAvailable ? applicationTools : [])].filter(tool => packToolAllowed(settings?.enabledTools, tool.name)) });
    const threadId = textValue(record(result.thread).id, 'thread id');
    assertResumedThread(savedThread, threadId);
    const nativePath = record(result.thread).path;
    if (typeof nativePath === 'string') this.threadPaths.set(threadId, nativePath);
    else this.threadPaths.delete(threadId);
    scratch?.assertApplied(result, projectWritable ? workspace : undefined);
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
    if (codegraphAvailable) this.store.update(task.id, { codegraphTools: true });
    if (integrationAvailable) this.store.update(task.id, { integrationTools: true, ...(applicationAvailable ? { applicationTools: true as const } : {}) });
    this.loadedThreads.add(threadId);
    return threadId;
  }

  private async run(task: Task, active: ActiveTask): Promise<void> {
    const observer = active.observer;
    const remove = this.client.subscribe(event => {
      active.health.receive(event, active.threadId, active.turnId);
      observer.receive(event);
    });
    const removeFailure = this.client.onFailure(error => observer.fail(error));
    let submitted = false;
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
      if (!task.delegation && !task.consultation && this.configuration?.permissions.commandExecution === true) {
        scratch = new TaskScratch(); this.retainedScratch.add(scratch);
      }
      if ((!task.dialogue || task.goal) && !task.consultation && !task.verification && !task.delegation
        && this.configuration?.permissions.fileWrite === true) assertWritableWorkspace(workspace);
      active.threadId = await this.thread(task, scratch, workspace);
      if (active.stopRequested) {
        this.store.complete(task.id, { status: 'interrupted', output: '', error: null,
          ...(task.goal ? { goal: { ...task.goal, phase: 'paused', pending: null } } : {}) }, active.messages,
          task.delegation && this.work ? this.work.resultMessage(task, 'interrupted', 'Stopped before execution.') : undefined); return;
      }
      const memory = this.workspaceGate || task.consultation || task.verification || task.delegation ? '' : this.store.memory();
      const input = memory ? `Saved work summary (reference data):\n${memory}\n\nCurrent task:\n${active.input}` : active.input;
      this.store.update(task.id, { threadId: active.threadId, turnId: null });
      submitted = true;
      const response = await this.client.request('turn/start', {
        threadId: active.threadId, input: [{ type: 'text', text: input }], cwd: workspace,
        approvalPolicy: 'on-request', approvalsReviewer: 'user',
        ...(scratch ? { permissions: SCRATCH_PROFILE } : { sandboxPolicy: (!task.dialogue || !!task.goal) && !task.consultation && !task.verification && !task.delegation && this.configuration?.permissions.fileWrite === true
          ? { type: 'workspaceWrite', writableRoots: [this.workspace], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true }
          : { type: 'readOnly', networkAccess: false } }),
        ...(this.configuration ? { model: this.configuration.model, effort: this.configuration.reasoningEffort, serviceTier: this.configuration.serviceTier } : {}),
      });
      active.turnId = textValue(record(response.turn).id, 'turn id');
      this.store.update(task.id, { threadId: active.threadId, turnId: active.turnId, status: 'running' });
      observer.identify(active.threadId, active.turnId);
      if (active.stopRequested) {
        try { await this.interrupt(active); }
        catch (error) { if (!observer.finished) observer.fail(error instanceof Error ? error : new Error(String(error))); }
      }
      const result = await observer.result;
      await this.saveUsage(active);
      if (active.stopRequested || result.status === 'interrupted') {
        active.health.activity('stopping');
        try { await active.commands.stop(this.client, active.threadId); }
        catch (error) {
          this.failure = 'Could not confirm command termination. Restart the worker before continuing.';
          throw error;
        }
      }
      const currentGoal = this.store.task(task.id)?.goal, reported = observer.usage;
      const savedGoal = currentGoal && reported ? { ...currentGoal, usage: {
        reportedThroughTurn: currentGoal.turns, ...reported,
      } } : currentGoal;
      if (!active.stopRequested && result.status === 'completed' && this.store.task(task.id)?.permissionRequest?.status === 'pending') {
        this.store.complete(task.id, { ...result, status: 'waiting', ...(savedGoal ? { goal: { ...savedGoal, phase: 'blocked', pending: null } } : {}) }, active.messages);
      } else if (!active.stopRequested && result.status === 'completed' && this.store.task(task.id)?.inputs?.some(i => i.pending === true)) {
        this.store.complete(task.id, { ...result, status: 'waiting',
          ...(savedGoal ? { goal: { ...savedGoal, phase: 'ready', pending: null } } : {}) }, active.messages);
      } else if (!active.stopRequested && result.status === 'completed' && (active.intakePermissionsConfirmed || active.intakeRetry)
        && intakeNeedsAction(this.store.task(task.id)!)) {
        const current = this.store.task(task.id)!;
        const attempted = current.dialogue!.intakeRecovery === 'attempted';
        if (!attempted) this.store.update(task.id, { dialogue: { ...current.dialogue!, intakeRecovery: 'queued' } });
        this.store.complete(task.id, { ...result, status: attempted ? 'interrupted' : 'waiting',
          error: attempted ? 'The Homie did not transition from intake to work after one recheck. No work completion was established. Inspect the conversation before continuing.' : null }, active.messages);
      } else if (task.delegation && this.work) {
        const outgoing = this.work.resultMessage(this.store.task(task.id)!, result.status, result.error || result.output);
        this.store.complete(task.id, result, active.messages, outgoing);
      } else if (active.stopRequested && savedGoal && !(result.status === 'completed' && savedGoal.pending?.action === 'complete')) {
        this.store.complete(task.id, { status: 'interrupted', output: result.output, error: null,
          goal: { ...savedGoal, phase: 'paused', pending: null } }, active.messages);
      } else if (result.status === 'completed' && savedGoal && !task.goal) {
        this.store.complete(task.id, { ...result, goal: savedGoal, status: 'waiting' }, active.messages);
      } else if (result.status === 'completed' && task.goal) {
        let verificationError: string | null = null;
        if (savedGoal?.pending?.action === 'complete' && (savedGoal.verificationRequired || this.store.task(task.id)?.integration)) {
          try {
            const current = this.store.task(task.id)!;
            if (current.integration) this.integration!.assertComplete(current, active.messages);
            else this.collaboration!.assertVerified(current, active.messages);
          }
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
        const outcome = finishGoal({ ...savedGoal!, progressCheck: active.observations.finish(savedGoal?.progressCheck) }, (waitingForUser(this.store.task(task.id)!) || (this.collaboration?.waiting(task.id, active.messages) ?? false)));
        this.store.complete(task.id, { ...result, ...outcome }, active.messages);
      } else if (result.status === 'completed' && this.collaboration) {
        if (task.verification && this.verification) this.collaboration.publishVerification(task, this.verification.finish(this.store.task(task.id)!));
        if (task.consultation && !this.collaboration.hasReply(task)) this.collaboration.reply(task, result.output || 'No answer was produced.');
        const waiting = waitingForUser(this.store.task(task.id)!) || this.collaboration.waiting(task.id, active.messages);
        this.store.complete(task.id, { ...result, status: waiting ? 'waiting' : 'completed' }, active.messages);
      } else this.store.complete(task.id, { ...result, ...(result.status === 'completed' && waitingForUser(this.store.task(task.id)!) ? { status: 'waiting' as const } : {}), ...(savedGoal ? { goal: { ...savedGoal, phase: 'blocked', pending: null } } : {}) });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.saveUsage(active);
      const outgoing = !submitted && task.delegation && this.work ? this.work.resultMessage(task, 'failed', reason) : undefined;
      this.store.complete(task.id, { status: submitted ? 'unknown' : active.stopRequested ? 'interrupted' : 'failed',
        output: '', error: reason }, outgoing ? active.messages : [], outgoing);
    } finally {
      active.controller.abort(); remove(); removeFailure();
      // Unknown executions may still own child processes. Retain their scratch until
      // app-server shutdown; the existing unknown-task gate prevents another turn.
      if (scratch && this.store.task(task.id)?.status !== 'unknown') {
        let released = true;
        if (active.threadId) {
          try {
            // Release the subscription after explicit stopped-command cleanup.
            // Unsubscribe alone does not terminate background command sessions.
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

  private async saveUsage(active: ActiveTask): Promise<void> {
    if (!active.threadId || !active.turnId) return;
    const reported = await readNativeTurnUsage(this.threadPaths.get(active.threadId), active.threadId, active.turnId);
    const task = this.store.task(active.id)!;
    this.store.update(active.id, { usage: mergeTurnUsage(task.usage, {
      threadId: active.threadId, turnId: active.turnId, modelCalls: reported?.modelCalls ?? null,
      tokens: reported?.tokens ?? null, threadTotals: active.observer.threadTotals,
    }) });
  }

  private async interrupt(active: ActiveTask): Promise<void> {
    if (!active.threadId || !active.turnId || active.observer.finished) return;
    active.interrupting ??= this.client.request('turn/interrupt', {
      threadId: active.threadId, turnId: active.turnId,
    }).then(() => {});
    await active.interrupting;
  }

  inspectApplication(id: string, roomId: string, candidateId: string, hash: string): Task {
    validateTaskId(id); validateTaskId(roomId);
    const task = this.store.task(id);
    if (!task?.goal || task.roomId !== roomId || !task.integration || !this.integration
      || this.configuration?.applicationInspectionProtocol !== 1) throw new TaskConflict('Application inspection is unavailable for this goal.');
    if (this.busy || this.failure || this.retainedScratch.size || this.store.snapshot().tasks.some(t => ['unknown', 'accepted', 'running'].includes(t.status))) {
      throw new TaskConflict('Stop active work and inspect unknown executions before inspecting application state.');
    }
    if (!['interrupted', 'failed', 'completed'].includes(task.status)) throw new TaskConflict('Stop goal judgment before inspecting application state.');
    this.assertTaskWorkspace(task);
    this.recovering = true;
    try {
      // No model call, prompt, goal decision, replay or automatic continuation.
      this.integration.call(task, 'recover_integration', { candidateId, hash });
      return this.store.task(id)!;
    } finally { this.recovering = false; this.store.changed(); }
  }

  async recover(id: string, roomId: string): Promise<Task> {
    validateTaskId(id); validateTaskId(roomId);
    const task = this.store.task(id);
    if (!task || task.roomId !== roomId || (!task.dialogue && !task.goal && !task.consultation && !task.verification && !task.delegation)
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
    this.assertTaskWorkspace(task);
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
    } finally { this.recovering = false; this.store.changed(); }
  }

  async stop(id: string): Promise<void> {
    const active = this.active;
    if (!active || active.id !== id) {
      const task = this.store.task(id);
      if (task?.workspaceRun) { this.store.update(id, { workspaceRun: undefined }); this.resumeWorkspace(); }
      if (task?.status === 'waiting') this.store.complete(id, { status: 'interrupted', output: task.output, error: null,
        ...(task.goal ? { goal: { ...task.goal, phase: 'paused', pending: null } } : {}) });
      return;
    }
    active.stopRequested = true;
    active.health.activity('stopping');
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
