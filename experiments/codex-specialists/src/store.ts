import { parseWorkDraft, type WorkDraft } from './work-contract.ts';
import { parseIntegration, type IntegrationSummary } from './integration-contract.ts';
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { record, textValue } from './protocol.ts';
import { evidence, list, verificationResult, type Evidence, type VerificationResult } from './verification-contract.ts';
import { parseGoal, type GoalState } from './decision.ts';
import { appendOutgoing, collaborationState, emptyCollaboration, type CollaborationMessage, type CollaborationState } from './collaboration-contract.ts';
import { recoveryReceipt, type RecoveryReceipt } from './recovery.ts';

export const TASK_STATUSES = ['accepted', 'running', 'waiting', 'completed', 'interrupted', 'failed', 'unknown'] as const;
export type TaskStatus = typeof TASK_STATUSES[number];
export type Task = {
  id: string; prompt: string; status: TaskStatus; createdAt: string; finishedAt: string | null;
  threadId: string | null; turnId: string | null; output: string; error: string | null;
  roomId?: string; inputs?: { id: string; prompt: string }[]; responses?: { id: string; text: string; status: string }[];
  conversation?: string; consultation?: string; goal?: GoalState;
  verification?: string; verificationEvidence?: Evidence[]; verificationDraft?: VerificationResult;
  delegation?: string; workDraft?: WorkDraft;
  integration?: IntegrationSummary;
  integrationTools?: true; applicationTools?: true;
  recovery?: RecoveryReceipt;
};
type SavedState = { version: 1; threadId: string | null; model: string | null; tasks: Task[];
  threads: Record<string, string>; collaboration: CollaborationState };

export function validateTaskId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value)) throw new TypeError('Invalid task id.');
  return value;
}

function nullableText(value: unknown): string | null {
  if (value === null || typeof value === 'string') return value;
  throw new TypeError('Invalid saved text.');
}

function chatEntries<T>(value: unknown, parse: (value: unknown) => T): T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError('Invalid saved room entries.');
  return value.map(parse);
}

function savedTask(value: unknown): Task {
  const task = record(value);
  if (task.applicationTools !== undefined && task.applicationTools !== true) throw new TypeError('Invalid application tool capability.');
  if (task.integrationTools !== undefined && task.integrationTools !== true) throw new TypeError('Invalid integration tool capability.');
  if (!TASK_STATUSES.some(status => status === task.status) || typeof task.output !== 'string') {
    throw new TypeError('Invalid saved task.');
  }
  return {
    id: validateTaskId(task.id), prompt: textValue(task.prompt, 'saved prompt'), status: task.status as TaskStatus,
    createdAt: textValue(task.createdAt, 'creation time'), finishedAt: nullableText(task.finishedAt),
    threadId: nullableText(task.threadId), turnId: nullableText(task.turnId), output: task.output,
    error: nullableText(task.error),
    ...(task.delegation === undefined ? {} : { delegation: validateTaskId(task.delegation) }),
    ...(task.workDraft === undefined ? {} : { workDraft: parseWorkDraft(task.workDraft) }),
    ...(task.integration === undefined ? {} : { integration: parseIntegration(task.integration) }),
    ...(task.applicationTools === true ? { applicationTools: true as const } : {}),
    ...(task.integrationTools === true ? { integrationTools: true as const } : {}),
    ...(task.recovery === undefined ? {} : { recovery: recoveryReceipt(task.recovery) }),
    ...(task.roomId === undefined ? {} : { roomId: validateTaskId(task.roomId),
      inputs: chatEntries(task.inputs, v => { const i = record(v); return { id: validateTaskId(i.id), prompt: textValue(i.prompt, 'input') }; }),
      responses: chatEntries(task.responses, v => { const r = record(v); return { id: validateTaskId(r.id), text: typeof r.text === 'string' ? r.text : textValue(r.text, 'response'), status: textValue(r.status, 'status') }; }) }),
    ...(task.verification === undefined ? {} : { verification: validateTaskId(task.verification) }),
    ...(task.verificationEvidence === undefined ? {} : { verificationEvidence: list(task.verificationEvidence, evidence, 64) }),
    ...(task.verificationDraft === undefined ? {} : { verificationDraft: verificationResult(task.verificationDraft) }),
    ...(task.goal === undefined ? {} : { goal: parseGoal(task.goal) }),
    ...(task.conversation === undefined ? {} : { conversation: validateTaskId(task.conversation) }),
    ...(task.consultation === undefined ? {} : { consultation: validateTaskId(task.consultation) }),
  };
}

export class AgentStore {
  readonly directory: string;
  private readonly filename: string;
  private state: SavedState;

