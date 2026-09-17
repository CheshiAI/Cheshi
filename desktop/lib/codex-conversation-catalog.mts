import { randomUUID, createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import type { CodexChatClient, JsonObject } from './codex-chat-types.mts';
import type { CodexConversationDeletion } from './codex-chat-account-continuity.mts';
import { isSubagentThread, sessionFromThread } from './codex-chat-thread-data.mts';
import { recordValue, stringValue } from './codex-service-utils.mts';

export interface ConversationLocation { profileId: string; threadId: string }
export interface ConversationProfile { id: string; home: string }
export interface CodexConversationCatalogOptions {
  directory: string;
  cwd: string;
  profiles(): Promise<ConversationProfile[]>;
  request(profileId: string, method: string, params?: unknown): Promise<unknown>;
}

interface Chain {
  current: ConversationLocation;
  locations: ConversationLocation[];
  deleted?: true;
  pending?: true | HandoffIntent;
  confirmedDeletions?: CodexConversationDeletion[];
  deletionCwd?: string;
}
interface HandoffIntent {
  source: ConversationLocation;
  targetProfileId: string;
  checkpoint: string;
  baselineForkIds: string[];
}
interface Ledger { version: 1; chains: Chain[] }
interface LocatedThread { location: ConversationLocation; thread: JsonObject }
const gates = new Map<string, Promise<void>>();
const terminalTurnStatuses = new Set(['completed', 'failed', 'interrupted']);
export const historySourceKinds = ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview',
  'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'];

function serial<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = gates.get(key) ?? Promise.resolve();
  const result = previous.then(operation);
  const tail = result.then(() => {}, () => {});
  gates.set(key, tail);
  void tail.then(() => { if (gates.get(key) === tail) gates.delete(key); });
  return result;
}

function within(root: string, path: string): boolean {
  const part = relative(root, path);
  return part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}

function assertInside(root: string, path: string): void {
  if (!within(root, path)) throw new Error('Conversation storage path is outside its account home.');
}

function assertRegular(stat: Awaited<ReturnType<typeof lstat>>): void {
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Conversation storage must be a regular file.');
}

function location(value: unknown): ConversationLocation | null {
  const item = recordValue(value);
  const profileId = stringValue(item?.profileId);
  const threadId = stringValue(item?.threadId);
  return profileId && threadId ? { profileId, threadId } : null;
}

function sameLocation(left: ConversationLocation, right: ConversationLocation): boolean {
  return left.profileId === right.profileId && left.threadId === right.threadId;
}

/** Recover display metadata from existing handoff aliases without changing physical histories. */
function conversationSession(entry: LocatedThread, chain: Chain | undefined, entries: LocatedThread[]): JsonObject | null {
  const session = sessionFromThread(entry.thread);
  if (!session || !chain) return session;
  const predecessors = chain.locations.filter(location => !sameLocation(location, chain.current))
    .flatMap(location => {
      const previous = entries.find(candidate => sameLocation(candidate.location, location));
      return previous ? [previous] : [];
    });
  const named = [entry, ...predecessors.reverse()].find(candidate => stringValue(candidate.thread.name)?.trim());
  // Prefer the latest explicit name, then the original preview title if no name was ever assigned.
  const inherited = named ?? predecessors.at(-1);
  if (!inherited || inherited === entry) return session;
  const previous = sessionFromThread(inherited.thread);
  return previous ? { ...session, title: previous.title } : session;
}

function chainFor(ledger: Ledger, threadId: string): Chain | undefined {
  return ledger.chains.find(chain => chain.locations.some(item => item.threadId === threadId));
}

function availableChain(ledger: Ledger, threadId: string): Chain | undefined {
  const chain = chainFor(ledger, threadId);
  if (chain?.deleted) throw new Error('This conversation was deleted.');
  if (chain?.confirmedDeletions?.length) {
    throw new Error('Conversation deletion is incomplete. Retry deleting it before continuing.');
  }
  return chain;
}

