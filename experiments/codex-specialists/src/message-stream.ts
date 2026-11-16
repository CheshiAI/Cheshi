import { ACTIVITY_LIMIT, TEXT_LIMIT } from './activity-contract.ts';
import type { JsonRecord } from './protocol.ts';

export const MESSAGE_STREAM_INTERVAL_MS = 200;

/** Bounded, coalesced public text; final native items remain authoritative. */
export class MessageStream {
  private readonly items = new Map<string, JsonRecord>();
  private readonly dirty = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly publish: (item: JsonRecord) => void;
  private readonly failed: (error: Error) => void;

  constructor(publish: (item: JsonRecord) => void, failed: (error: Error) => void) {
    this.publish = publish; this.failed = failed;
  }

  start(item: JsonRecord) {
    if (item.type !== 'agentMessage' || typeof item.id !== 'string' || this.items.has(item.id)
      || this.items.size >= ACTIVITY_LIMIT) return;
    if (item.phase != null && !['commentary', 'final_answer'].includes(String(item.phase))) return;
    this.items.set(item.id, { id: item.id, type: 'agentMessage', phase: item.phase,
      text: typeof item.text === 'string' ? item.text.slice(0, TEXT_LIMIT + 1) : '' });
  }

  delta(id: string, delta: string) {
    const item = this.items.get(id);
    if (!item || !delta) return;
    const text = (String(item.text) + delta).slice(0, TEXT_LIMIT + 1);
    if (text === item.text) return;
    item.text = text; this.dirty.add(id);
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      try { this.flush(); } catch (error) { this.failed(error instanceof Error ? error : new Error(String(error))); }
    }, MESSAGE_STREAM_INTERVAL_MS);
  }

  complete(id: string) {
    this.items.delete(id); this.dirty.delete(id);
    if (!this.dirty.size) this.cancelTimer();
  }

  private flush() {
    const ids = [...this.dirty]; this.dirty.clear();
    for (const id of ids) {
      const item = this.items.get(id);
      if (item?.text) this.publish({ ...item, status: 'inProgress' });
    }
  }

  finish() {
    this.cancelTimer();
    const items = [...this.items.values()]; this.items.clear(); this.dirty.clear();
    // A missing completion must never turn partial text into a successful answer.
    for (const item of items) if (item.text) this.publish({ ...item, status: 'unknown' });
  }

  dispose() { this.cancelTimer(); this.items.clear(); this.dirty.clear(); }
  private cancelTimer() { clearTimeout(this.timer); this.timer = undefined; }
}
