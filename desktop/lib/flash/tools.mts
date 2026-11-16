import type { JsonObject } from '../codex-chat-types.mts';
import { recordValue } from '../codex-service-utils.mts';
import { FlashError, flashProviderDetails } from './client.mts';
import type { SessionMemory } from './session-memory.mts';

import { flashTools, flashInstructions, memoryArguments, MemoryArgumentError } from '../../../experiments/codex-specialists/src/flash-tools.ts';
export { flashTools, flashInstructions, memoryArguments };

interface Owner {
  client: { respond(id: string | number, value: unknown): Promise<void> };
  activeTurns: Map<string, { turnId: string | null; interruptRequested: boolean }>;
}
/** Bind dynamic calls to this pane's live turn; a tool argument cannot select its account. */
export class FlashToolRequests {
  private readonly owner: Owner;
  private readonly memory: SessionMemory;
  private readonly pending = new Map<AbortController, string>();
  private readonly seen = new Map<object, Set<string>>();
  constructor(owner: Owner, memory: SessionMemory) { this.owner = owner; this.memory = memory; }

  cancel(thread?: string): void {
    for (const [controller, id] of this.pending) if (thread === undefined || thread === id) controller.abort();
    if (thread === undefined) this.seen.clear();
  }

  handle(request: JsonObject): boolean {
    const params = recordValue(request.params);
    if (request.method !== 'item/tool/call' || !['memory_search', 'memory_read'].includes(String(params?.tool))) return false;
    const id = request.id;
    if (typeof id !== 'string' && typeof id !== 'number') return true;
    const client = this.owner.client;
    const reply = async (success: boolean, result: unknown) => {
      await client.respond(id, { success, contentItems: [{ type: 'inputText', text: JSON.stringify(result) }] }).catch(() => {});
    };
    const thread = typeof params?.threadId === 'string' ? params.threadId : '';
    const turn = this.owner.activeTurns.get(thread);
    if (!params || params.namespace != null || !turn || turn.interruptRequested || typeof params.turnId !== 'string'
      || (turn.turnId !== null && turn.turnId !== params.turnId) || typeof params.callId !== 'string') {
      void reply(false, { code: 'invalid_request', error: 'Memory is not available for this turn.' }); return true;
    }
    for (const key of this.seen.keys()) if (![...this.owner.activeTurns.values()].includes(key as typeof turn)) this.seen.delete(key);
    const seen = this.seen.get(turn) ?? new Set<string>();
    if (seen.has(params.callId) || seen.size >= 500 || this.pending.size >= 8) {
      void reply(false, { code: 'busy', error: 'Duplicate or excessive memory calls. Retry after the pending call.' }); return true;
    }
    seen.add(params.callId); this.seen.set(turn, seen);
    const controller = new AbortController();
    this.pending.set(controller, thread);
    void (async () => {
      try {
        const result = await this.memory.execute(String(params.tool), memoryArguments(String(params.tool), params.arguments), thread, controller.signal, params.turnId as string);
        controller.signal.throwIfAborted();
        if (turn.interruptRequested || this.owner.activeTurns.get(thread) !== turn) throw new FlashError('canceled', 'Turn ended');
        await reply(true, result);
      } catch (error) {
        const code = error instanceof MemoryArgumentError ? 'invalid_request' : error instanceof FlashError ? error.code : controller.signal.aborted ? 'canceled' : 'unavailable';
        await reply(false, { code, ...flashProviderDetails(error, controller.signal), error: code === 'disabled' ? 'Flash is off. Enable it in Settings > Flash to use memory.' : error instanceof MemoryArgumentError ? error.message : code === 'turns_too_large' ? 'Selected turns exceed the summary budget. Select fewer turns; no original text was truncated.' : code === 'invalid_summary' ? 'The memory summary failed source validation. Retry the read; do not use it as evidence.' : code === 'sync_timeout'
          ? 'Session memory is still synchronizing after waiting. Retry when Flash is ready; this does not mean no matches were found.'
          : 'Session memory could not complete. Check the local Flash service or retry.' });
      } finally { this.pending.delete(controller); }
    })();
    return true;
  }
}
