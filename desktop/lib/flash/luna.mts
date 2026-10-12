import { ProviderRequestError, retryInference } from '../../../experiments/codex-specialists/src/provider-recovery.ts';
import { randomUUID } from 'node:crypto';
import type { CodexChatClient } from '../codex-chat-types.mts';
import { EphemeralSessionService } from '../ephemeral-session-service.mts';
import { FlashError } from './client.mts';

export type LunaClientFactory = () => CodexChatClient & { stop(): Promise<void> };
export type LunaJson = (instructions: string, input: unknown, schema: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;

/** A fresh tool-free subscription session, with no persistent conversation or project instructions. */
export function createLunaJson(createClient: LunaClientFactory, cwd: string): LunaJson {
  const once: LunaJson = async (instructions, input, schema, signal) => {
    signal.throwIfAborted();
    const serialized = JSON.stringify(input);
    if (serialized.length > 160000) throw new FlashError('input_too_large', 'Flash inference input exceeds its budget.');
    const client = createClient();
    const service = new EphemeralSessionService(client, cwd);
    try {
      const result = await service.run({ requestId: randomUUID(), model: 'gpt-6-luna', effort: 'low',
        instructions, input: serialized }, { signal, requireSubscription: true, disableTools: true,
        minimalContext: true, outputSchema: schema, serviceTier: 'default' });
      try { return JSON.parse(result.text) as unknown; }
      catch { throw new FlashError('invalid_model_json', 'Flash received invalid structured output.'); }
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof FlashError || error instanceof ProviderRequestError) throw error;
      // Provider messages may contain private input. Retain the stage, never raw messages.
      throw new FlashError('model_unavailable', 'Flash model request failed.');
    } finally { service.stop(); await client.stop(); }
  };
  return async (instructions, input, schema, signal) => {
    try { return await retryInference(() => once(instructions, input, schema, signal), signal); }
    catch (error) {
      signal.throwIfAborted();
      if (error instanceof ProviderRequestError) throw new FlashError('model_unavailable', 'Flash model request failed.', error.failure);
      throw error;
    }
  };
}
