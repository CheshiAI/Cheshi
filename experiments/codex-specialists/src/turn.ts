import { createDeferred, record, type JsonRecord, type Notification } from './protocol.ts';

export type TurnResult = { status: 'completed' | 'interrupted' | 'failed'; output: string; error: string | null };

/** Subscribe before turn/start; completion can precede its acknowledgement. */
export class TurnObserver {
  private readonly deferred = createDeferred<TurnResult>();
  readonly result = this.deferred.promise;
  private target: { threadId: string; turnId: string } | null = null;
  private readonly buffered: Notification[] = [];
  private readonly messages = new Map<string, string>();
  private settled = false;

  private readonly observeItem: ((method: string, item: JsonRecord) => void) | undefined;
  constructor(observeItem?: (method: string, item: JsonRecord) => void) { this.observeItem = observeItem; void this.result.catch(() => {}); }

  get finished(): boolean { return this.settled; }

  identify(threadId: string, turnId: string): void {
    this.target = { threadId, turnId };
    for (const event of this.buffered) this.consume(event);
    this.buffered.length = 0;
  }

  receive(event: Notification): void {
    if (this.settled || !['item/started', 'item/completed', 'turn/completed'].includes(event.method)) return;
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

  private consume(event: Notification): void {
    if (!this.target || this.settled || event.params.threadId !== this.target.threadId) return;
    if (event.method === 'item/completed' || event.method === 'item/started') {
      if (event.params.turnId === this.target.turnId) {
        try { this.observeItem?.(event.method, record(event.params.item)); }
        catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); return; }
        if (event.method === 'item/completed') this.message(event.params.item);
      }
      return;
    }
    const turn = record(event.params.turn);
    if (turn.id !== this.target.turnId) return;
    if (Array.isArray(turn.items)) turn.items.forEach(item => this.message(item));
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
