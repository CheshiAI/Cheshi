import { parseUsage, type GoalUsage } from './goal-progress.ts';
import { parseTokenTotals, type TokenTotals } from './usage-contract.ts';
import { createDeferred, record, type JsonRecord, type Notification } from './protocol.ts';

export type TurnResult = { status: 'completed' | 'interrupted' | 'failed'; output: string; error: string | null };

/** Subscribe before turn/start; completion can precede its acknowledgement. */
export class TurnObserver {
  private readonly deferred = createDeferred<TurnResult>();
  readonly result = this.deferred.promise;
  private target: { threadId: string; turnId: string } | null = null;
  private readonly buffered: Notification[] = [];
  private readonly messages = new Map<string, string>();
  private readonly completedItems = new Set<string>();
  private settled = false;
  usage: Omit<GoalUsage, 'reportedThroughTurn'> | null = null;
  threadTotals: TokenTotals | null = null;

  private readonly observeItem: ((method: string, item: JsonRecord, turnId: string) => void) | undefined;
  private readonly observeUsage: ((totals: TokenTotals, threadId: string, turnId: string) => void) | undefined;
  constructor(observeItem?: (method: string, item: JsonRecord, turnId: string) => void,
    observeUsage?: (totals: TokenTotals, threadId: string, turnId: string) => void) {
    this.observeItem = observeItem; this.observeUsage = observeUsage; void this.result.catch(() => {});
  }

  get finished(): boolean { return this.settled; }

  identify(threadId: string, turnId: string): void {
    this.target = { threadId, turnId };
    for (const event of this.buffered) this.consume(event);
    this.buffered.length = 0;
  }

  receive(event: Notification): void {
    if (this.settled || !['item/started', 'item/completed', 'turn/completed', 'thread/tokenUsage/updated'].includes(event.method)) return;
    if (!this.target) { this.buffered.push(event); return; }
    this.consume(event);
  }

  fail(error: Error): void {
    if (this.settled) return;
    this.settled = true;
    this.deferred.reject(error);
  }

  private message(value: unknown): void {
    const item = record(value);
    if (item.type !== 'agentMessage' || (item.phase != null && item.phase !== 'final_answer')) return;
    if (typeof item.id === 'string' && typeof item.text === 'string') this.messages.set(item.id, item.text);
  }

  private observe(method: string, item: JsonRecord) {
    if (!this.target) return;
    if (typeof item.id === 'string' && method === 'item/completed') {
      if (this.completedItems.has(item.id)) return;
      this.completedItems.add(item.id);
    }
    this.observeItem?.(method, item, this.target.turnId);
  }

  private consume(event: Notification): void {
    if (!this.target || this.settled || event.params.threadId !== this.target.threadId) return;
    if (event.method === 'thread/tokenUsage/updated') {
      if (event.params.turnId !== this.target.turnId) return;
      try {
        const total = record(record(event.params.tokenUsage).total);
        const { inputTokens, outputTokens, totalTokens } = parseUsage({ ...total, reportedThroughTurn: 1 });
        const totals = parseTokenTotals(total);
        if (this.usage && (inputTokens < this.usage.inputTokens || outputTokens < this.usage.outputTokens || totalTokens < this.usage.totalTokens)) return;
        // Goal tasks own separate native conversations. Keep the latest thread total;
        // neither sum cumulative notifications nor mistake the last model call for a whole turn.
        this.usage = { inputTokens, outputTokens, totalTokens };
        this.threadTotals = totals;
      } catch { /* Missing usage stays unknown. */ }
      if (this.threadTotals) {
        try { this.observeUsage?.(this.threadTotals, this.target.threadId, this.target.turnId); }
        catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
      }
      return;
    }
    if (event.method === 'item/completed' || event.method === 'item/started') {
      if (event.params.turnId === this.target.turnId) {
        try { this.observe(event.method, record(event.params.item)); }
        catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); return; }
        if (event.method === 'item/completed') this.message(event.params.item);
      }
      return;
    }
    const turn = record(event.params.turn);
    if (turn.id !== this.target.turnId) return;
    if (Array.isArray(turn.items)) {
      try { for (const item of turn.items) { this.observe('item/completed', record(item)); this.message(item); } }
      catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); return; }
    }
    const status = turn.status;
    if (!['completed', 'interrupted', 'failed'].includes(String(status))) {
      this.fail(new Error('Invalid terminal turn status.')); return;
    }
    const error = turn.error == null ? null : record(turn.error);
    this.settled = true;
    this.deferred.resolve({
      status: status as TurnResult['status'], output: [...this.messages.values()].join('\n\n'),
      error: typeof error?.message === 'string' ? error.message : null,
    });
  }
}
