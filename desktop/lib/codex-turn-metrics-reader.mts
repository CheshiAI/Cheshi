import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { agentUsageFromRollout } from '../shared/chat-agent-details.ts';
import type { ChatTurnMetrics } from '../shared/chat-turn-metrics.ts';
import { recordValue, stringValue } from './codex-service-utils.mts';

type RecordedMetrics = Omit<ChatTurnMetrics, 'itemIds' | 'agentName'>;
const MAX_LINE_LENGTH = 1024 * 1024;

function milliseconds(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export class TurnMetricsParser {
  readonly turns = new Map<string, RecordedMetrics>();
  private readonly threadId: string;
  private identified = false;

  constructor(threadId: string) { this.threadId = threadId; }

  accept(line: string): void {
    if (line.length > MAX_LINE_LENGTH) return;
    let row: Record<string, unknown> | null;
    try { row = recordValue(JSON.parse(line)); } catch { return; }
    const payload = recordValue(row?.payload);
    if (!payload) return;
    if (row?.type === 'session_meta') {
      this.identified = payload.id === this.threadId;
      if (!this.identified) this.turns.clear();
      return;
    }
    if (!this.identified) return;
    const kind = row?.type;
    if (kind !== 'turn_context' && kind !== 'token_usage_record'
      && !(kind === 'event_msg' && payload.type === 'task_complete')) return;
    const id = stringValue(payload.turn_id);
    if (!id || (kind === 'token_usage_record' && payload.thread_id !== this.threadId)) return;
    const metrics = this.turns.get(id) ?? { turnId: id, model: null, reasoningEffort: null, usage: null, durationMs: null };
    if (kind === 'turn_context') {
      metrics.model = stringValue(payload.model);
      metrics.reasoningEffort = stringValue(payload.effort);
    } else if (kind === 'token_usage_record') {
      // This is the cumulative total for this turn, not the last model request or whole thread.
      const usage = agentUsageFromRollout(payload.turn_token_usage);
      if (usage) metrics.usage = usage;
    } else {
      metrics.durationMs = milliseconds(payload.duration_ms);
      const start = milliseconds(payload.started_at);
      const end = milliseconds(payload.completed_at);
      if (metrics.durationMs === null && start !== null && end !== null && end >= start) metrics.durationMs = (end - start) * 1000;
    }
    this.turns.set(id, metrics);
  }
}

/** A small cache avoids rereading unchanged rollouts across panes; no account credentials are read. */
export class CodexTurnMetricsReader {
  private readonly cache = new Map<string, { key: string; result: Promise<Map<string, RecordedMetrics>> }>();

  async read(thread: Record<string, unknown>): Promise<Map<string, RecordedMetrics>> {
    const id = stringValue(thread.id);
    const path = stringValue(thread.path);
    if (!id || !path || !isAbsolute(path) || !path.endsWith('.jsonl')) return new Map();
    const file = await open(path, 'r').catch(() => null);
    if (!file) return new Map();
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size === 0) return new Map();
      const key = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
      const identity = `${id}:${path}`;
      const existing = this.cache.get(identity);
      if (existing?.key === key) return await existing.result;
      const result = (async () => {
        const parser = new TurnMetricsParser(id);
        const stream = file.createReadStream({ encoding: 'utf8', autoClose: false, start: 0, end: stat.size - 1 });
        let pending = '';
        let oversized = false;
        // JSONL uses LF only; Unicode paragraph separators remain JSON string content.
        for await (const chunk of stream) {
          const text = String(chunk);
          let start = 0;
          for (let end = text.indexOf('\n'); end !== -1; end = text.indexOf('\n', start)) {
            if (!oversized && pending.length + end - start <= MAX_LINE_LENGTH) parser.accept(pending + text.slice(start, end));
            pending = '';
            oversized = false;
            start = end + 1;
          }
          if (!oversized) {
            pending += text.slice(start);
            if (pending.length > MAX_LINE_LENGTH) { pending = ''; oversized = true; }
          }
        }
        // Ignore an unfinished final record; the next stat change triggers another read.
        return parser.turns;
      })();
      this.cache.set(identity, { key, result });
      void result.catch(() => {
        if (this.cache.get(identity)?.result === result) this.cache.delete(identity);
      });
      if (this.cache.size > 4) this.cache.delete(this.cache.keys().next().value!);
      return await result;
    } catch { return new Map(); }
    finally { await file.close(); }
  }
}
