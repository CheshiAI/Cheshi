import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { record, textValue } from './protocol.ts';

export const TASK_STATUSES = ['accepted', 'running', 'completed', 'interrupted', 'failed', 'unknown'] as const;
export type TaskStatus = typeof TASK_STATUSES[number];
export type Task = {
  id: string; prompt: string; status: TaskStatus; createdAt: string; finishedAt: string | null;
  threadId: string | null; turnId: string | null; output: string; error: string | null;
};
type SavedState = { version: 1; threadId: string | null; model: string | null; tasks: Task[] };

export function validateTaskId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value)) throw new TypeError('Invalid task id.');
  return value;
}

function nullableText(value: unknown): string | null {
  if (value === null || typeof value === 'string') return value;
  throw new TypeError('Invalid saved text.');
}

function savedTask(value: unknown): Task {
  const task = record(value);
  if (!TASK_STATUSES.some(status => status === task.status) || typeof task.output !== 'string') {
    throw new TypeError('Invalid saved task.');
  }
  return {
    id: validateTaskId(task.id), prompt: textValue(task.prompt, 'saved prompt'), status: task.status as TaskStatus,
    createdAt: textValue(task.createdAt, 'creation time'), finishedAt: nullableText(task.finishedAt),
    threadId: nullableText(task.threadId), turnId: nullableText(task.turnId), output: task.output,
    error: nullableText(task.error),
  };
}

export class AgentStore {
  private readonly directory: string;
  private readonly filename: string;
  private state: SavedState;

  constructor(directory: string) {
    this.directory = directory;
    for (const child of ['state', 'memory', 'artifacts']) mkdirSync(join(directory, child), { recursive: true });
    this.filename = join(directory, 'state', 'agent.json');
    if (existsSync(this.filename)) {
      const saved = record(JSON.parse(readFileSync(this.filename, 'utf8')));
      if (saved.version !== 1 || !Array.isArray(saved.tasks)) throw new TypeError('Invalid saved agent state.');
      this.state = { version: 1, threadId: nullableText(saved.threadId), model: nullableText(saved.model), tasks: saved.tasks.map(savedTask) };
      if (new Set(this.state.tasks.map(task => task.id)).size !== this.state.tasks.length) throw new TypeError('Duplicate saved task id.');
    } else this.state = { version: 1, threadId: null, model: null, tasks: [] };
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
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, filename);
  }

  private persist(): void { this.write(this.filename, this.state); }
  snapshot(): SavedState { return structuredClone(this.state); }
  task(id: string): Task | undefined { return structuredClone(this.state.tasks.find(task => task.id === id)); }
  saveThread(threadId: string, model: string | null): void {
    this.state.threadId = threadId; this.state.model = model; this.persist();
  }

  create(id: string, prompt: string): Task {
    if (this.task(id)) throw new Error('Task already exists.');
    const task: Task = { id, prompt, status: 'accepted', createdAt: new Date().toISOString(), finishedAt: null,
      threadId: null, turnId: null, output: '', error: null };
    this.state.tasks.push(task); this.persist();
    return structuredClone(task);
  }

  update(id: string, patch: Partial<Omit<Task, 'id' | 'prompt' | 'createdAt'>>): void {
    const task = this.state.tasks.find(task => task.id === id);
    if (!task) throw new Error('Unknown task.');
    Object.assign(task, patch); this.persist();
  }

  complete(id: string, patch: Pick<Task, 'status' | 'output' | 'error'>): void {
    const task = this.task(id);
    if (!task) throw new Error('Unknown task.');
    const result = { ...task, ...patch, finishedAt: new Date().toISOString() };
    this.write(join(this.directory, 'artifacts', `${id}.json`), result);
    if (patch.status === 'completed') {
      this.write(join(this.directory, 'memory', 'latest.json'), {
        taskId: id, recordedAt: result.finishedAt, summary: patch.output.slice(0, 8000),
      });
    }
    this.update(id, result);
  }

  memory(): string {
    const filename = join(this.directory, 'memory', 'latest.json');
    if (!existsSync(filename)) return '';
    const memory = record(JSON.parse(readFileSync(filename, 'utf8')));
    return typeof memory.summary === 'string' ? memory.summary.slice(0, 8000) : '';
  }
}
