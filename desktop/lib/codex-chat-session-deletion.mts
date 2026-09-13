import path from 'node:path';
import type { CodexChatContexts } from './codex-chat-contexts.mts';
import type { CodexChatRelays } from './codex-chat-relay.mts';
import type { CodexChatService } from './codex-chat-service.mts';
import type { CodexChatClient, JsonObject } from './codex-chat-types.mts';
import { recordValue, stringValue } from './codex-service-utils.mts';
import { requiredString } from './codex-chat-values.mts';

const deletionSourceKinds = ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'];

function assertDeletionAcknowledged(result: unknown): void {
  if (!recordValue(result)) throw new Error('Codex did not confirm the conversation deletion. Refresh the session list before retrying.');
}

function assertThread(value: unknown): asserts value is JsonObject & { id: string } {
  const thread = recordValue(value);
  if (!thread || !stringValue(thread.id)) throw new Error('Codex returned an invalid session for deletion.');
  if (thread.forkedFromId != null && (!stringValue(thread.forkedFromId) || thread.forkedFromId === thread.id)) {
    throw new Error('Codex returned an invalid fork relationship for deletion.');
  }
  const status = stringValue(recordValue(thread.status)?.type);
  if (!status || !['idle', 'notLoaded', 'systemError'].includes(status)) {
    throw new Error('Stop the session and its agents before deleting it.');
  }
}

type DeletionAccess = { cwd: string; client: Pick<CodexChatClient, 'request'> };
type ConfirmedDeletion = Map<string, string[]>;
type DeletionGroup = { threadIds: string[]; forkedFromIds: string[] };
type DeletionPlan = DeletionGroup & { profileId: string; threadId: string };

const locationKey = (profileId: string, threadId: string) => JSON.stringify([profileId, threadId]);

async function deletionThreads(service: DeletionAccess, threadId: string): Promise<DeletionGroup> {
  const root = recordValue(recordValue(await service.client.request('thread/read', { threadId, includeTurns: false }))?.thread);
  assertThread(root);
  if (root.id !== threadId || typeof root.cwd !== 'string' || !path.isAbsolute(root.cwd) || path.resolve(root.cwd) !== path.resolve(service.cwd)
    || root.parentThreadId != null) throw new Error('Only a conversation in the current workspace can be deleted.');
  const threads = new Map<string, JsonObject>([[threadId, root]]);
  for (const archived of [false, true]) {
    let cursor: string | null = null;
    const seen = new Set<string>();
    do {
      const page = recordValue(await service.client.request('thread/list', {
        ancestorThreadId: threadId, archived, limit: 100, modelProviders: [], sourceKinds: deletionSourceKinds,
        ...(cursor ? { cursor } : {}),
      }));
      if (!page || !Array.isArray(page.data) || (page.nextCursor != null && typeof page.nextCursor !== 'string')) {
        throw new Error('Codex returned an invalid agent list for deletion.');
      }
      for (const candidate of page.data) {
        assertThread(candidate);
        threads.set(candidate.id, candidate);
      }
      cursor = stringValue(page.nextCursor);
      if (cursor && seen.has(cursor)) throw new Error('Codex repeated an agent list cursor.');
      if (cursor) seen.add(cursor);
    } while (cursor);
  }
  for (const id of threads.keys()) {
    const visited = new Set<string>();
    let current = id;
    while (current !== threadId) {
      if (visited.has(current)) throw new Error('Codex returned an invalid agent hierarchy.');
      visited.add(current);
      const parent = stringValue(threads.get(current)?.parentThreadId);
      if (!parent || !threads.has(parent)) throw new Error('Codex returned an unrelated agent for deletion.');
      current = parent;
    }
  }
  return {
    threadIds: [...threads.keys()],
    forkedFromIds: [...new Set([...threads.values()].flatMap(thread => {
      const source = stringValue(thread.forkedFromId);
      return source ? [source] : [];
    }))],
  };
}

/** Each request cascades to subagents; only dependencies between requests need ordering. */
function orderDeletionPlans(plans: Map<string, DeletionPlan>): Array<[string, DeletionPlan]> {
  const owners = new Map<string, string>();
  const dependents = new Map<string, Set<string>>();
  for (const [key, plan] of plans) {
    for (const threadId of plan.threadIds) {
      const location = locationKey(plan.profileId, threadId);
      if (owners.has(location)) throw new Error('Codex returned overlapping conversation groups for deletion.');
      owners.set(location, key);
    }
  }
  for (const [key, plan] of plans) {
    for (const source of plan.forkedFromIds) {
      const owner = owners.get(locationKey(plan.profileId, source));
      if (!owner || owner === key) continue;
      const forks = dependents.get(owner) ?? new Set<string>();
      forks.add(key);
      dependents.set(owner, forks);
    }
  }
  const ordered: Array<[string, DeletionPlan]> = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string): void => {
    if (visited.has(key)) return;
    if (visiting.has(key)) throw new Error('Codex returned a cyclic fork relationship for deletion.');
    visiting.add(key);
    for (const dependent of dependents.get(key) ?? []) visit(dependent);
    visiting.delete(key);
    visited.add(key);
    ordered.push([key, plans.get(key)!]);
  };
  for (const key of plans.keys()) visit(key);
  return ordered;
}

