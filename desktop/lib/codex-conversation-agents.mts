import { resolve } from 'node:path';
import { historySourceKinds, type ConversationLocation } from './codex-conversation-catalog.mts';
import type { JsonObject } from './codex-chat-types.mts';
import { recordValue, stringValue } from './codex-service-utils.mts';

interface AgentLocation extends ConversationLocation { rootId: string; parentId: string | null }
interface Options {
  cwd: string;
  owner(threadId: string): Promise<ConversationLocation>;
  request(profileId: string, method: string, params?: unknown): Promise<unknown>;
  activeProfileId(): string;
}

function threadValue(value: unknown, expectedId: string): JsonObject {
  const thread = recordValue(recordValue(value)?.thread);
  if (!thread || thread.id !== expectedId) throw new Error('The agent history returned an invalid thread identifier.');
  return thread;
}

/** Agent trees remain in their original account even when the main history is handed off. */
export class CodexConversationAgents {
  private readonly options: Options;
  private readonly locations = new Map<string, AgentLocation>();

  constructor(options: Options) { this.options = options; }

  private async locate(id: string): Promise<AgentLocation> {
    const known = this.locations.get(id);
    if (known) return known;
    const owner = await this.options.owner(id);
    return { ...owner, rootId: owner.threadId, parentId: null };
  }

  async read(id: string, method: 'thread/read' | 'thread/goal/get', params?: JsonObject): Promise<unknown> {
    const owner = await this.locate(id);
    if (method !== 'thread/read' && method !== 'thread/goal/get') throw new Error('Unsupported agent history operation.');
    const response = await this.options.request(owner.profileId, method, { ...params, threadId: owner.threadId });
    if (method === 'thread/read') {
      const thread = threadValue(response, owner.threadId);
      if (stringValue(thread.parentThreadId) !== owner.parentId) throw new Error('The agent history changed its parent conversation.');
      if (!owner.parentId && (typeof thread.cwd !== 'string' || resolve(thread.cwd) !== resolve(this.options.cwd))) {
        throw new Error('The agent conversation belongs to another workspace.');
      }
      this.locations.set(owner.threadId, owner);
    }
    return response;
  }

  async descendants(rootId: string): Promise<JsonObject[]> {
    const owner = await this.locate(rootId);
    if (owner.parentId) throw new Error('Select the main conversation to list its descendants.');
    // Establish the root before trusting any account-supplied descendant IDs.
    await this.read(owner.threadId, 'thread/read', { includeTurns: false });
    const threads = new Map<string, JsonObject>();
    let cursor: string | null = null;
    const cursors = new Set<string>();
    do {
      const page = recordValue(await this.options.request(owner.profileId, 'thread/list', {
        ancestorThreadId: owner.threadId, limit: 100, sortKey: 'created_at', sortDirection: 'asc',
        modelProviders: [], sourceKinds: historySourceKinds, ...(cursor ? { cursor } : {}),
      }));
      if (!page || !Array.isArray(page.data) || (page.nextCursor != null && typeof page.nextCursor !== 'string')) {
        throw new Error('The agent history returned an invalid page.');
      }
      for (const value of page.data) {
        const thread = recordValue(value);
        const id = stringValue(thread?.id);
        if (!thread || !id) throw new Error('The agent history contains an invalid thread.');
        if (id !== owner.threadId) threads.set(id, thread);
      }
      cursor = stringValue(page.nextCursor);
      if (cursor && cursors.has(cursor)) throw new Error('The agent history repeated a page cursor.');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    for (const id of threads.keys()) {
      let current = id;
      const seen = new Set<string>();
      while (current !== owner.threadId) {
        if (seen.has(current)) throw new Error('The agent history contains a parent cycle.');
        seen.add(current);
        const parent = stringValue(threads.get(current)?.parentThreadId);
        if (!parent || (parent !== owner.threadId && !threads.has(parent))) {
          throw new Error('The agent history contains a thread outside the selected conversation.');
        }
        current = parent;
      }
    }
    for (const [id, thread] of threads) this.locations.set(id, {
      profileId: owner.profileId, threadId: id, rootId: owner.threadId, parentId: stringValue(thread.parentThreadId),
    });
    return [...threads.values()];
  }

  assertWritable(id: string): void {
    const owner = this.locations.get(id);
    if (!owner || owner.profileId !== this.options.activeProfileId()) {
      throw new Error('This agent is stored in another account. Return to the main conversation and select its original account before sending to the agent.');
    }
  }
}