  constructor(directory: string) {
    this.directory = directory;
    for (const child of ['state', 'memory', 'artifacts']) mkdirSync(join(directory, child), { recursive: true });
    this.filename = join(directory, 'state', 'agent.json');
    if (existsSync(this.filename)) {
      const saved = record(JSON.parse(readFileSync(this.filename, 'utf8')));
      if (saved.version !== 1 || !Array.isArray(saved.tasks)) throw new TypeError('Invalid saved agent state.');
      const threads = saved.threads === undefined ? {} : record(saved.threads);
      for (const [key, value] of Object.entries(threads)) { validateTaskId(key); textValue(value, 'saved thread'); }
      this.state = { version: 1, threadId: nullableText(saved.threadId), model: nullableText(saved.model), tasks: saved.tasks.map(savedTask),
        threads: threads as Record<string, string>, collaboration: saved.collaboration === undefined ? emptyCollaboration() : collaborationState(saved.collaboration) };
      if (new Set(this.state.tasks.map(task => task.id)).size !== this.state.tasks.length) throw new TypeError('Duplicate saved task id.');
    } else this.state = { version: 1, threadId: null, model: null, tasks: [], threads: {}, collaboration: emptyCollaboration() };
    // A crashed process cannot prove whether its submitted work completed. Do not replay it.
    for (const task of this.state.tasks) {
      if (!['accepted', 'running'].includes(task.status)) continue;
      task.status = 'unknown'; task.finishedAt = new Date().toISOString();
      task.error = 'Worker restarted during execution. Inspect the saved thread before retrying.';
    }
    this.persist();
  }

  private write(filename: string, value: unknown): void {
    const temporary = `${filename}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flush: true });
    renameSync(temporary, filename);
  }

  private persist(): void { this.write(this.filename, this.state); }
  transaction<T>(mutate: (state: SavedState) => T): T {
    const next = structuredClone(this.state);
    const result = mutate(next);
    if (JSON.stringify(next) === JSON.stringify(this.state)) return result;
    this.write(this.filename, next);
    this.state = next;
    return result;
  }
  snapshot(): SavedState { return structuredClone(this.state); }
  task(id: string): Task | undefined { return structuredClone(this.state.tasks.find(task => task.id === id)); }
  saveThread(threadId: string, model: string | null, conversation?: string, visible = true): void {
    this.transaction(state => {
      if (conversation) state.threads[conversation] = threadId;
      if (visible) state.threadId = threadId;
      state.model = model;
    });
  }

  create(id: string, prompt: string, options: Pick<Task, 'conversation' | 'consultation' | 'verification' | 'delegation' | 'goal' | 'roomId'> = {}): Task {
    if (this.task(id)) throw new Error('Task already exists.');
    const task: Task = { id, prompt, status: 'accepted', createdAt: new Date().toISOString(), finishedAt: null,
      threadId: null, turnId: null, output: '', error: null, ...options };
    this.transaction(state => { state.tasks.push(task); });
    return structuredClone(task);
  }

  update(id: string, patch: Partial<Omit<Task, 'id' | 'prompt' | 'createdAt'>>): void {
    this.transaction(state => {
      const task = state.tasks.find(task => task.id === id);
      if (!task) throw new Error('Unknown task.');
      Object.assign(task, patch);
    });
  }

  complete(id: string, patch: Pick<Task, 'status' | 'output' | 'error' | 'goal' | 'recovery'>, consumed: string[] = [], outgoing?: CollaborationMessage): void {
    const task = this.task(id);
    if (!task) throw new Error('Unknown task.');
    const result = { ...task, ...patch, ...(task.roomId ? { responses: [...(task.responses ?? []), { id: `response_${(task.responses?.length ?? 0) + 1}`, text: patch.output, status: patch.status }] } : {}), finishedAt: patch.status === 'waiting' ? null : new Date().toISOString() };
    this.transaction(state => {
      // Publish the recovery result and release the unknown-task gate in one state commit.
      if (outgoing) appendOutgoing(state.collaboration, outgoing);
      this.write(join(this.directory, 'artifacts', `${id}.json`), result);
      if (patch.status === 'completed' && !task.consultation && !task.verification && !task.delegation) {
        this.write(join(this.directory, 'memory', 'latest.json'), {
          taskId: id, recordedAt: result.finishedAt, summary: patch.output.slice(0, 8000),
        });
      }
      Object.assign(state.tasks.find(t => t.id === id)!, result);
      for (const messageId of consumed) if (!state.collaboration.consumed.includes(messageId)) state.collaboration.consumed.push(messageId);
    });
  }

  memory(): string {
    const filename = join(this.directory, 'memory', 'latest.json');
    if (!existsSync(filename)) return '';
    const memory = record(JSON.parse(readFileSync(filename, 'utf8')));
    return typeof memory.summary === 'string' ? memory.summary.slice(0, 8000) : '';
  }
}
