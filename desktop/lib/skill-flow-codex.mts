import { randomUUID } from 'node:crypto';
import type { CodexChatClient } from './codex-chat-types.mts';
import { EphemeralSessionService } from './ephemeral-session-service.mts';
import { recordValue } from './codex-service-utils.mts';

export const SKILL_FLOW_LUNA_MODEL = 'gpt-5.6-luna';
export interface SkillFlowCodexRequest {
  instructions: string;
  input: string;
  schema: unknown;
  research?: boolean;
}
export interface SkillFlowCodexResult {
  text: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  elapsedMs: number;
  webSearches: number;
}
export type SkillFlowCodex = (request: SkillFlowCodexRequest, signal?: AbortSignal) => Promise<SkillFlowCodexResult>;

function tokens(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Each call owns an in-memory subscription session and closes its transport. */
export function createSkillFlowCodex(options: {
  cwd: string;
  createClient(): CodexChatClient & { stop(): Promise<void> };
  timeoutMs?: number;
  onUsage?(usage: Omit<SkillFlowCodexResult, 'text'>): void;
}): SkillFlowCodex {
  return async (request, signal) => {
    signal?.throwIfAborted();
    const client = options.createClient();
    const session = new EphemeralSessionService(client, options.cwd, options.timeoutMs ?? 120_000);
    const started = performance.now();
    const observed: { usage: Record<string, unknown> | null } = { usage: null };
    let requested = false, webSearches = 0;
    const metadata = () => ({ model: SKILL_FLOW_LUNA_MODEL,
      inputTokens: tokens(observed.usage?.inputTokens), outputTokens: tokens(observed.usage?.outputTokens),
      elapsedMs: Math.round((performance.now() - started) * 100) / 100, webSearches });
    try {
      const result = await session.run({ requestId: randomUUID(), model: SKILL_FLOW_LUNA_MODEL, effort: 'low',
        instructions: request.instructions, input: request.input }, {
        signal, outputSchema: request.schema, serviceTier: 'default', requireSubscription: true,
        disableTools: request.research !== true, webSearchOnly: request.research === true,
        onWebSearch: () => { webSearches++; }, onTurnRequested: () => { requested = true; },
        onUsage: value => { observed.usage = recordValue(recordValue(value)?.total); },
      });
      return { ...metadata(), text: result.text };
    } finally {
      if (requested) options.onUsage?.(metadata());
      session.stop();
      await client.stop();
    }
  };
}
