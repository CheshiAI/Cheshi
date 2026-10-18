import { interleaveCandidates, rankWithRecovery } from './ranking-recovery.mts';
import type { RerankMemory } from './rerank.mts';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Binding } from '../agent-orchestration/mailbox.mts';
import type { SessionMemory } from './session-memory.mts';
import { acquireFlashHost, type FlashHost } from './runtime.mts';
import { callFlash, FlashError } from './client.mts';
import { reconcileSources, type FlashSource } from './sources.mts';
import { parseMemoryTurns, validateSummary, type SummarizeMemory, type TurnReference } from './summary.mts';
import { DockerMemoryArchive, dockerMemoryOwner, dockerSessionId } from './docker-archive.mts';
import { memoryArguments } from '../../../experiments/codex-specialists/src/flash-tools.ts';
import type { FlashRequest } from '../../../experiments/codex-specialists/src/flash-queue.ts';
import { flashSourceHref, type FlashSourceTarget } from '../../shared/flash-memory.ts';
import type { FlashControl } from './control.mts';

export interface LocalAgentMemory {
  memory: SessionMemory;
  summarize: SummarizeMemory;
  rerank?: RerankMemory;
  verifyCandidates?(matches: Record<string, unknown>[], signal: AbortSignal): Promise<void>;
  authenticated(accountId: string): boolean;
  original(target: FlashSourceTarget): Promise<string>;
}

function assertOriginalMatches(sources: FlashSource[], matches: Record<string, unknown>[]): void {
  if (!Array.isArray(matches)) throw new FlashError('unavailable', 'Invalid Docker search response.');
  const byId = new Map(sources.map(s => [s.source_id, s.document]));
  for (const match of matches) {
    const doc = byId.get(String(match.source_id));
    const offset = match.offset, text = match.text;
    if (!doc || match.session_id !== doc.threadId || match.turn_id !== doc.turnId || match.message_id !== doc.itemId
      || match.kind !== doc.kind || match.entry !== doc.entry || typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0
      || typeof text !== 'string' || [...doc.text].slice(offset, offset + [...text].length).join('') !== text
      || match.total_characters !== [...doc.text].length || (match.support_source_id !== undefined && !byId.has(String(match.support_source_id)))) {
      throw new FlashError('stale_source', 'Docker search does not match its original.');
    }
  }
}

