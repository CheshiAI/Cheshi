import { open } from 'node:fs/promises';
import { parseTokenTotals, type TokenTotals } from './usage-contract.ts';
import { record } from './protocol.ts';

const MAX_BYTES = 64 * 1024 * 1024;
type ResponseUsage = { modelCalls: number; tokens: TokenTotals };

/** Read only the path supplied by native thread/start or resume, never model input.
 * Missing, partial, oversized or incompatible telemetry is unknown, not zero.
 */
export async function readNativeTurnUsage(path: string | undefined, threadId: string, turnId: string): Promise<ResponseUsage | null> {
  if (!path?.endsWith('.jsonl')) return null;
  try {
    const file = await open(path, 'r');
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_BYTES) return null;
      const buffer = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
        if (!bytesRead) return null;
        offset += bytesRead;
      }
      return nativeTurnUsage(buffer.toString('utf8'), threadId, turnId);
    } finally { await file.close(); }
  } catch { return null; }
}

export function nativeTurnUsage(text: string, threadId: string, turnId: string): ResponseUsage | null {
  try {
    const responses = new Map<string, TokenTotals>();
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const row = record(JSON.parse(line));
      if (row.type !== 'token_usage_record') continue;
      const p = record(row.payload);
      if (p.thread_id !== threadId || p.turn_id !== turnId) continue;
      if (typeof p.response_id !== 'string' || !p.response_id) return null;
      const u = record(p.usage);
      const tokens = parseTokenTotals({ inputTokens: u.input_tokens, cachedInputTokens: u.cached_input_tokens,
        outputTokens: u.output_tokens, totalTokens: u.total_tokens });
      const previous = responses.get(p.response_id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(tokens)) return null;
      responses.set(p.response_id, tokens);
    }
    if (!responses.size) return null;
    const tokens = [...responses.values()].reduce<TokenTotals>((total, next) => ({
      inputTokens: total.inputTokens + next.inputTokens, outputTokens: total.outputTokens + next.outputTokens,
      totalTokens: total.totalTokens + next.totalTokens,
      cachedInputTokens: total.cachedInputTokens === null || next.cachedInputTokens === null ? null : total.cachedInputTokens + next.cachedInputTokens,
    }), { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0 });
    return { modelCalls: responses.size, tokens: parseTokenTotals(tokens) };
  } catch { return null; }
}