function deletionRecord(value: unknown, locations: readonly ConversationLocation[]): CodexConversationDeletion {
  const item = recordValue(value);
  const owner = location(item);
  if (!owner || !locations.some(entry => sameLocation(entry, owner)) || !Array.isArray(item?.threadIds)
    || item.threadIds.some(id => typeof id !== 'string' || !id.trim())
    || !item.threadIds.includes(owner.threadId) || new Set(item.threadIds).size !== item.threadIds.length) {
    throw new Error('The conversation deletion progress record is invalid.');
  }
  return { ...owner, threadIds: [...item.threadIds] as string[] };
}

function deletionRecords(value: unknown, locations: readonly ConversationLocation[]): CodexConversationDeletion[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('The conversation deletion progress record is invalid.');
  const records = value.map(entry => deletionRecord(entry, locations));
  if (records.some((entry, index) => records.slice(0, index).some(previous => sameLocation(previous, entry)))) {
    throw new Error('The conversation deletion progress contains a duplicate location.');
  }
  return records;
}

function assertDeletionWorkspace(chain: Chain | undefined, cwd: string): void {
  if (chain?.deletionCwd && chain.deletionCwd !== resolve(cwd)) {
    throw new Error('The incomplete conversation deletion belongs to a different workspace.');
  }
}

function pendingIntent(value: unknown): true | HandoffIntent | undefined {
  if (value === true) return true;
  if (value == null) return undefined;
  const item = recordValue(value);
  const source = location(item?.source);
  const targetProfileId = stringValue(item?.targetProfileId);
  const savedCheckpoint = stringValue(item?.checkpoint);
  if (!source || !targetProfileId || !savedCheckpoint || !Array.isArray(item?.baselineForkIds)
    || item.baselineForkIds.some(id => !stringValue(id))) {
    throw new Error('The conversation handoff recovery record is invalid.');
  }
  return { source, targetProfileId, checkpoint: savedCheckpoint, baselineForkIds: item.baselineForkIds as string[] };
}

function assertHandoffResolved(chain: Chain | undefined): void {
  if (chain?.pending) throw new Error('The conversation handoff has an uncertain outcome. The original account remains readable and can continue with a new request. Refresh to recover a saved fork before switching or deleting. The fork request will not be repeated.');
}

function assertNewFork(thread: JsonObject, sourceId: string): void {
  if (thread.id === sourceId) throw new Error('The conversation fork did not create a new thread.');
}

function threadResponse(raw: unknown): JsonObject {
  const thread = recordValue(recordValue(raw)?.thread);
  if (!thread || !stringValue(thread.id)) throw new Error('The conversation response format is invalid.');
  return thread;
}

function assertSettled(thread: JsonObject, cwd: string): void {
  const status = typeof thread.status === 'string' ? thread.status : recordValue(thread.status)?.type;
  if (status !== 'idle' && status !== 'notLoaded') {
    throw new Error('Only an idle conversation can continue with another account.');
  }
  if (!stringValue(thread.cwd) || resolve(thread.cwd as string) !== resolve(cwd)) {
    throw new Error('The conversation belongs to a different workspace.');
  }
  if (!Array.isArray(thread.turns) || thread.turns.some(turn => {
    const status = stringValue(recordValue(turn)?.status);
    return !status || !terminalTurnStatuses.has(status);
  })) {
    throw new Error('A conversation with unfinished or uncertain turns cannot switch accounts.');
  }
  if (thread.turns.some(turn => !stringValue(recordValue(turn)?.id))) {
    throw new Error('The conversation contains an invalid turn checkpoint.');
  }
  if (isSubagentThread(thread)) throw new Error('A subagent conversation cannot switch accounts independently.');
}

function checkpoint(thread: JsonObject): string {
  return JSON.stringify((thread.turns as unknown[]).map(turn => {
    const item = recordValue(turn);
    return { id: item?.id, status: item?.status, items: item?.items };
  }));
}

function digest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }

async function safeDirectory(path: string): Promise<string> {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const segment of relative(current, absolute).split(sep).filter(Boolean)) {
    current = join(current, segment);
    try { await mkdir(current, { mode: 0o700 }); }
    catch (error) { if (recordValue(error)?.code !== 'EEXIST') throw error; }
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('Conversation storage directories must not use symbolic links.');
    }
  }
  return absolute;
}

/** Shares settled history snapshots without replaying their turns; credentials and databases stay separate. */
export class CodexConversationCatalog {
  private readonly options: CodexConversationCatalogOptions;
  private readonly directory: string;

