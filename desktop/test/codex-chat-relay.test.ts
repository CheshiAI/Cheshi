import { describe, expect, test } from 'bun:test';
import { CodexChatContexts } from '../lib/codex-chat-contexts.mts';
import type { IpcMainInvokeEvent } from 'electron';
import { registerCodexChatIpc } from '../lib/codex-chat-ipc.mts';
import { CodexChatRelays } from '../lib/codex-chat-relay.mts';
import type { CodexConversationAccess } from '../lib/codex-chat-account-continuity.mts';
import { codexThread, createFakeCodexClient, expectFailure } from './codex-chat-test-helpers.ts';
import { formatChatRelayConsensusReply, parseChatRelayMessage, type ChatRelayState } from '../shared/chat-relay.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
type FakeClient = ReturnType<typeof createFakeCodexClient>;
type Started = { client: FakeClient; params: Record<string, unknown>; id: string; resolve: (value: unknown) => void };

async function fixture(options: { interrupt?: () => Promise<unknown>; startThread?: () => Promise<unknown>; handoff?: boolean } = {}) {
  const clients: FakeClient[] = [];
  const turns: Started[] = [];
  const waiting: Array<(turn: Started) => void> = [];
  const stateWaiters: Array<{ status: ChatRelayState['status']; resolve: (state: ChatRelayState) => void }> = [];
  const events: Record<string, unknown>[] = [];
  const stoppedClients: FakeClient[] = [];
  let sequence = 0;
  const conversations: CodexConversationAccess | undefined = options.handoff ? {
    async list() { return { sessions: [] }; },
    async read(id) { return { thread: codexThread(id) }; },
    async resolve(id) { return id.endsWith('-new') ? id : `${id}-new`; },
    async locations() { return []; }, async request() { throw new Error('Unused'); }, async forget() {},
  } : undefined;
  const contexts = new CodexChatContexts({
    service: { cwd: '/workspace', serviceName: 'test', developerInstructions: 'Test instructions.', conversations },
    createClient() {
      const client = createFakeCodexClient({
        'thread/read': (params: Record<string, unknown>) => ({ thread: codexThread(String(params.threadId)) }),
        'thread/resume': (params: Record<string, unknown>) => ({ thread: codexThread(String(params.threadId)) }),
        'thread/unsubscribe': {},
        'thread/start': options.startThread ?? (() => ({ thread: codexThread('moderator-thread') })),
        'turn/interrupt': options.interrupt ?? {},
        'turn/start': (params: Record<string, unknown>) => {
          const gate = deferred<unknown>();
          const turn = { client, params, id: `turn-${++sequence}`, resolve: gate.resolve };
          const waiter = waiting.shift();
          if (waiter) waiter(turn); else turns.push(turn);
          return gate.promise;
        },
      });
      clients.push(client);
      return { ...client, async stop() { stoppedClients.push(client); } };
    },
    emit(_owner, event) { events.push(event); },
  });
  const relays = new CodexChatRelays({ contexts, emit(_owner, state) {
    for (const waiter of [...stateWaiters]) if (waiter.status === state.status) {
      stateWaiters.splice(stateWaiters.indexOf(waiter), 1); waiter.resolve(state);
    }
  } });
  await contexts.get(1, 'source').openSession('source-thread');
  await contexts.get(1, 'target').openSession('target-thread');
  const request = { sourceContextId: 'source', sourceThreadId: 'source-thread', targetContextId: 'target', targetThreadId: 'target-thread', objective: 'Compare two implementation approaches.' };
  return { contexts, relays, clients, events, stoppedClients, request,
    nextTurn(): Promise<Started> { const turn = turns.shift(); return turn ? Promise.resolve(turn) : new Promise((resolve) => waiting.push(resolve)); },
    waitState(status: ChatRelayState['status']): Promise<ChatRelayState> {
      const current = relays.get(1); return current?.status === status ? Promise.resolve(current) : new Promise((resolve) => stateWaiters.push({ status, resolve }));
    },
  };
}