async function requestThreadDeletion(client: DeletionAccess['client'], threadId: string): Promise<void> {
  try {
    const result = await client.request('thread/delete', { threadId });
    assertDeletionAcknowledged(result);
  } catch (error) {
    if (error instanceof Error && error.name === 'CodexRequestRejectedError'
      && /^cannot delete thread [^\s:]+: forked history still references it$/.test(error.message)) {
      throw new Error('Another forked conversation still uses this history. Delete that fork first, then try again.', { cause: error });
    }
    throw error;
  }
}

/** A short workspace-wide gate prevents selection, send and relay-start races during deletion. */
export class CodexChatSessionDeletion {
  private deleting = false;
  private pendingMutations = 0;
  private readonly confirmedDeletions = new Map<string, ConfirmedDeletion>();
  private readonly options: { contexts: CodexChatContexts; service: CodexChatService; relays: Pick<CodexChatRelays, 'get'> };
  constructor(options: CodexChatSessionDeletion['options']) { this.options = options; }

  async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.deleting || this.pendingMutations) throw new Error('Wait for the current chat action to finish.');
    this.deleting = true;
    try { return await operation(); } finally { this.deleting = false; }
  }

  async mutation<T>(operation: () => Promise<T> | T): Promise<T> {
    if (this.deleting) throw new Error('Wait for the conversation deletion to finish.');
    this.pendingMutations += 1;
    try { return await operation(); } finally { this.pendingMutations -= 1; }
  }

  private assertAvailable(ids: readonly string[]): void {
    const targets = new Set(ids);
    const entries = this.options.contexts.allServices();
    for (const service of [this.options.service, ...entries.map(entry => entry.service)]) {
      if ([...service.activeTurns.keys(), ...service.pendingTurnStarts].some(id => id && targets.has(id))) {
        throw new Error('Stop the session in every chat pane before deleting it.');
      }
    }
    for (const ownerId of new Set(entries.map(entry => entry.ownerId))) {
      const relay = this.options.relays.get(ownerId);
      if (relay && (relay.status === 'running' || relay.status === 'stopping')
        && [relay.sourceThreadId, relay.targetThreadId, relay.moderatorThreadId].some(id => id && targets.has(id))) {
        throw new Error('Stop the conversation relay before deleting this session.');
      }
    }
  }

  async deleteSession(service: CodexChatService, value: unknown): Promise<{ threadIds: string[] }> {
    const threadId = requiredString(value, 'Chat session id');
    if (this.deleting || this.pendingMutations) throw new Error('Wait for the current chat action before deleting a session.');
    this.deleting = true;
    try {
      this.assertAvailable([threadId]);
      if (service.conversations) return await this.deleteConversation(service, threadId);
      const { threadIds } = await deletionThreads(service, threadId);
      this.assertAvailable(threadIds);
      await requestThreadDeletion(service.client, threadId);
      this.forgetDeletedSessions(threadIds);
      return { threadIds };
    } finally { this.deleting = false; }
  }

  private async deleteConversation(service: CodexChatService, threadId: string): Promise<{ threadIds: string[] }> {
    const conversations = service.conversations!;
    const locations = await conversations.locations(threadId);
    if (!locations.length) throw new Error('The conversation locations are unavailable. Refresh the session list before retrying.');
    const confirmed = this.confirmedDeletions.get(threadId) ?? new Map<string, string[]>();
    for (const deletion of await conversations.deletionProgress?.(threadId) ?? []) {
      confirmed.set(locationKey(deletion.profileId, deletion.threadId), deletion.threadIds);
    }
    const plans = new Map<string, DeletionPlan>();
    this.assertAvailable([threadId, ...locations.map(location => location.threadId), ...[...confirmed.values()].flat()]);
    // Validate every account before deleting from any account. Persist acknowledged
    // deletions for retries, retaining them in memory if saving progress fails.
    for (const location of locations) {
      const key = locationKey(location.profileId, location.threadId);
      if (plans.has(key)) continue;
      const threadIds = confirmed.get(key);
      if (threadIds) {
        await conversations.confirmDeletion?.(threadId, { ...location, threadIds });
        continue;
      }
      const group = await deletionThreads({ cwd: service.cwd, client: {
        request: (method, params) => conversations.request(location.profileId, method, params),
      } }, location.threadId);
      plans.set(key, { ...location, ...group });
    }
    const threadIds = [...new Set([threadId, ...[...confirmed.values()].flat(), ...[...plans.values()].flatMap(plan => plan.threadIds)])];
    this.assertAvailable(threadIds);
    for (const [key, plan] of orderDeletionPlans(plans)) {
      await requestThreadDeletion({ request: (method, params) => conversations.request(plan.profileId, method, params) }, plan.threadId);
      confirmed.set(key, plan.threadIds);
      this.confirmedDeletions.set(threadId, confirmed);
      await conversations.confirmDeletion?.(threadId, {
        profileId: plan.profileId, threadId: plan.threadId, threadIds: plan.threadIds,
      });
    }
    await conversations.forget(threadId);
    this.confirmedDeletions.delete(threadId);
    this.forgetDeletedSessions(threadIds);
    return { threadIds };
  }

  private forgetDeletedSessions(threadIds: string[]): void {
    for (const target of new Set([this.options.service, ...this.options.contexts.allServices().map(entry => entry.service)])) {
      target.forgetDeletedSessions(threadIds);
    }
  }
}
