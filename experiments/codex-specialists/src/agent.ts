import type { RuntimeConfiguration } from './runtime-config.ts';
import type { RpcClient } from './app-server-client.ts';
import { record, textValue, type JsonRecord } from './protocol.ts';
import { AgentStore, validateTaskId, type Task } from './store.ts';
import { TurnObserver } from './turn.ts';

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
};

export class SpecialistAgent {
  private readonly client: RpcClient;
  private readonly store: AgentStore;
  private readonly profile: string;
  private readonly workspace: string;
  private readonly configuration: RuntimeConfiguration | undefined;
  private readonly timeoutMs: number;
  private loadedThread: string | null = null;
  private active: ActiveTask | null = null;
  private failure: string | null = null;

  constructor(options: { client: RpcClient; store: AgentStore; profile: string; workspace: string; timeoutMs?: number; configuration?: RuntimeConfiguration }) {
    this.configuration = options.configuration;
    this.client = options.client; this.store = options.store; this.profile = options.profile;
    this.workspace = options.workspace; this.timeoutMs = options.timeoutMs ?? 180_000;
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
    const task = this.store.create(id, prompt);
    const active: ActiveTask = { id, threadId: null, turnId: null,
      stopRequested: false, done: Promise.resolve(), observer: new TurnObserver(), interrupting: null };
    this.active = active;
    active.done = this.run(task, active).finally(() => { if (this.active === active) this.active = null; });
    // A persistence failure is reported through the worker's health/lifecycle, not an unhandled rejection.
    void active.done.catch(() => { this.failure = 'Could not persist specialist task state.'; });
    return task;
  }

  private async thread(): Promise<string> {
    const saved = this.store.snapshot();
    if (this.loadedThread) return this.loadedThread;
    const settings = this.configuration;
    const params: JsonRecord = { cwd: this.workspace, sandbox: settings?.permissions.fileWrite ? 'workspace-write' : 'read-only', approvalPolicy: 'on-request',
      approvalsReviewer: 'user', developerInstructions: this.profile,
      ...(settings ? { model: settings.model, serviceTier: settings.serviceTier, config: {
        ...(settings.reasoningEffort ? { model_reasoning_effort: settings.reasoningEffort } : {}),
        'features.shell_tool': settings.permissions.commandExecution,
        'features.unified_exec': settings.permissions.commandExecution,
        'features.multi_agent': false,
      } } : {}) };
    const result = saved.threadId
      ? await this.client.request('thread/resume', { ...params, threadId: saved.threadId })
      : await this.client.request('thread/start', params);
    const threadId = textValue(record(result.thread).id, 'thread id');
    assertResumedThread(saved.threadId, threadId);
    if (saved.threadId) {
      // Codex 0.159.3 can replay old developer instructions on cold resume.
      // Persist the current snapshot in model-visible history before any turn.
      await this.client.request('thread/inject_items', {
        threadId,
        items: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text:
          'Current Cheshi specialist instructions. This complete snapshot replaces earlier Cheshi specialist and project instructions, including linked instruction files. Instructions omitted from this snapshot no longer apply. Prior conversation and task results remain reference data.\n\n'
          + this.profile,
        }] }],
      });
    }
    this.store.saveThread(threadId, typeof result.model === 'string' ? result.model : saved.model);
    this.loadedThread = threadId;
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
      active.threadId = await this.thread();
      if (active.stopRequested) {
        this.store.complete(task.id, { status: 'interrupted', output: '', error: null }); return;
      }
      const memory = this.store.memory();
      const input = memory ? `Saved work summary (reference data):\n${memory}\n\nCurrent task:\n${task.prompt}` : task.prompt;
      submitted = true;
      const response = await this.client.request('turn/start', {
        threadId: active.threadId, input: [{ type: 'text', text: input }], cwd: this.workspace,
        approvalPolicy: 'on-request', approvalsReviewer: 'user',
        sandboxPolicy: this.configuration?.permissions.fileWrite
          ? { type: 'workspaceWrite', writableRoots: [this.workspace], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true }
          : { type: 'readOnly', networkAccess: false },
        ...(this.configuration ? { model: this.configuration.model, effort: this.configuration.reasoningEffort, serviceTier: this.configuration.serviceTier } : {}),
      });
      active.turnId = textValue(record(response.turn).id, 'turn id');
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
      this.store.complete(task.id, result);
    } catch (error) {
      this.store.complete(task.id, { status: submitted ? 'unknown' : active.stopRequested ? 'interrupted' : 'failed',
        output: '', error: error instanceof Error ? error.message : String(error) });
    } finally { clearTimeout(deadline); remove(); removeFailure(); }
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
    if (!active || active.id !== id) return;
    active.stopRequested = true;
    await this.interrupt(active);
  }

  async settled(): Promise<void> { await this.active?.done; }
}