  constructor(options: CodexConversationCatalogOptions) {
    this.options = options;
    this.directory = resolve(options.directory);
  }

  private async load(): Promise<Ledger> {
    const path = join(this.directory, 'conversations.json');
    let raw: unknown;
    try {
      assertRegular(await lstat(path));
      raw = JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      if (recordValue(error)?.code === 'ENOENT') return { version: 1, chains: [] };
      throw error;
    }
    const value = recordValue(raw);
    if (value?.version !== 1 || !Array.isArray(value.chains)) throw new Error('The conversation catalog is invalid.');
    const chains: Chain[] = value.chains.map(rawChain => {
      const item = recordValue(rawChain);
      const current = location(item?.current);
      const locations = Array.isArray(item?.locations) ? item.locations.map(location) : [];
      if (!current || locations.length === 0 || locations.some(entry => !entry)
        || !locations.some(entry => entry && sameLocation(entry, current))) {
        throw new Error('The conversation catalog contains an invalid account mapping.');
      }
      const pending = pendingIntent(item?.pending);
      if (pending && pending !== true && !sameLocation(pending.source, current)) {
        throw new Error('The conversation handoff recovery source is invalid.');
      }
      const confirmedDeletions = deletionRecords(item?.confirmedDeletions, locations as ConversationLocation[]);
      if (pending && confirmedDeletions.length) throw new Error('The conversation deletion progress conflicts with an unfinished handoff.');
      const deletionCwd = stringValue(item?.deletionCwd);
      if (confirmedDeletions.length ? !deletionCwd || !isAbsolute(deletionCwd) || resolve(deletionCwd) !== deletionCwd
        : item?.deletionCwd !== undefined) throw new Error('The conversation deletion workspace record is invalid.');
      return { current, locations: locations as ConversationLocation[],
        ...(item?.deleted === true ? { deleted: true as const } : {}),
        ...(confirmedDeletions.length ? { confirmedDeletions, deletionCwd: deletionCwd! } : {}),
        ...(pending ? { pending } : {}) };
    });
    return { version: 1, chains };
  }