function complete(turn: Started, text: string, beforeAck = false) {
  if (!beforeAck) turn.resolve({ turn: { id: turn.id } });
  turn.client.emit('turn/completed', { threadId: turn.params.threadId, turn: {
    id: turn.id, status: 'completed', items: [
      { id: 'private', type: 'reasoning', summary: [{ text: 'PRIVATE REASONING' }] },
      { id: 'tool', type: 'commandExecution', aggregatedOutput: 'PRIVATE TOOL OUTPUT' },
      { id: `answer-${turn.id}`, type: 'agentMessage', phase: 'final_answer', text },
    ],
  } });
  if (beforeAck) turn.resolve({ turn: { id: turn.id } });
}
function prompt(turn: Started): string {
  const input = turn.params.input as Array<{ text?: string }>;
  return input.map(({ text }) => text ?? '').join('');
}

describe('bounded conversation relay', () => {
  test('handoff updates participant and moderator state, later rounds and quoted provenance', async () => {
    const f = await fixture({ handoff: true });
    try {
      await f.contexts.get(1, 'moderator').openSession('moderator-thread');
      f.relays.start(1, { ...f.request, mode: 'debate', maxRounds: 2,
        moderatorContextId: 'moderator', moderatorThreadId: 'moderator-thread' });
      for (let step = 0; step < 4; step += 1) {
        const turn = await f.nextTurn();
        expect(turn.params.threadId).toBe(step % 2 === 0 ? 'source-thread-new' : 'target-thread-new');
        const state = f.relays.get(1)!;
        expect(state.sourceThreadId).toBe('source-thread-new');
        if (step > 0) expect(state.targetThreadId).toBe('target-thread-new');
        if (step > 0) expect(parseChatRelayMessage(prompt(turn))?.provenance.sourceThreadId)
          .toBe(step % 2 === 0 ? 'target-thread-new' : 'source-thread-new');
        complete(turn, `Argument ${step}`, true);
      }
      const synthesis = await f.nextTurn();
      expect(synthesis.params.threadId).toBe('moderator-thread-new');
      expect(f.relays.get(1)?.moderatorThreadId).toBe('moderator-thread-new');
      expect(parseChatRelayMessage(prompt(synthesis))?.provenance.sourceThreadIds)
        .toEqual(['source-thread-new', 'target-thread-new']);
      complete(synthesis, 'Summary', true);
      expect(await f.waitState('completed')).toMatchObject({ sourceThreadId: 'source-thread-new',
        targetThreadId: 'target-thread-new', moderatorThreadId: 'moderator-thread-new' });
      expect(f.clients.flatMap(client => client.requests.filter(request => request.method === 'turn/start'))).toHaveLength(5);
    } finally { await f.relays.shutdown(); await f.contexts.stop(); }
  });

  test('runs exactly proposal, review, revision and forwards only completed assistant output', async () => {
    const f = await fixture();
    try {
      const started = f.relays.start(1, f.request);
      expect(started.status).toBe('running');
      const proposal = await f.nextTurn();
      expect(proposal.params.threadId).toBe('source-thread');
      complete(proposal, 'PROPOSAL', true);
      const review = await f.nextTurn();
      expect(review.params.threadId).toBe('target-thread');
      expect(prompt(review)).toContain('PROPOSAL');
      expect(prompt(review)).not.toContain('PRIVATE');
      expect(parseChatRelayMessage(prompt(review))?.provenance).toMatchObject({ step: 2, sourceThreadId: 'source-thread', role: 'review' });
      complete(review, 'REVIEW');
      const revision = await f.nextTurn();
      expect(revision.params.threadId).toBe('source-thread');
      expect(prompt(revision)).toContain('REVIEW');
      complete(revision, 'FINAL REVISION');
      expect((await f.waitState('completed')).step).toBe(3);
      expect(f.clients.flatMap(({ requests }) => requests.filter(({ method }) => method === 'turn/start'))).toHaveLength(3);
      expect(f.events.filter((event) => event.type === 'user-message')).toHaveLength(3);
    } finally { await f.contexts.stop(); }
  });

  test('executes bounded debate rounds through isolated transports', async () => {
    const f = await fixture();
    try {
      f.relays.start(1, { ...f.request, mode: 'debate', maxRounds: 2 });
      for (let index = 0; index < 4; index += 1) {
        const turn = await f.nextTurn();
        expect(turn.params.threadId).toBe(index % 2 === 0 ? 'source-thread' : 'target-thread');
        expect(f.relays.get(1)).toMatchObject({ round: Math.floor(index / 2) + 1, speaker: index % 2 === 0 ? 'A' : 'B' });
        complete(turn, `Argument ${index + 1}`);
      }
      const synthesis = await f.nextTurn();
      expect(synthesis.params.threadId).toBe('moderator-thread');
      expect(synthesis.client).toBe(f.clients[2]!);
      expect(parseChatRelayMessage(prompt(synthesis))?.provenance).toMatchObject({ step: 5, role: 'synthesis', sourceThreadIds: ['source-thread', 'target-thread'] });
      for (let step = 1; step <= 4; step += 1) expect(prompt(synthesis)).toContain(`Argument ${step}`);
      complete(synthesis, 'Independent synthesis with remaining differences');
      const final = await f.waitState('completed');
      expect(final).toMatchObject({ outcome: 'debated', step: 5, speaker: 'C', summary: 'Independent synthesis with remaining differences', moderatorThreadId: 'moderator-thread' });
      expect(f.contexts.existing(1, final.moderatorContextId!)).toBeNull();
      expect(f.stoppedClients).toContain(f.clients[2]!);
      expect(f.events.filter((event) => event.type === 'user-message')).toHaveLength(5);
    } finally { await f.contexts.stop(); }
  });

  test('publishes mutual agreement only after the proposer confirms the reviewed version', async () => {
    const f = await fixture();
    try {
      f.relays.start(1, { ...f.request, mode: 'consensus', maxRounds: 1 });
      for (let step = 1; step <= 3; step += 1) {
        const turn = await f.nextTurn();
        expect(f.relays.get(1)?.outcome).toBeNull();
        complete(turn, formatChatRelayConsensusReply({ kind: 'cheshi-relay-consensus', version: 1,
          decision: 'agree', proposal: step === 1 ? 'Ship the reviewed plan.' : null, issues: [], summary: 'Accepted.' }));
      }
      expect(await f.waitState('completed')).toMatchObject({ outcome: 'agreed', step: 3,
        proposalVersion: 1, proposal: 'Ship the reviewed plan.', issues: [] });
      await f.relays.mutation(1, 'target', () => f.contexts.get(1, 'target').newSession());
    } finally { await f.contexts.stop(); }
  });

  test('reserves and routes an existing third conversation without disposing its pane', async () => {
    const f = await fixture();
    try {
      const moderator = f.contexts.get(1, 'moderator');
      await moderator.openSession('selected-moderator');
      f.relays.start(1, { ...f.request, mode: 'debate', maxRounds: 1,
        moderatorContextId: 'moderator', moderatorThreadId: 'selected-moderator' });
      await expectFailure(() => f.relays.mutation(1, 'moderator', () => moderator.newSession()), 'Stop the conversation relay before changing this pane.');
      complete(await f.nextTurn(), 'A position');
      complete(await f.nextTurn(), 'B position');
      const synthesis = await f.nextTurn();
      expect(synthesis.client).toBe(f.clients[2]!);
      expect(synthesis.params.threadId).toBe('selected-moderator');
      complete(synthesis, 'C synthesis');
      expect(await f.waitState('completed')).toMatchObject({ moderatorContextId: 'moderator', summary: 'C synthesis' });
      expect(f.contexts.existing(1, 'moderator')).toBe(moderator);
      expect(f.clients.flatMap(({ requests }) => requests.filter(({ method }) => method === 'thread/start'))).toHaveLength(0);
      await f.relays.mutation(1, 'moderator', () => moderator.newSession());
    } finally { await f.contexts.stop(); }
  });

  test('new moderator inherits model configuration without resuming either participant', async () => {
    const f = await fixture();
    try {
      const source = f.contexts.get(1, 'source');
      source.selectedModel = 'test-model';
      source.selectedReasoningEffort = 'high';
      source.selectedServiceTier = 'priority';
      f.relays.start(1, { ...f.request, mode: 'debate', maxRounds: 1 });
      complete(await f.nextTurn(), 'A position');
      complete(await f.nextTurn(), 'B position');
      const synthesis = await f.nextTurn();
      const client = f.clients[2]!;
      expect(client.requests.find(({ method }) => method === 'thread/start')?.params).toMatchObject({ model: 'test-model', serviceTier: 'priority', ephemeral: false });
      expect(client.requests.filter(({ method }) => method === 'thread/resume')).toHaveLength(0);
      expect(synthesis.params).toMatchObject({ model: 'test-model', effort: 'high', serviceTier: 'priority' });
      complete(synthesis, 'C synthesis');
      await f.waitState('completed');
    } finally { await f.contexts.stop(); }
  });

  test('rejects missing, busy and duplicate moderator selections before sending', async () => {
    const f = await fixture();
    try {
      const request = { ...f.request, mode: 'debate', maxRounds: 1,
        moderatorContextId: 'moderator', moderatorThreadId: 'moderator-thread' };
      expect(() => f.relays.start(1, request)).toThrow('Open all selected');
      await f.contexts.get(1, 'moderator').openSession('moderator-thread');
      expect(() => f.relays.start(1, { ...request, moderatorContextId: 'source', moderatorThreadId: 'source-thread' })).toThrow();
      expect(() => f.relays.start(1, { ...request, moderatorThreadId: 'target-thread' })).toThrow();
      const gate = deferred<void>();
      const mutation = f.relays.mutation(1, 'moderator', () => gate.promise);
      expect(() => f.relays.start(1, request)).toThrow('Wait for all selected');
      gate.resolve(); await mutation;
      expect(f.clients.flatMap(({ requests }) => requests.filter(({ method }) => method === 'turn/start'))).toHaveLength(0);
    } finally { await f.contexts.stop(); }
  });

  test('cancels moderator creation before starting any participant and releases every reservation', async () => {
    const gate = deferred<unknown>();
    const f = await fixture({ startThread: () => gate.promise });
    try {
      const started = f.relays.start(1, { ...f.request, mode: 'debate', maxRounds: 1 });
      expect(started.moderatorThreadId).toBeUndefined();
      expect(f.relays.stop(1)?.status).toBe('stopping');
      gate.resolve({ thread: codexThread('moderator-thread') });
      const stopped = await f.waitState('stopped');
      expect(stopped).toMatchObject({ moderatorThreadId: 'moderator-thread', outcome: null });
      expect(f.clients.flatMap(({ requests }) => requests.filter(({ method }) => method === 'turn/start'))).toHaveLength(0);
      expect(f.contexts.existing(1, stopped.moderatorContextId!)).toBeNull();
      await f.relays.mutation(1, 'source', () => f.contexts.get(1, 'source').newSession());
    } finally { await f.contexts.stop(); }
  });

  test('failed moderator preparation cleans up without invoking the debate', async () => {
    const f = await fixture({ startThread: async () => { throw new Error('Moderator creation failed'); } });
    try {
      f.relays.start(1, { ...f.request, mode: 'debate', maxRounds: 1 });
      expect(await f.waitState('error')).toMatchObject({ message: 'Moderator creation failed', outcome: null });
      expect(f.stoppedClients).toContain(f.clients[2]!);
      expect(f.clients.flatMap(({ requests }) => requests.filter(({ method }) => method === 'turn/start'))).toHaveLength(0);
      await f.relays.mutation(1, 'target', () => f.contexts.get(1, 'target').newSession());
    } finally { await f.contexts.stop(); }
  });

  test('shutdown waits for moderator preparation and cleanup without starting a turn', async () => {
    const gate = deferred<unknown>();
    const f = await fixture({ startThread: () => gate.promise });
    try {
      f.relays.start(1, { ...f.request, mode: 'debate', maxRounds: 1 });
      let finished = false;
      const shutdown = f.relays.shutdown().then(() => { finished = true; });
      await Promise.resolve();
      expect(finished).toBe(false);
      gate.resolve({ thread: codexThread('moderator-thread') });
      await shutdown;
      expect(f.relays.get(1)?.status).toBe('stopped');
      expect(f.stoppedClients).toContain(f.clients[2]!);
      expect(f.clients.flatMap(({ requests }) => requests.filter(({ method }) => method === 'turn/start'))).toHaveLength(0);
    } finally { await f.contexts.stop(); }
  });

  test('reports invalid consensus output and releases the participating panes', async () => {
    const f = await fixture();
    try {
      f.relays.start(1, { ...f.request, mode: 'consensus', maxRounds: 1 });
      complete(await f.nextTurn(), 'Both of us agree.');
      expect(await f.waitState('error')).toMatchObject({ outcome: null, step: 1 });
      expect(f.events.filter((event) => event.type === 'user-message')).toHaveLength(1);
      await f.relays.mutation(1, 'target', () => f.contexts.get(1, 'target').newSession());
    } finally { await f.contexts.stop(); }
  });

  test('cancels a debate round without starting the next participant', async () => {
    const f = await fixture();
    try {
      f.relays.start(1, { ...f.request, mode: 'debate', maxRounds: 5 });
      complete(await f.nextTurn(), 'First position.');
      const second = await f.nextTurn();
      f.relays.stop(1);
      second.resolve({ turn: { id: second.id } });
      expect(await f.waitState('stopped')).toMatchObject({ mode: 'debate', step: 2, outcome: null });
      expect(f.events.filter((event) => event.type === 'user-message')).toHaveLength(2);
    } finally { await f.contexts.stop(); }
  });

  test('cancels an active moderator synthesis through its own transport and removes the owned context', async () => {
    const f = await fixture();
    try {
      f.relays.start(1, { ...f.request, mode: 'debate', maxRounds: 1 });
      complete(await f.nextTurn(), 'A position');
      complete(await f.nextTurn(), 'B position');
      const synthesis = await f.nextTurn();
      expect(f.relays.get(1)?.speaker).toBe('C');
      f.relays.stop(1);
      synthesis.resolve({ turn: { id: synthesis.id } });
      const stopped = await f.waitState('stopped');
      expect(stopped).toMatchObject({ outcome: null, moderatorThreadId: 'moderator-thread' });
      expect(synthesis.client.requests.filter(({ method }) => method === 'turn/interrupt')).toHaveLength(1);
      expect(f.clients.slice(0, 2).flatMap(({ requests }) => requests.filter(({ method }) => method === 'turn/interrupt'))).toHaveLength(0);
      expect(f.contexts.existing(1, stopped.moderatorContextId!)).toBeNull();
    } finally { await f.contexts.stop(); }
  });

  test('ignores stale completion before the new start acknowledgement', async () => {
    const f = await fixture();
    try {
      f.relays.start(1, f.request);
      const proposal = await f.nextTurn();
      proposal.client.emit('turn/completed', { threadId: 'source-thread', turn: { id: 'previous-turn', status: 'completed', items: [{ id: 'old', type: 'agentMessage', text: 'STALE' }] } });
      complete(proposal, 'CURRENT', true);
      const review = await f.nextTurn();
      expect(prompt(review)).toContain('CURRENT');
      expect(prompt(review)).not.toContain('STALE');
      f.relays.stop(1); review.resolve({ turn: { id: review.id } });
      await f.waitState('stopped');
    } finally { await f.contexts.stop(); }
  });

  test('reserves both panes and cancels a pending start before unlocking', async () => {
    const f = await fixture();
    try {
      f.relays.start(1, f.request);
      const proposal = await f.nextTurn();
      await expectFailure(() => f.relays.mutation(1, 'target', () => f.contexts.get(1, 'target').newSession()), 'Stop the conversation relay before changing this pane.');
      expect(f.relays.stop(1)?.status).toBe('stopping');
      expect(() => f.relays.start(1, f.request)).toThrow('already running or stopping');
      proposal.resolve({ turn: { id: proposal.id } });
      await f.waitState('stopped');
      expect(proposal.client.requests.filter(({ method }) => method === 'turn/interrupt')).toHaveLength(1);
      expect(f.clients.flatMap(({ requests }) => requests.filter(({ method }) => method === 'turn/start'))).toHaveLength(1);
      await f.relays.mutation(1, 'target', () => f.contexts.get(1, 'target').newSession());
    } finally { await f.contexts.stop(); }
  });

  test('the moderator pane stop IPC cancels a relay only once', async () => {
    const f = await fixture();
    try {
      const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
      registerCodexChatIpc({
        ipc: { handle(channel, handler) { handlers.set(channel, handler); } },
        service: (event, contextId) => f.contexts.get(event.sender.id, contextId), relays: f.relays,
        savedTurns: { async list() { return []; }, async save() { throw new Error('Unused'); }, async delete() { throw new Error('Unused'); } },
        assertSender(event) { expect(event.sender.id).toBe(1); },
        async prepareMessage() { throw new Error('Unused'); },
      });
      await f.contexts.get(1, 'moderator').openSession('selected-moderator');
      f.relays.start(1, { ...f.request, mode: 'debate', maxRounds: 1,
        moderatorContextId: 'moderator', moderatorThreadId: 'selected-moderator' });
      const proposal = await f.nextTurn();
      const cancel = handlers.get('cheshi:cancel-codex-chat-response');
      expect(cancel).toBeDefined();
      // Deliberately minimal sender at the injected Electron boundary.
      const event = { sender: { id: 1 } } as IpcMainInvokeEvent;
      expect(await cancel?.(event, 'selected-moderator', 'moderator')).toEqual({ requested: true });
      proposal.resolve({ turn: { id: proposal.id } });
      await f.waitState('stopped');
      expect(proposal.client.requests.filter(({ method }) => method === 'turn/interrupt')).toHaveLength(1);
    } finally { await f.contexts.stop(); }
  });

  test('stays stopping until the interrupt is acknowledged', async () => {
    const interrupt = deferred<unknown>();
    const f = await fixture({ interrupt: () => interrupt.promise });
    try {
      f.relays.start(1, f.request);
      const proposal = await f.nextTurn();
      const started = deferred<void>();
      const remove = f.contexts.get(1, 'source').onEvent((event) => { if (event.type === 'turn-started') started.resolve(); });
      proposal.resolve({ turn: { id: proposal.id } });
      await started.promise; remove();
      expect(f.relays.stop(1)?.status).toBe('stopping');
      await Promise.resolve();
      expect(f.relays.get(1)?.status).toBe('stopping');
      interrupt.resolve({});
      await f.waitState('stopped');
      expect(proposal.client.requests.filter(({ method }) => method === 'turn/interrupt')).toHaveLength(1);
    } finally { await f.contexts.stop(); }
  });

  test('reports interruption failure and allows a later manual cancellation retry', async () => {
    let attempts = 0;
    const f = await fixture({ interrupt: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('Interrupt transport failed');
      return {};
    } });
    try {
      f.relays.start(1, f.request);
      const proposal = await f.nextTurn();
      const started = deferred<void>();
      const source = f.contexts.get(1, 'source');
      const remove = source.onEvent((event) => { if (event.type === 'turn-started') started.resolve(); });
      proposal.resolve({ turn: { id: proposal.id } });
      await started.promise; remove();
      f.relays.stop(1);
      expect((await f.waitState('error')).message).toContain('Could not confirm relay cancellation');
      expect(await source.cancelResponse('source-thread')).toEqual({ requested: true });
      expect(attempts).toBe(2);
    } finally { await f.contexts.stop(); }
  });

  test('reports cancellation failure when stop arrives before the start acknowledgement', async () => {
    let attempts = 0;
    const f = await fixture({ interrupt: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('Pending-start interrupt failed');
      return {};
    } });
    try {
      f.relays.start(1, f.request);
      const proposal = await f.nextTurn();
      expect(f.relays.stop(1)?.status).toBe('stopping');
      proposal.resolve({ turn: { id: proposal.id } });
      expect((await f.waitState('error')).message).toContain('Pending-start interrupt failed');
      const source = f.contexts.get(1, 'source');
      expect(source.getStatus().responseInProgress).toBe(true);
      expect(await source.cancelResponse('source-thread')).toEqual({ requested: true });
      expect(attempts).toBe(2);
    } finally { await f.contexts.stop(); }
  });

  test('renderer disposal stops the old run without deleting a new renderer relay', async () => {
    const f = await fixture();
    try {
      const old = f.relays.start(1, f.request);
      const oldTurn = await f.nextTurn();
      await f.contexts.disposeOwner(1);
      expect(f.relays.get(1)).toBeNull();
      await f.contexts.get(1, 'source').openSession('source-thread');
      await f.contexts.get(1, 'target').openSession('target-thread');
      const current = f.relays.start(1, f.request);
      const currentTurn = await f.nextTurn();
      expect(current.id).not.toBe(old.id);
      oldTurn.resolve({ turn: { id: oldTurn.id } });
      complete(currentTurn, 'CURRENT');
      const review = await f.nextTurn();
      expect(f.relays.get(1)?.id).toBe(current.id);
      expect(f.relays.get(1)?.status).toBe('running');
      f.relays.stop(1); review.resolve({ turn: { id: review.id } });
      await f.waitState('stopped');
    } finally { await f.contexts.stop(); }
  });

  test('does not forward empty, failed or unidentified turns', async () => {
    for (const outcome of ['empty', 'failed', 'no-id', 'no-id-stale']) {
      const f = await fixture();
      try {
        f.relays.start(1, f.request);
        const proposal = await f.nextTurn();
        if (outcome.startsWith('no-id')) {
          proposal.client.emit('turn/completed', { threadId: 'source-thread', turn: { id: 'stale', status: 'completed', items: [{ id: 'old', type: 'agentMessage', text: 'STALE' }] } });
          proposal.resolve({ turn: {} });
        }
        else {
          proposal.client.emit('turn/completed', { threadId: 'source-thread', turn: { id: proposal.id, status: outcome === 'failed' ? 'failed' : 'completed', items: [] } });
          proposal.resolve({ turn: { id: proposal.id } });
        }
        expect((await f.waitState('error')).message).toBeTruthy();
        expect(f.contexts.get(1, 'source').getStatus().responseInProgress).toBe(false);
        expect(f.clients.flatMap(({ requests }) => requests.filter(({ method }) => method === 'turn/start'))).toHaveLength(1);
      } finally { await f.contexts.stop(); }
    }
  });

  test('rejects missing, busy, cross-owner and changing conversations without sending', async () => {
    const f = await fixture();
    try {
      expect(() => f.relays.start(2, f.request)).toThrow('Open all selected');
      expect(() => f.relays.start(1, { ...f.request, targetThreadId: 'wrong' })).toThrow('Open all selected');
      const gate = deferred<void>();
      const mutation = f.relays.mutation(1, 'source', () => gate.promise);
      expect(() => f.relays.start(1, f.request)).toThrow('Wait for all selected');
      gate.resolve(); await mutation;
      expect(f.clients.flatMap(({ requests }) => requests.filter(({ method }) => method === 'turn/start'))).toHaveLength(0);
    } finally { await f.contexts.stop(); }
  });

  test('closing a participating pane stops the relay', async () => {
    const f = await fixture();
    try {
      f.relays.start(1, f.request);
      const proposal = await f.nextTurn();
      await f.contexts.dispose(1, 'target');
      expect(f.relays.get(1)?.status).toBe('stopping');
      proposal.resolve({ turn: { id: proposal.id } });
      expect((await f.waitState('stopped')).step).toBe(1);
    } finally { await f.contexts.stop(); }
  });
});
