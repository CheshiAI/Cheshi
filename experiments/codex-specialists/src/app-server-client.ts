import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createDeferred, deniedServerRequest, record, type JsonRecord, type Notification } from './protocol.ts';

export interface RpcClient {
  request(method: string, params: JsonRecord): Promise<JsonRecord>;
  subscribe(listener: (event: Notification) => void): () => void;
  onFailure(listener: (error: Error) => void): () => void;
  handleApprovals?(handler: (method: string, params: JsonRecord) => void): void;
  handleTools?(handler: (params: JsonRecord) => Promise<JsonRecord>): void;
}

export class AppServerClient implements RpcClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private failure: Error | null = null;
  private readonly pending = new Map<number, ReturnType<typeof createDeferred<JsonRecord>>>();
  private readonly notifications = new Set<(event: Notification) => void>();
  private readonly failures = new Set<(error: Error) => void>();
  deniedRequests = 0;
  private approvalHandler: ((method: string, params: JsonRecord) => void) | undefined;
  handleApprovals(handler: (method: string, params: JsonRecord) => void): void { this.approvalHandler = handler; }
  private toolHandler: ((params: JsonRecord) => Promise<JsonRecord>) | undefined;
  handleTools(handler: (params: JsonRecord) => Promise<JsonRecord>): void { this.toolHandler = handler; }

  constructor(command = 'codex', env?: NodeJS.ProcessEnv, args = ['app-server', '--listen', 'stdio://', '-c', 'cli_auth_credentials_store="file"']) {
    this.child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'], env,
    });
    // Do not forward diagnostic output: provider diagnostics can contain private data.
    this.child.stderr.resume();
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', line => {
      try { this.receive(record(JSON.parse(line))); }
      catch { this.fail(new Error('Invalid app-server message.')); }
    });
    this.child.stdin.on('error', () => this.fail(new Error('App-server transport closed.')));
    this.child.on('error', () => this.fail(new Error('Could not start Codex app-server.')));
    this.child.on('exit', (code, signal) => this.fail(new Error(`Codex app-server exited (${code ?? signal}).`)));
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      clientInfo: { name: 'cheshi_specialist_experiment', title: 'Cheshi specialist experiment', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    this.send({ method: 'initialized' });
  }

  subscribe(listener: (event: Notification) => void): () => void {
    this.notifications.add(listener);
    return () => { this.notifications.delete(listener); };
  }

  onFailure(listener: (error: Error) => void): () => void {
    this.failures.add(listener);
    if (this.failure) listener(this.failure);
    return () => { this.failures.delete(listener); };
  }

  async request(method: string, params: JsonRecord): Promise<JsonRecord> {
    if (this.failure) throw this.failure;
    const id = ++this.sequence;
    const deferred = createDeferred<JsonRecord>();
    this.pending.set(id, deferred);
    const timeout = setTimeout(() => {
      if (this.pending.delete(id)) deferred.reject(new Error(`App-server request timed out: ${method}`));
    }, 30_000);
    try {
      this.send({ id, method, params });
      return await deferred.promise;
    } finally { clearTimeout(timeout); this.pending.delete(id); }
  }

  private send(value: JsonRecord): void {
    if (this.failure) throw this.failure;
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  private receive(message: JsonRecord): void {
    if (typeof message.method === 'string' && message.id !== undefined) {
      if (message.method === 'item/tool/call' && this.toolHandler) {
        void this.answerTool(message);
        return;
      }
      // A request is never a grant. Record missing capabilities for the host UI,
      // then deny this execution until the user has applied a new worker profile.
      this.approvalHandler?.(message.method, record(message.params ?? {}));
      this.deniedRequests++;
      const result = deniedServerRequest(message.method);
      this.send(result === null
        ? { id: message.id, error: { code: -32601, message: 'This read-only experiment does not support this request.' } }
        : { id: message.id, result });
      return;
    }
    if (typeof message.id === 'number') {
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      if (message.error) {
        const error = record(message.error);
        request.reject(new Error(typeof error.message === 'string' ? error.message : 'App-server request failed.'));
      } else request.resolve(record(message.result));
      return;
    }
    if (typeof message.method === 'string') {
      const event = { method: message.method, params: record(message.params ?? {}) };
      for (const listener of this.notifications) listener(event);
    }
  }

  private async answerTool(message: JsonRecord): Promise<void> {
    let result: JsonRecord;
    try {
      const output = await this.toolHandler!(record(message.params));
      result = { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(output) }] };
    } catch (error) {
      result = { success: false, contentItems: [{ type: 'inputText', text: error instanceof Error ? error.message : 'Tool failed.' }] };
    }
    if (!this.failure) this.send({ id: message.id, result });
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    for (const listener of this.failures) listener(error);
  }

  async close(): Promise<void> {
    if (!this.child.pid || this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exited = new Promise<void>(resolve => this.child.once('exit', () => resolve()));
    this.child.kill('SIGTERM');
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 3000);
    await exited;
    clearTimeout(timer);
  }
}
