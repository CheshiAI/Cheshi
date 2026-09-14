import { randomUUID } from 'node:crypto';
import { CHAT_RELAY_MODERATOR_TITLE, chatRelayRequest, formatChatRelayMessage } from '../shared/chat-relay.ts';
import type { NormalizedChatRelayRequest, ChatRelayState } from '../shared/chat-relay.ts';
import type { CodexChatContexts } from './codex-chat-contexts.mts';
import type { CodexChatService } from './codex-chat-service.mts';
import { RelayCancellationError, runChatRelayTurn } from './codex-chat-relay-turn.mts';
import { runChatRelayWorkflow } from './codex-chat-relay-workflow.mts';
import { requireChatRelayHistoryId, type CodexChatRelayHistory } from './codex-chat-relay-history.mts';
import type { ChatRelayHistoryRecord } from '../shared/chat-relay.ts';

type RelayRun = { state: ChatRelayState; abort: AbortController; task: Promise<void>;
  objective: string; startedAt: string; persistence: Promise<void>; ownedModeratorContextId?: string };
type RelayOptions = { contexts: CodexChatContexts; emit(ownerId: number, state: ChatRelayState): void;
  history?: CodexChatRelayHistory };

export class CodexChatRelays {
  private readonly options: RelayOptions;
  private readonly runs = new Map<number, RelayRun>();
  private readonly pending = new Map<number, Map<string, number>>();
  private readonly reserved = new Map<number, Set<string>>();
  private readonly tasks = new Set<Promise<void>>();
  private shuttingDown = false;

  constructor(options: RelayOptions) {
    this.options = options;
    options.contexts.onDispose((ownerId, contextId) => {
      if (contextId === undefined || this.reserved.get(ownerId)?.has(contextId)) this.stop(ownerId);
      if (contextId === undefined) {
        this.runs.delete(ownerId);
        this.reserved.delete(ownerId);
        this.pending.delete(ownerId);
      }
    });
  }

  get(ownerId: number): ChatRelayState | null {
    const state = this.runs.get(ownerId)?.state;
    return state ? { ...state } : null;
  }

  async listHistory(_ownerId: number): Promise<ChatRelayHistoryRecord[]> {
    await Promise.all([...this.runs.values()].map((run) => run.persistence));
    return this.options.history ? this.options.history.list() : [];
  }

