import type { RpcClient } from '../../../experiments/codex-specialists/src/app-server-client.ts';
import { record, type JsonRecord, type Notification } from '../../../experiments/codex-specialists/src/protocol.ts';
import { SCRATCH_PROFILE } from '../../../experiments/codex-specialists/src/task-scratch.ts';

export class WorkAgentModel implements RpcClient {
  calls: { method: string; params: JsonRecord }[] = [];
  readonly history = { sequence: 0, turns: new Map<string, JsonRecord>(), directories: new Map<string, string>() };
  private listeners = new Set<(event: Notification) => void>();
  private failures = new Set<(error: Error) => void>();
  private handler: ((params: JsonRecord) => Promise<JsonRecord>) | undefined;
  emit(method: string, item: JsonRecord) {
    const active = this.calls.filter(call => call.method === 'turn/start').at(-1)!;
    for (const listener of this.listeners) listener({ method, params: { threadId: active.params.threadId, turnId: `turn-${this.history.sequence}`, item } });
  }
  deliver = true;
  acknowledgeFirst = false;
  onTurn: (call: (name: string, input: JsonRecord) => Promise<JsonRecord>) => Promise<string> = async () => 'No work submitted';
  handleTools(handler: (params: JsonRecord) => Promise<JsonRecord>) { this.handler = handler; }
  subscribe(listener: (event: Notification) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  onFailure(listener: (error: Error) => void) { this.failures.add(listener); return () => { this.failures.delete(listener); }; }
  disconnect() { for (const listener of this.failures) listener(new Error('Lost work completion notification')); }
  async request(method: string, params: JsonRecord): Promise<JsonRecord> {
    this.calls.push({ method, params });
    if (method === 'account/read') return { account: { type: 'chatgpt' } };
    if (method === 'thread/start' || method === 'thread/resume') {
      const id = method === 'thread/start' ? `thread-${++this.history.sequence}` : String(params.threadId);
      this.history.directories.set(id, String(params.cwd));
      return { thread: { id }, ...(params.permissions === SCRATCH_PROFILE ? {
        activePermissionProfile: { id: SCRATCH_PROFILE }, sandbox: { type: 'workspaceWrite',
          writableRoots: [record(record(params.config)['shell_environment_policy.set']).TMPDIR], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true },
      } : {}) };
    }
    if (method === 'thread/read') return { thread: { id: params.threadId, cwd: this.history.directories.get(String(params.threadId)), turns: [this.history.turns.get(String(params.threadId))] } };
    if (method === 'thread/unsubscribe' || method === 'thread/inject_items') return {};
    if (method === 'turn/start') {
      const id = `turn-${++this.history.sequence}`;
      const run = async () => {
        const text = await this.onTurn((tool, args) => this.handler!({ threadId: params.threadId, turnId: id, tool, arguments: args }));
        const turn = { id, status: 'completed', items: [{ id: 'reply', type: 'agentMessage', text }], error: null };
        this.history.turns.set(String(params.threadId), turn);
        if (this.deliver) for (const listener of this.listeners) listener({ method: 'turn/completed', params: { threadId: params.threadId, turn } });
      };
      if (this.acknowledgeFirst) setImmediate(() => { void run().catch(error => { for (const listener of this.failures) listener(error); }); });
      else await run();
      return { turn: { id } };
    }
    throw new Error(`Unexpected ${method}`);
  }
}
