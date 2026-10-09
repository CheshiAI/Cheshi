import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import type { RpcClient } from './app-server-client.ts';
import type { AgentStore } from './store.ts';
import { assertApplicationRecords, readApplicationRecords } from './application-storage.ts';
import { questionClosed } from './question-control.ts';
import { record } from './protocol.ts';

export class WorkerSleepingError extends Error {}

/** Admission gate, not a task timeout. A lost prepare response releases its lease. */
export class IdleLifecycle {
  private active = 0;
  private lease: { id: string; until: number; committed: boolean } | null = null;
  constructor(options: {
    store: AgentStore; client: RpcClient; blocked(): boolean; now?(): number;
  }) { this.options = options; }
  private readonly options: { store: AgentStore; client: RpcClient; blocked(): boolean; now?(): number };
  private now() { return this.options.now?.() ?? Date.now(); }
  get draining(): boolean {
    if (this.lease && !this.lease.committed && this.now() >= this.lease.until) this.lease = null;
    return this.lease !== null;
  }
  enter(): () => void {
    if (this.draining) throw new WorkerSleepingError('Worker is preparing to sleep. Retry after waking it.');
    this.active++;
    return () => { this.active--; };
  }
  probe() {
    const s = this.options.store.snapshot(), c = s.collaboration;
    const deadlines = c.outgoing.filter(q => q.kind === 'question' && !questionClosed(c, q.id)
      && !c.incoming.some(m => m.kind === 'reply' && m.questionId === q.id))
      .flatMap(q => c.questionDeadlines?.[q.id] ? [Date.parse(c.questionDeadlines[q.id]!)] : []);
    const nextWakeAt = deadlines.length ? Math.min(...deadlines) : null;
    const idle = !this.active && !this.options.blocked()
      && !s.tasks.some(t => ['accepted', 'running', 'unknown'].includes(t.status)
        || (t.status === 'waiting' && (t.goal?.phase === 'ready' || t.dialogue?.intakeRecovery === 'queued'))
        || (t.dialogue?.route && !t.dialogue.route.delivered && !t.dialogue.route.held))
      && c.outgoing.every(m => c.acknowledged.includes(m.id))
      && (nextWakeAt === null || nextWakeAt > this.now());
    return { protocol: 1 as const, idle, nextWakeAt };
  }
  private async assertQuiescent() {
    if (!this.probe().idle) throw new Error('Worker has unfinished work.');
    const { store, client } = this.options;
    assertApplicationRecords(readApplicationRecords(fs, store.directory));
    // Inspect the app-server's live sessions, including sessions outside the last turn.
    // Persisted, unloaded threads cannot own running terminals in this process.
    const threads = new Set<string>(), cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const page = await client.request('thread/loaded/list', { limit: 100, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(page.data) || page.data.some(id => typeof id !== 'string' || !id)
        || !(page.nextCursor === null || typeof page.nextCursor === 'string' && !!page.nextCursor)) throw new Error('Invalid live thread inventory.');
      for (const id of page.data as string[]) threads.add(id);
      cursor = page.nextCursor as string | null;
      if (cursor && cursors.has(cursor) || threads.size > 10000) throw new Error('Invalid live thread pagination.');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    for (const threadId of threads) {
      const page = await client.request('thread/backgroundTerminals/list', { threadId, limit: 1 });
      if (!Array.isArray(page.data) || page.data.length || page.nextCursor !== null) throw new Error('Background command state is not idle.');
    }
    if (!this.probe().idle) throw new Error('Worker became busy during sleep preparation.');
  }
  private assertLease(lease: NonNullable<IdleLifecycle['lease']>) {
    if (!this.draining || this.lease !== lease) throw new Error('Sleep preparation expired.');
  }
  async prepare() {
    if (this.draining) throw new Error('Sleep preparation is already in progress.');
    this.lease = { id: randomUUID(), until: this.now() + 60_000, committed: false };
    const lease = this.lease;
    try {
      await this.assertQuiescent();
      this.assertLease(lease);
      return { ...this.probe(), lease: lease.id };
    } catch (error) { if (this.lease === lease) this.lease = null; throw error; }
  }
  cancel() {
    if (this.lease?.committed) throw new Error('Worker shutdown has already committed.');
    this.lease = null;
  }
  async commit(value: unknown) {
    const input = record(value), lease = this.lease;
    if (!this.draining || !lease || lease.id !== input.lease) throw new Error('Invalid sleep lease.');
    await this.assertQuiescent();
    this.assertLease(lease);
    lease.committed = true;
  }
}