  async deleteHistory(_ownerId: number, value: unknown): Promise<{ id: string }> {
    const id = requireChatRelayHistoryId(value);
    const history = this.options.history;
    if (!history) throw new Error('Conversation history is unavailable.');
    const matching = [...this.runs.entries()].filter(([, run]) => run.state.id === id);
    if (matching.some(([, run]) => run.state.status === 'running' || run.state.status === 'stopping')) {
      throw new Error('Stop the conversation relay before deleting its history.');
    }
    // A terminal state may still have final cleanup and persistence in flight.
    await Promise.all(matching.map(([, run]) => run.task));
    const result = await history.delete(id);
    for (const [ownerId, run] of matching) {
      if (this.runs.get(ownerId) === run) this.runs.delete(ownerId);
    }
    return result;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const ownerId of this.runs.keys()) this.stop(ownerId);
    await Promise.all([...this.tasks]);
    await this.options.history?.flush();
  }

  async mutation<T>(ownerId: number, contextId: unknown, operation: () => Promise<T> | T): Promise<T> {
    if (typeof contextId !== 'string') return operation();
    if (this.reserved.get(ownerId)?.has(contextId)) throw new Error('Stop the conversation relay before changing this pane.');
    let pending = this.pending.get(ownerId);
    if (!pending) { pending = new Map(); this.pending.set(ownerId, pending); }
    pending.set(contextId, (pending.get(contextId) ?? 0) + 1);
    try { return await operation(); }
    finally {
      const remaining = (pending.get(contextId) ?? 1) - 1;
      if (remaining > 0) pending.set(contextId, remaining); else pending.delete(contextId);
    }
  }

  start(ownerId: number, value: unknown): ChatRelayState {
    if (this.shuttingDown) throw new Error('The app is shutting down.');
    const request = chatRelayRequest(value);
    if (this.reserved.has(ownerId)) throw new Error('A conversation relay is already running or stopping.');
    const source = this.readyService(ownerId, request.sourceContextId, request.sourceThreadId);
    const target = this.readyService(ownerId, request.targetContextId, request.targetThreadId);
    const moderator = request.moderatorContextId && request.moderatorThreadId
      ? this.readyService(ownerId, request.moderatorContextId, request.moderatorThreadId) : null;
    const ownedModeratorContextId = request.mode === 'debate' && !moderator ? `relay-moderator-${randomUUID()}` : undefined;
    const run: RelayRun = {
      state: { id: randomUUID(), status: 'running', step: 1, message: null,
        mode: request.mode, maxRounds: request.maxRounds, round: 1, speaker: 'A',
        phase: request.mode === 'debate' ? 'discussion' : 'proposal', outcome: null,
        proposalVersion: request.mode === 'consensus' ? 1 : null, proposal: null, issues: [], summary: null,
        sourceContextId: request.sourceContextId, sourceThreadId: request.sourceThreadId,
        targetContextId: request.targetContextId, targetThreadId: request.targetThreadId,
        ...(moderator ? { moderatorContextId: request.moderatorContextId, moderatorThreadId: request.moderatorThreadId } : {}) },
      abort: new AbortController(), task: Promise.resolve(),
      objective: request.objective, startedAt: new Date().toISOString(), persistence: Promise.resolve(),
      ownedModeratorContextId,
    };
    this.runs.set(ownerId, run);
    this.reserved.set(ownerId, new Set([request.sourceContextId, request.targetContextId,
      ...(request.moderatorContextId ? [request.moderatorContextId] : []),
      ...(ownedModeratorContextId ? [ownedModeratorContextId] : [])]));
    this.publish(ownerId, run);
    run.task = this.execute(ownerId, run, request, source, target, moderator);
    this.tasks.add(run.task);
    void run.task.then(() => this.tasks.delete(run.task), () => this.tasks.delete(run.task));
    return { ...run.state };
  }

  stop(ownerId: number): ChatRelayState | null {
    const run = this.runs.get(ownerId);
    if (!run) return null;
    if (run.state.status === 'running') {
      run.state = { ...run.state, status: 'stopping', message: 'Stopping relay…' };
      run.abort.abort();
      this.publish(ownerId, run);
    }
    return { ...run.state };
  }

  private readyService(ownerId: number, contextId: string, threadId: string): CodexChatService {
    const service = this.options.contexts.existing(ownerId, contextId);
    if (!service || service.viewedThreadId !== threadId) throw new Error('Open all selected conversations before starting a relay.');
    if (service.activeTurns.size > 0 || service.pendingNewTurnClientMessageId || this.pending.get(ownerId)?.has(contextId)) {
      throw new Error('Wait for all selected conversations to finish before starting a relay.');
    }
    return service;
  }

  private publish(ownerId: number, run: RelayRun) {
    this.persist(ownerId, run);
    if (this.runs.get(ownerId) === run) this.options.emit(ownerId, { ...run.state });
  }

  private persist(ownerId: number, run: RelayRun) {
    const history = this.options.history;
    if (!history) return;
    const updatedAt = new Date().toISOString();
    const state = structuredClone(run.state);
    delete state.historyError;
    const record: ChatRelayHistoryRecord = { id: state.id, objective: run.objective,
      startedAt: run.startedAt, updatedAt,
      finishedAt: state.status === 'running' || state.status === 'stopping' ? null : updatedAt, state };
    run.persistence = (async () => {
      await history.save(record);
      if (run.state.historyError) {
        const next = { ...run.state };
        delete next.historyError;
        run.state = next;
        if (this.runs.get(ownerId) === run) this.options.emit(ownerId, { ...run.state });
      }
    })().catch((error: unknown) => {
      const message = `Could not save conversation history: ${error instanceof Error ? error.message : String(error)}`;
      run.state = { ...run.state, historyError: message.slice(0, 2_000) };
      if (this.runs.get(ownerId) === run) this.options.emit(ownerId, { ...run.state });
    });
  }

  private async prepareModerator(ownerId: number, run: RelayRun, request: NormalizedChatRelayRequest, source: CodexChatService): Promise<CodexChatService | null> {
    run.abort.signal.throwIfAborted();
    if (!run.ownedModeratorContextId) return null;
    const moderator = this.options.contexts.get(ownerId, run.ownedModeratorContextId);
    moderator.selectedModel = source.selectedModel;
    moderator.selectedReasoningEffort = source.selectedReasoningEffort;
    moderator.selectedServiceTier = source.selectedServiceTier;
    const threadId = await moderator.ensureWritableThread(null);
    request.moderatorContextId = run.ownedModeratorContextId;
    request.moderatorThreadId = threadId;
    run.state = { ...run.state, moderatorContextId: run.ownedModeratorContextId, moderatorThreadId: threadId };
    this.publish(ownerId, run);
    run.abort.signal.throwIfAborted();
    try {
      await moderator.client.request('thread/name/set', { threadId, name: CHAT_RELAY_MODERATOR_TITLE }, 10_000);
      moderator.emit({ type: 'session-title', threadId, title: CHAT_RELAY_MODERATOR_TITLE });
    } catch (error) {
      moderator.log('codex-chat-relay-moderator-title-failed', { threadId,
        message: error instanceof Error ? error.message : String(error) });
    }
    run.abort.signal.throwIfAborted();
    return moderator;
  }

  private async execute(ownerId: number, run: RelayRun, request: NormalizedChatRelayRequest, source: CodexChatService, target: CodexChatService, selectedModerator: CodexChatService | null) {
    try {
      const moderator = selectedModerator ?? await this.prepareModerator(ownerId, run, request, source);
      run.abort.signal.throwIfAborted();
      const result = await runChatRelayWorkflow(request, {
        signal: run.abort.signal,
        update: (progress) => {
          run.state = { ...run.state, ...progress };
          this.publish(ownerId, run);
        },
        turn: ({ speaker, provenance, body }) => {
          const prompt = formatChatRelayMessage({ relayId: run.state.id, ...provenance }, body);
          const service = speaker === 'A' ? source : speaker === 'B' ? target : moderator;
          const threadId = speaker === 'A' ? request.sourceThreadId : speaker === 'B' ? request.targetThreadId : request.moderatorThreadId;
          if (!service || !threadId) return Promise.reject(new Error('The moderator conversation is unavailable.'));
          return runChatRelayTurn(service, threadId,
            prompt, `relay-${run.state.id}-${provenance.step}`, run.abort.signal, nextThreadId => {
              const field = speaker === 'A' ? 'sourceThreadId' : speaker === 'B' ? 'targetThreadId' : 'moderatorThreadId';
              request[field] = nextThreadId;
              run.state = { ...run.state, [field]: nextThreadId };
              this.publish(ownerId, run);
            });
        },
      });
      run.state = { ...run.state, ...result, status: 'completed' };
    } catch (error) {
      if (!run.abort.signal.aborted || error instanceof RelayCancellationError) run.state = { ...run.state, status: 'error', message: error instanceof Error ? error.message : String(error) };
    } finally {
      if (run.abort.signal.aborted && run.state.status !== 'error') run.state = { ...run.state, status: 'stopped', message: 'Relay stopped.' };
      if (run.ownedModeratorContextId) {
        try { await this.options.contexts.dispose(ownerId, run.ownedModeratorContextId); }
        catch (error) {
          run.state = { ...run.state, status: 'error', message: `Could not close the moderator context: ${error instanceof Error ? error.message : String(error)}` };
        }
      }
      if (this.runs.get(ownerId) === run) this.reserved.delete(ownerId);
      this.publish(ownerId, run);
      await run.persistence;
    }
  }
}
