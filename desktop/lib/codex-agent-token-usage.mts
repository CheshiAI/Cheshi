import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { agentUsageFromRollout, normalizeAgentTokenUsage, type AgentTokenUsage } from '../shared/chat-agent-details.ts';
import { recordValue, stringValue } from './codex-service-utils.mts';

const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_CACHE_ENTRIES = 64;

function jsonRecord(line: string) {
  try { return recordValue(JSON.parse(line)); } catch { return null; }
}

/** Read bounded, identity-checked usage snapshots, never sum cumulative notifications. */
export class CodexAgentTokenUsage {
  private readonly live = new Map<string, AgentTokenUsage>();
  private readonly files = new Map<string, { key: string; usage: AgentTokenUsage | null }>();

  capture(value: Record<string, unknown>): void {
    if (value.method !== 'thread/tokenUsage/updated') return;
    const params = recordValue(value.params);
    const id = stringValue(params?.threadId);
    const usage = normalizeAgentTokenUsage(recordValue(params?.tokenUsage)?.total);
    if (!id || !usage) return;
    this.live.delete(id);
    this.live.set(id, usage);
    if (this.live.size > MAX_CACHE_ENTRIES) this.live.delete(this.live.keys().next().value!);
  }

  async read(thread: Record<string, unknown>): Promise<AgentTokenUsage | null> {
    const id = stringValue(thread.id);
    if (!id) return null;
    const live = this.live.get(id) ?? null;
    const latest = (stored: AgentTokenUsage | null) => !stored || (live && live.totalTokens > stored.totalTokens) ? live : stored;
    const path = stringValue(thread.path);
    if (!path || !isAbsolute(path) || !path.endsWith('.jsonl')) return live;
    try {
      const file = await open(path, 'r');
      try {
        const stat = await file.stat();
        if (!stat.isFile()) return live;
        const key = `${path}:${stat.size}:${stat.mtimeMs}`;
        const cached = this.files.get(id);
        if (cached?.key === key) return latest(cached.usage);
        const size = Math.min(stat.size, MAX_RECORD_BYTES);
        const head = Buffer.alloc(size);
        const first = await file.read(head, 0, size, 0);
        const headText = head.subarray(0, first.bytesRead).toString('utf8');
        const newline = headText.indexOf('\n');
        if (newline < 0) return live;
        const metadata = jsonRecord(headText.slice(0, newline));
        if (metadata?.type !== 'session_meta' || recordValue(metadata.payload)?.id !== id) return live;
        let tail = headText;
        if (stat.size > size) {
          const buffer = Buffer.alloc(size);
          const read = await file.read(buffer, 0, size, stat.size - size);
          const partial = buffer.subarray(0, read.bytesRead).toString('utf8');
          tail = partial.slice(partial.indexOf('\n') + 1);
        }
        const lines = tail.split('\n');
        // A writer may still be appending the final record.
        lines.pop();
        let usage: AgentTokenUsage | null = null;
        for (let index = lines.length - 1; index >= 0; index -= 1) {
          const entry = jsonRecord(lines[index]!);
          const payload = recordValue(entry?.payload);
          if (entry?.type !== 'event_msg' || payload?.type !== 'token_count') continue;
          usage = agentUsageFromRollout(recordValue(payload.info)?.total_token_usage);
          if (usage) break;
        }
        this.files.delete(id);
        this.files.set(id, { key, usage });
        if (this.files.size > MAX_CACHE_ENTRIES) this.files.delete(this.files.keys().next().value!);
        return latest(usage);
      } finally { await file.close(); }
    } catch { return live; }
  }

  clear(): void { this.live.clear(); this.files.clear(); }
}