export class AgentFlashMemory {
  readonly archive: DockerMemoryArchive;
  private readonly local = new Map<string, LocalAgentMemory>();
  private readonly host: FlashHost;
  private readonly valid: (binding: Binding) => boolean;
  private readonly control?: FlashControl;
  constructor(userData: string, valid: (binding: Binding) => boolean, host?: FlashHost, control?: FlashControl) {
    this.control = control;
    this.archive = new DockerMemoryArchive(join(userData, 'flash', 'docker-sessions'));
    this.host = host ?? control?.acquire() ?? acquireFlashHost(userData); this.valid = valid;
  }
  register(workspace: string, memory: LocalAgentMemory) {
    this.local.set(workspace, memory);
    return () => { if (this.local.get(workspace) === memory) this.local.delete(workspace); };
  }
  enabled(): boolean { return this.control?.enabled() ?? true; }
  withEnabled<T>(operation: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
    return this.control ? this.control.run(operation, signal) : operation(signal);
  }
  private assertCurrent(binding: Binding, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.valid(binding)) throw new FlashError('unavailable', 'The Docker account or project assignment changed.');
  }
  async original(workspace: string, target: FlashSourceTarget) {
    if (!target.owner) {
      const local = this.local.get(workspace);
      if (!local) throw new Error('Open the project SESSION to read this original.');
      return local.original(target);
    }
    const binding = (await this.archive.read(target.owner)).binding;
    if (!binding || binding.workspace !== workspace || !this.valid(binding)) throw new Error('Docker source ownership is unavailable.');
    const result = await this.archive.original(target.owner, target.threadId, target.itemId);
    this.assertCurrent(binding, new AbortController().signal);
    return result;
  }
  async execute(binding: Binding, request: FlashRequest, signal: AbortSignal): Promise<unknown> {
    const operation = (current: AbortSignal) => this.executeEnabled(binding, request, current);
    return this.withEnabled(operation, signal);
  }
  private async executeEnabled(binding: Binding, request: FlashRequest, signal: AbortSignal): Promise<unknown> {
    this.assertCurrent(binding, signal);
    const args = memoryArguments(request.tool, request.args), owner = dockerMemoryOwner(binding);
    const local = this.local.get(binding.workspace);
    const localAvailable = !!local && local.authenticated(binding.accountId);
    const check = () => {
      this.assertCurrent(binding, signal);
      if (localAvailable && (this.local.get(binding.workspace) !== local || !local.authenticated(binding.accountId))) throw new FlashError('stale_source', 'Project accounts changed. Retry.');
    };
    const snapshot = await this.archive.sources(owner);
    const ownRead = async (params: Record<string, unknown>) => this.host.transaction(async connection => {
      check();
      await reconcileSources(connection, binding.workspace, owner, snapshot.sources, signal);
      const scope = { workspace: binding.workspace, account: owner, homie: `docker:${owner}:${randomUUID()}` };
      const grant = await callFlash<{ token: string }>(connection, 'grant.create', { ...scope, ttl_seconds: 60 }, signal);
      try { return await callFlash({ ...connection, token: grant.token }, request.tool === 'memory_read' ? 'memory_read_turns' : request.tool, params, signal); }
      finally { await callFlash({ ...connection, timeoutMs: 2000 }, 'grant.revoke', scope).catch(() => {}); }
    }, signal);
    const verify = async () => { const current = await this.archive.sources(owner); check(); if (current.revision !== snapshot.revision) throw new FlashError('stale_source', 'Docker originals changed. Retry.'); };
    if (request.tool === 'memory_search') {
      const searchArgs = { ...args, limit: 30 };
      const scopedSession = typeof args.session_id === 'string' ? args.session_id : undefined;
      if (scopedSession?.startsWith('docker_') && !snapshot.sources.some(s => s.document.threadId === scopedSession)) throw new Error('Docker session is outside this memory scope.');
      const own = !scopedSession || scopedSession.startsWith('docker_')
        ? await ownRead({ ...searchArgs, exclude_turn: { session_id: dockerSessionId(owner, request.threadId), turn_id: request.turnId } }) as { matches: Record<string, unknown>[] } : { matches: [] };
      assertOriginalMatches(snapshot.sources, own.matches);
      let project: { matches: Record<string, unknown>[] } = { matches: [] };
      let projectStatus = localAvailable ? 'ready' : 'unavailable';
      if (localAvailable && !scopedSession?.startsWith('docker_')) {
        try { project = await (local.memory.searchCandidates
          ? local.memory.searchCandidates(searchArgs, request.threadId, signal, request.turnId)
          : local.memory.execute('memory_search', searchArgs, request.threadId, signal, request.turnId)) as typeof project; }
        catch { check(); projectStatus = 'unavailable'; }
      }
      const groups = [own.matches.map(m => ({ ...m, origin: 'docker', owner })),
        project.matches.map(m => ({ ...m, origin: 'local' }))];
      const candidates = groups.flat();
      const ranked = await rankWithRecovery(args.query as string, candidates, signal, localAvailable ? local.rerank : undefined, interleaveCandidates(groups));
      const matches = ranked.matches.slice(0, Number(args.limit ?? 10));
      // Inference happens outside Flash's writer; recheck both sources afterward.
      if (localAvailable && local.rerank && local.verifyCandidates) await local.verifyCandidates(project.matches, signal);
      else if (localAvailable && local.rerank) for (const match of project.matches) {
        const original = await local.original({ threadId: String(match.session_id), itemId: String(match.message_id) });
        const offset = Number(match.offset);
        if ([...original].slice(offset, offset + [...String(match.text)].length).join('') !== match.text) throw new FlashError('stale_source', 'Project originals changed during ranking.');
      }
      await verify();
      return { ...ranked, matches, coverage: { docker: 'ready', local: projectStatus }, partial: projectStatus !== 'ready',
        ...(projectStatus !== 'ready' ? { notice: ['notice' in ranked ? ranked.notice : undefined, 'Project SESSION memory is unavailable. Open the project and sign in, then retry for complete coverage.'].filter(Boolean).join(' ') } : {}) };
    }
    const refs = args.turns as TurnReference[];
    const ownRefs = refs.filter(r => r.session_id.startsWith('docker_')), localRefs = refs.filter(r => !r.session_id.startsWith('docker_'));
    if (!localAvailable) throw new FlashError('unavailable', 'Open the project and sign in to read evidence with Luna.');
    if (ownRefs.some(r => !snapshot.sources.some(s => s.document.threadId === r.session_id && s.document.turnId === r.turn_id))) throw new Error('Docker turn is outside this memory scope.');
    const results: unknown[] = [];
    if (ownRefs.length) {
      const turns = parseMemoryTurns(await ownRead({ turns: ownRefs }), ownRefs);
      for (const turn of turns) {
        const originals = snapshot.sources.filter(s => s.document.threadId === turn.session_id && s.document.turnId === turn.turn_id).map(s => s.document);
        if (originals.length !== turn.messages.length || turn.messages.some((m, i) => m.text !== originals[i]?.text || m.message_id !== originals[i]?.itemId || m.kind !== originals[i]?.kind)) throw new FlashError('stale_source', 'Docker turn does not match its complete original.');
      }
      const summary = validateSummary(await local.summarize({ question: args.question as string, turns }, signal), turns);
      results.push({ ...summary, origin: 'docker', evidence: summary.evidence.map(e => ({ ...e, origin: 'docker', source_url: flashSourceHref({ owner, threadId: e.session_id, itemId: e.message_id }) })) });
    }
    if (localRefs.length) results.push({ ...await local.memory.execute('memory_read', { question: args.question, turns: localRefs }, request.threadId, signal) as object, origin: 'local' });
    await verify();
    return { results, model: 'gpt-6-luna', effort: 'low', notice: 'Keep each source origin and its validated quotes together. Do not infer chronology from result order.' };
  }
  async dispose() { this.local.clear(); await this.host.release(); }
}