  private async save(ledger: Ledger): Promise<void> {
    await safeDirectory(this.directory);
    const temporary = join(this.directory, `.conversations-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(ledger)}\n`, { flag: 'wx', mode: 0o600 });
      await rename(temporary, join(this.directory, 'conversations.json'));
    } finally {
      await unlink(temporary).catch(error => { if (recordValue(error)?.code !== 'ENOENT') throw error; });
    }
  }

  private async discover(profiles: ConversationProfile[]): Promise<LocatedThread[]> {
    const lists = await Promise.all(profiles.map(async profile => {
      const threads: LocatedThread[] = [];
      const seen = new Set<string>();
      let cursor: string | null = null;
      do {
        const response = recordValue(await this.options.request(profile.id, 'thread/list', {
          limit: 100, sortKey: 'recency_at', sortDirection: 'desc', cwd: this.options.cwd,
          modelProviders: [], sourceKinds: historySourceKinds,
          ...(cursor ? { cursor } : {}),
        }));
        if (!response || !Array.isArray(response.data)
          || (response.nextCursor != null && typeof response.nextCursor !== 'string')) {
          throw new Error('The conversation list response format is invalid.');
        }
        for (const value of response.data) {
          const thread = recordValue(value);
          const id = stringValue(thread?.id);
          if (thread && id && !isSubagentThread(thread) && stringValue(thread.cwd)
            && resolve(thread.cwd as string) === resolve(this.options.cwd)) {
            threads.push({ location: { profileId: profile.id, threadId: id }, thread });
          }
        }
        cursor = stringValue(response.nextCursor);
        if (cursor && seen.has(cursor)) throw new Error('The conversation list returned a repeated cursor.');
        if (cursor) seen.add(cursor);
      } while (cursor);
      return threads;
    }));
    return lists.flat();
  }

  private async assertDescendantsIdle(source: ConversationLocation): Promise<void> {
    let cursor: string | null = null;
    const seen = new Set<string>();
    do {
      const response = recordValue(await this.options.request(source.profileId, 'thread/list', {
        ancestorThreadId: source.threadId, limit: 100, modelProviders: [], sourceKinds: historySourceKinds,
        ...(cursor ? { cursor } : {}),
      }));
      if (!response || !Array.isArray(response.data)
        || (response.nextCursor != null && typeof response.nextCursor !== 'string')) {
        throw new Error('The conversation descendants could not be checked.');
      }
      for (const value of response.data) {
        const child = recordValue(value);
        const status = typeof child?.status === 'string' ? child.status : recordValue(child?.status)?.type;
        if (status !== 'idle' && status !== 'notLoaded') {
          throw new Error('A subagent is still active in this conversation.');
        }
      }
      cursor = stringValue(response.nextCursor);
      if (cursor && seen.has(cursor)) throw new Error('The conversation descendants returned a repeated cursor.');
      if (cursor) seen.add(cursor);
    } while (cursor);
  }

  private async recover(ledger: Ledger, chain: Chain | undefined, profiles: ConversationProfile[]): Promise<void> {
    if (!chain?.pending || chain.pending === true || chain.deleted || chain.confirmedDeletions?.length) return;
    const intent = chain.pending;
    const target = profiles.find(profile => profile.id === intent.targetProfileId);
    if (!target) return;
    const source = threadResponse(await this.options.request(intent.source.profileId, 'thread/read', {
      threadId: intent.source.threadId, includeTurns: true,
    }));
    assertSettled(source, this.options.cwd);
    // Continuing in the original account must never be replaced by an older recovered fork.
    if (source.id !== intent.source.threadId || checkpoint(source) !== intent.checkpoint) return;
    const possible = (await this.discover([target])).filter(entry =>
      entry.thread.forkedFromId === intent.source.threadId && !intent.baselineForkIds.includes(entry.location.threadId));
    const valid: ConversationLocation[] = [];
    for (const entry of possible) {
      const thread = threadResponse(await this.options.request(target.id, 'thread/read', {
        threadId: entry.location.threadId, includeTurns: true,
      }));
      assertSettled(thread, this.options.cwd);
      if (thread.id === entry.location.threadId && thread.forkedFromId === intent.source.threadId
        && checkpoint(thread) === intent.checkpoint) valid.push(entry.location);
    }
    if (valid.length !== 1) return;
    const previous = { current: chain.current, locations: chain.locations, pending: chain.pending };
    chain.current = valid[0]!;
    chain.locations = [...chain.locations, chain.current];
    delete chain.pending;
    try { await this.save(ledger); }
    catch (error) { Object.assign(chain, previous); throw error; }
  }

  private async tryRecover(ledger: Ledger, chain: Chain | undefined, profiles: ConversationProfile[]): Promise<void> {
    // Recovery is best effort for readers. An unavailable target must not hide the original account's history.
    await this.recover(ledger, chain, profiles).catch(() => {});
  }

  private async locate(ledger: Ledger, threadId: string, profiles: ConversationProfile[]): Promise<ConversationLocation> {
    const chain = availableChain(ledger, threadId);
    await this.tryRecover(ledger, chain, profiles);
    const owner = chain?.current ?? (await this.discover(profiles))
      .find(item => item.location.threadId === threadId)?.location;
    if (!owner) throw new Error('The conversation was not found in any registered account.');
    if (!profiles.some(profile => profile.id === owner.profileId)) {
      throw new Error('The account storing this conversation is unavailable.');
    }
    return owner;
  }

  owner(threadId: string): Promise<ConversationLocation> {
    return serial(this.directory, async () => this.locate(await this.load(), threadId, await this.options.profiles()));
  }

  list(): Promise<{ sessions: JsonObject[] }> {
    return serial(this.directory, async () => {
      const ledger = await this.load();
      const profiles = await this.options.profiles();
      for (const chain of ledger.chains) await this.tryRecover(ledger, chain, profiles);
      const entries = await this.discover(profiles);
      const sessions = new Map<string, JsonObject>();
      for (const entry of entries) {
        const chain = chainFor(ledger, entry.location.threadId);
        if (chain?.deleted || chain?.confirmedDeletions?.length || (chain && !sameLocation(chain.current, entry.location))) continue;
        const session = conversationSession(entry, chain, entries);
        if (session) sessions.set(entry.location.threadId, { ...session, profileId: entry.location.profileId });
      }
      for (const chain of ledger.chains) {
        if (chain.deleted || !chain.confirmedDeletions?.length || chain.deletionCwd !== resolve(this.options.cwd)) continue;
        const session = sessionFromThread({ id: chain.current.threadId, name: 'Deletion incomplete',
          preview: 'Retry deleting this conversation to finish removing its history.',
          updatedAt: Date.now() / 1_000, status: { type: 'notLoaded' } });
        sessions.set(chain.current.threadId, { ...session, profileId: chain.current.profileId });
      }
      return { sessions: [...sessions.values()].sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt)) };
    });
  }

  /** Validate deletion state without resuming a thread or changing its account. */
  assertWritable(threadId: string): Promise<void> {
    return serial(this.directory, async () => {
      availableChain(await this.load(), threadId);
    });
  }

  /** Reads the current physical history without loading a writable thread or switching credentials. */
  read(threadId: string, method: 'thread/read' | 'thread/goal/get', params?: JsonObject): Promise<unknown> {
    return serial(this.directory, async () => {
      if (method !== 'thread/read' && method !== 'thread/goal/get') {
        throw new Error('The conversation catalog only supports read-only requests.');
      }
      const ledger = await this.load();
      const owner = await this.locate(ledger, threadId, await this.options.profiles());
      return this.options.request(owner.profileId, method, { ...params, threadId: owner.threadId });
    });
  }

  /** Returns every physical copy, so deletion can address each owning account explicitly. */
  locations(threadId: string): Promise<ConversationLocation[]> {
    return serial(this.directory, async () => {
      const ledger = await this.load();
      const chain = chainFor(ledger, threadId);
      assertDeletionWorkspace(chain, this.options.cwd);
      await this.tryRecover(ledger, chain, await this.options.profiles());
      assertHandoffResolved(chain);
      if (chain) return chain.locations.map(item => ({ ...item }));
      return (await this.discover(await this.options.profiles()))
        .filter(item => item.location.threadId === threadId).map(item => item.location);
    });
  }

  /** Confirmed physical deletions survive restart while every logical alias stays available for retry. */
  deletionProgress(threadId: string): Promise<CodexConversationDeletion[]> {
    return serial(this.directory, async () => {
      const chain = chainFor(await this.load(), threadId);
      if (chain?.deleted) throw new Error('This conversation was deleted.');
      assertDeletionWorkspace(chain, this.options.cwd);
      return (chain?.confirmedDeletions ?? []).map(entry => ({ ...entry, threadIds: [...entry.threadIds] }));
    });
  }

  confirmDeletion(threadId: string, deletion: CodexConversationDeletion): Promise<void> {
    return serial(this.directory, async () => {
      const ledger = await this.load();
      const chain = chainFor(ledger, threadId);
      if (!chain) return;
      if (chain.deleted) throw new Error('This conversation was deleted.');
      assertDeletionWorkspace(chain, this.options.cwd);
      assertHandoffResolved(chain);
      const confirmed = deletionRecord(deletion, chain.locations);
      const previous = chain.confirmedDeletions?.find(entry => sameLocation(entry, confirmed));
      if (previous) {
        if (previous.threadIds.length !== confirmed.threadIds.length
          || previous.threadIds.some(id => !confirmed.threadIds.includes(id))) {
          throw new Error('The conversation deletion progress conflicts with an earlier confirmation.');
        }
        return;
      }
      chain.confirmedDeletions = [...chain.confirmedDeletions ?? [], confirmed];
      chain.deletionCwd = resolve(this.options.cwd);
      await this.save(ledger);
    });
  }

  /** Call only after the owning-account deletion operations succeeded. */
  forget(threadId: string): Promise<void> {
    return serial(this.directory, async () => {
      const ledger = await this.load();
      const chain = chainFor(ledger, threadId);
      if (chain) { chain.deleted = true; await this.save(ledger); }
    });
  }

  resolve(
    threadId: string,
    targetProfileId: string,
    targetClient: Pick<CodexChatClient, 'request'>,
    onFork?: (threadId: string) => void,
  ): Promise<string> {
    return serial(this.directory, async () => {
      const ledger = await this.load();
      const profiles = await this.options.profiles();
      const target = profiles.find(profile => profile.id === targetProfileId);
      if (!target) throw new Error('The selected conversation account is unavailable.');
      let chain = availableChain(ledger, threadId);
      await this.tryRecover(ledger, chain, profiles);
      const source = chain?.current ?? (await this.discover(profiles))
        .find(item => item.location.threadId === threadId)?.location;
      if (!source) throw new Error('The conversation was not found in any registered account.');
      if (source.profileId === targetProfileId) return source.threadId;
      assertHandoffResolved(chain);
      const sourceProfile = profiles.find(profile => profile.id === source.profileId);
      if (!sourceProfile) throw new Error('The account storing this conversation is unavailable.');
      const thread = threadResponse(await this.options.request(source.profileId, 'thread/read', {
        threadId: source.threadId, includeTurns: true,
      }));
      if (thread.id !== source.threadId) throw new Error('The conversation response has the wrong thread identifier.');
      assertSettled(thread, this.options.cwd);
      const sourceCheckpoint = checkpoint(thread);
      await this.assertDescendantsIdle(source);
      const imported = await this.importSnapshot(sourceProfile, target, thread);
      const checked = threadResponse(await this.options.request(source.profileId, 'thread/read', {
        threadId: source.threadId, includeTurns: true,
      }));
      assertSettled(checked, this.options.cwd);
      if (sourceCheckpoint !== checkpoint(checked) || digest(await readFile(imported.source)) !== imported.hash) {
        throw new Error('The conversation changed while preparing its account handoff.');
      }
      if (!chain) { chain = { current: source, locations: [source] }; ledger.chains.push(chain); }
      const copy = { profileId: targetProfileId, threadId: source.threadId };
      if (!chain.locations.some(item => sameLocation(item, copy))) chain.locations.push(copy);
      // Persist intent before the RPC: a lost fork response must never trigger another fork or turn.
      const baselineForkIds = (await this.discover([target])).map(entry => entry.location.threadId);
      chain.pending = { source, targetProfileId, checkpoint: sourceCheckpoint, baselineForkIds };
      await this.save(ledger);
      const turns = thread.turns as JsonObject[];
      const lastTurnId = stringValue(turns.at(-1)?.id);
      let fork: JsonObject;
      try {
        fork = threadResponse(await targetClient.request('thread/fork', {
          threadId: source.threadId, ...(lastTurnId ? { lastTurnId } : {}), deferGoalContinuation: true,
        }));
        assertNewFork(fork, source.threadId);
      } catch (error) {
        if (error instanceof Error && error.name === 'CodexRequestRejectedError') {
          delete chain.pending;
          await this.save(ledger);
        }
        throw error;
      }
      const nextId = stringValue(fork.id)!;
      chain.current = { profileId: targetProfileId, threadId: nextId };
      chain.locations.push(chain.current);
      delete chain.pending;
      await this.save(ledger);
      onFork?.(nextId);
      return nextId;
    });
  }

  private async importSnapshot(sourceProfile: ConversationProfile, target: ConversationProfile, thread: JsonObject) {
    const home = await realpath(sourceProfile.home);
    const root = await realpath(join(home, 'sessions'));
    assertInside(home, root);
    const source = stringValue(thread.path);
    if (!source || !isAbsolute(source)) throw new Error('The conversation has no stored history snapshot.');
    assertInside(root, resolve(source));
    assertInside(root, await realpath(source));
    assertRegular(await lstat(source));
    const bytes = await readFile(source);
    const hash = digest(bytes);
    const targetHome = await realpath(target.home);
    const targetRoot = join(targetHome, 'sessions');
    const destination = join(targetRoot, relative(root, source));
    assertInside(targetRoot, destination);
    await safeDirectory(dirname(destination));
    try {
      await copyFile(source, destination, constants.COPYFILE_EXCL);
      await chmod(destination, 0o600);
    }
    catch (error) { if (recordValue(error)?.code !== 'EEXIST') throw error; }
    assertInside(targetRoot, await realpath(destination));
    assertRegular(await lstat(destination));
    if (digest(await readFile(destination)) !== hash || digest(await readFile(source)) !== hash) {
      throw new Error('A different conversation snapshot already exists in the selected account.');
    }
    return { source, hash };
  }
}
