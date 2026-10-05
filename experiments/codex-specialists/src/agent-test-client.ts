import type { RpcClient } from './app-server-client.ts';
import { createDeferred, record, type JsonRecord, type Notification } from './protocol.ts';
import { SCRATCH_PROFILE } from './task-scratch.ts';

export class FakeClient implements RpcClient {
  readonly calls: { method: string; params: JsonRecord }[] = [];
  readonly started = createDeferred<void>();
  toolHandler: ((params: JsonRecord) => Promise<JsonRecord>) | undefined;
  handleTools(handler: (params: JsonRecord) => Promise<JsonRecord>) { this.toolHandler = handler; }
  private readonly listeners = new Set<(event: Notification) => void>();
  private readonly failures = new Set<(error: Error) => void>();
  account: unknown = { type: 'chatgpt' };
  resumeId = 'thread';
  threadPath: string | undefined;
  onRead: () => Promise<JsonRecord> = async () => ({ thread: { id: 'thread', cwd: '/workspace', turns: [{ id: 'turn', status: 'completed', items: [{ type: 'agentMessage', text: 'Recovered result' }] }] } });
  onCommandList: () => Promise<JsonRecord> = async () => ({ data: [], nextCursor: null });
  onCommandTerminate: () => Promise<JsonRecord> = async () => ({ terminated: true });
  onInject: (params: JsonRecord) => Promise<JsonRecord> = async () => ({});
  onUnsubscribe: () => Promise<JsonRecord> = async () => ({ status: 'unsubscribed' });
  onStart: (params: JsonRecord) => Promise<JsonRecord> = async () => {
    this.complete(); return { turn: { id: 'turn' } };
  };
  onInterrupt: () => Promise<JsonRecord> = async () => {
    this.complete('interrupted'); return {};
  };

  async request(method: string, params: JsonRecord): Promise<JsonRecord> {
    this.calls.push({ method, params });
    if (method === 'account/read') return { account: this.account };
    if (method === 'thread/start' || method === 'thread/resume') {
      const scratch = params.permissions === SCRATCH_PROFILE
        ? { activePermissionProfile: { id: SCRATCH_PROFILE }, sandbox: { type: 'workspaceWrite',
          writableRoots: [record(record(params.config)['shell_environment_policy.set']).TMPDIR],
          networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true } } : {};
      return { thread: { id: method === 'thread/start' ? 'thread' : this.resumeId, path: this.threadPath }, model: 'test-model', ...scratch };
    }
    if (method === 'thread/backgroundTerminals/list') return this.onCommandList();
    if (method === 'thread/backgroundTerminals/terminate') return this.onCommandTerminate();
    if (method === 'thread/read') return this.onRead();
    if (method === 'thread/unsubscribe') return this.onUnsubscribe();
    if (method === 'thread/inject_items') return await this.onInject(params);
    if (method === 'turn/start') { this.started.resolve(); return await this.onStart(params); }
    if (method === 'turn/interrupt') return await this.onInterrupt();
    throw new Error(`Unexpected request: ${method}`);
  }
  subscribe(listener: (event: Notification) => void): () => void {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  onFailure(listener: (error: Error) => void): () => void {
    this.failures.add(listener); return () => { this.failures.delete(listener); };
  }
  emit(event: Notification): void { for (const listener of this.listeners) listener(event); }
  disconnect(): void { for (const listener of this.failures) listener(new Error('transport lost')); }
  complete(status = 'completed', text = 'verification result'): void {
    const event = { method: 'turn/completed', params: { threadId: 'thread', turn: {
      id: 'turn', status, items: [{ id: 'answer', type: 'agentMessage', text }], error: null,
    } } };
    for (const listener of this.listeners) listener(event);
  }
}
