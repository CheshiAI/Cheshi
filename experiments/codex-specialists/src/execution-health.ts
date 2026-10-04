import type { RpcClient } from './app-server-client.ts';
import { record, type Notification } from './protocol.ts';

const CHECK_INTERVAL_MS = 120_000;
const CHECK_RESPONSE_MS = 30_000;
type Activity = 'starting' | 'model' | 'tool' | 'stopping';

/** Observations only: a quiet model or failed probe never cancels or replays work. */
export class ExecutionHealth {
  private readonly taskId: string;
  private readonly now: () => number;
  private readonly startedAt: string;
  private lastActivityAt: string;
  private lastActivity: Activity = 'starting';
  private checkedAt: string | null = null;
  private lastResponsiveAt: string | null = null;
  private checkStartedAt: number | null = null;
  private nextCheckAt = 0;
  private checking: Promise<void> | null = null;
  private engineStatus: 'checking' | 'responding' | 'unconfirmed' = 'checking';

  constructor(taskId: string, now: () => number = Date.now) {
    this.taskId = taskId; this.now = now;
    this.startedAt = this.lastActivityAt = new Date(now()).toISOString();
  }

  activity(kind: Activity): void {
    this.lastActivity = kind; this.lastActivityAt = new Date(this.now()).toISOString();
  }

  receive(event: Notification, threadId: string | null, turnId: string | null): void {
    if (!threadId || !turnId || event.params.threadId !== threadId) return;
    const id = event.method === 'turn/completed' ? record(event.params.turn).id : event.params.turnId;
    if (id !== turnId) return;
    if (event.method.startsWith('item/') || event.method === 'thread/tokenUsage/updated' || event.method === 'turn/completed') {
      this.activity(event.method.startsWith('item/commandExecution/') || event.method.startsWith('item/fileChange/')
        || (['item/started', 'item/completed'].includes(event.method)
          && ['commandExecution', 'fileChange', 'dynamicToolCall', 'mcpToolCall'].includes(String(record(event.params.item).type))) ? 'tool' : 'model');
    }
  }

  check(client: RpcClient, threadId: string | null): Promise<void> {
    if (this.checking) return this.checking;
    if (!threadId || this.now() < this.nextCheckAt) return Promise.resolve();
    this.checkStartedAt = this.now();
    this.nextCheckAt = this.checkStartedAt + CHECK_INTERVAL_MS;
    this.checking = (async () => {
      try {
        // Metadata only; no model invocation or repeated transcript download.
        const response = await client.request('thread/read', { threadId, includeTurns: false });
        if (record(response.thread).id !== threadId) throw new Error('Unexpected thread.');
        this.engineStatus = 'responding';
        this.lastResponsiveAt = new Date(this.now()).toISOString();
      } catch { this.engineStatus = 'unconfirmed'; }
      finally { this.checkedAt = new Date(this.now()).toISOString(); }
    })().finally(() => { this.checking = null; });
    return this.checking;
  }

  snapshot() {
    return { taskId: this.taskId, startedAt: this.startedAt, lastActivityAt: this.lastActivityAt, lastActivity: this.lastActivity,
      checkedAt: this.checkedAt, lastResponsiveAt: this.lastResponsiveAt,
      engineStatus: this.checking && this.checkStartedAt !== null && this.now() - this.checkStartedAt >= CHECK_RESPONSE_MS
        ? 'unconfirmed' as const : this.engineStatus };
  }
}
