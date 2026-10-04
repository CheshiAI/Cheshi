import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerLifecycle } from '../lib/agent-management/lifecycle.mts';
import { createAgentOrchestration } from '../lib/agent-orchestration/service.mts';
import { bindingFor, type Message, type Binding } from '../lib/agent-orchestration/mailbox.mts';
import type { AgentDetails } from '../shared/agent-management.ts';

test('recovered Docker inspection stops deadline-driven exchanges until the next worker event', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cheshi-recovered-routing-'));
  const binding = bindingFor('/workspace', 'docker:test', 'dev', 'account');
  const connection = { endpoint: 'dev', token: 'fixture' };
  const details: AgentDetails = { agent: { id: 'dev', name: 'Dev', state: 'running', image: 'fixture' },
    ready: true, busy: true, authenticated: true, threadId: null, tasks: [], logs: '', error: null };
  let now = Date.now() - 30001, unavailable = false, inspections = 0, exchanges = 0;
  let changed = () => {};
  const lifecycle = new WorkerLifecycle({ filename: join(directory, 'lifecycle.json'), now: () => now,
    inspect: async () => { inspections++; if (unavailable) throw new Error('Temporary Docker failure'); return { connection, details }; },
    start: async () => { throw new Error('Must not restart the running worker'); },
    stopped: async () => false, demand: () => false,
    control: async () => ({ protocol: 1, idle: false, nextWakeAt: null }),
  });
  const coordinator = createAgentOrchestration({ filename: join(directory, 'mailbox.json'),
    peer: () => ({ id: 'dev', name: 'Dev', role: 'development' }),
    around: (b, operation) => lifecycle.exclusive(b, operation),
    connect: (b, demand) => lifecycle.connection(b, demand),
    rest: (b, c, busy) => lifecycle.rest(b, c, busy), nextCheck: b => lifecycle.nextCheck(b),
    watch: (_connection, notify) => { changed = notify; return () => {}; },
    exchange: async () => { exchanges++; return { protocol: 1, received: [], outgoing: [] }; },
  });
  try {
    await lifecycle.connection(binding, false);
    unavailable = true;
    let failure: unknown;
    try { await lifecycle.connection(binding, false); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    unavailable = false; now = Date.now(); inspections = 0;
    coordinator.register(binding); coordinator.start(); await coordinator.settled();
    expect(inspections).toBe(1); expect(exchanges).toBe(1);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(inspections).toBe(1); expect(exchanges).toBe(1);
    expect(coordinator.error(binding.id)).toBeNull();
    changed(); await coordinator.settled();
    expect(inspections).toBe(2); expect(exchanges).toBe(2);
    expect(lifecycle.nextCheck(binding)).toBeNull();
  } finally { await coordinator.dispose(); rmSync(directory, { recursive: true, force: true }); }
});

test('three participant routing wakes only recipients and a sleeping owner receives consultation and verification results after host restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cheshi-idle-routing-'));
  const peers = [{ id: 'dev', name: 'Dev', role: 'development' }, { id: 'planner', name: 'Planner', role: 'planning' }, { id: 'verifier', name: 'Verifier', role: 'verification' }];
  const bindings = peers.map(p => bindingFor('/workspace', 'docker:test', p.id, 'account'));
  const running = new Set<string>(), starts: string[] = [], delivered: Message[] = [];
  const outgoing = new Map<string, Message[]>(peers.map(p => [p.id, []]));
  let now = 0, answer = false, verify = false;
  const question: Message = { id: 'question', questionId: 'question', taskId: 'login', kind: 'question', from: 'dev', to: 'planner', text: 'Which credentials?' };
  const request: Message = { id: 'verify', questionId: 'verify', taskId: 'login', kind: 'verification_request', from: 'dev', to: 'verifier', text: '{"criteria":["Login"]}' };
  const live = (b: Binding) => ({ connection: { endpoint: b.agentId, token: 'fixture' }, details: {
    agent: { id: b.agentId, state: 'running', name: b.agentId, image: 'fixture' }, ready: true, busy: false, authenticated: true,
    threadId: null, tasks: [], logs: '', error: null,
  } satisfies AgentDetails });
  let lifecycle: WorkerLifecycle;
  const create = () => {
    const coordinator = createAgentOrchestration({ filename: join(directory, 'mailbox.json'), peer: b => peers.find(p => p.id === b.agentId) ?? null,
      rooms: { bindings: () => bindings, roster: () => ({}), allowed: () => true, record: () => {} },
      around: (b, fn) => lifecycle.exclusive(b, fn), connect: (b, demand) => lifecycle.connection(b, demand),
      rest: (b, c, busy) => lifecycle.rest(b, c, busy),
      exchange: async (c, value) => {
        const input = value as { messages: Message[]; acknowledged: string[] };
        for (const m of input.messages) if (!delivered.some(d => d.id === m.id)) delivered.push(m);
        const messages = outgoing.get(c.endpoint)!;
        if (c.endpoint === 'planner' && answer && delivered.some(m => m.id === 'question') && !messages.length) {
          messages.push({ ...question, id: 'answer', kind: 'reply', from: 'planner', to: 'dev', text: 'Email only.' });
        }
        if (c.endpoint === 'dev' && delivered.some(m => m.id === 'answer') && !messages.some(m => m.id === 'verify')) messages.push(request);
        if (c.endpoint === 'verifier' && verify && delivered.some(m => m.id === 'verify') && !messages.length) {
          messages.push({ ...request, id: 'verified', kind: 'verification_result', from: 'verifier', to: 'dev', text: '{"verdicts":[]}' });
        }
        return { protocol: 1, received: input.messages.map(m => m.id), outgoing: messages.filter(m => !input.acknowledged.includes(m.id)) };
      } });
    lifecycle = new WorkerLifecycle({ filename: join(directory, 'lifecycle.json'), now: () => now,
      inspect: async b => running.has(b.agentId) ? live(b) : null,
      start: async b => { running.add(b.agentId); starts.push(b.agentId); return live(b); },
      stopped: async b => !running.has(b.agentId), demand: b => coordinator.pending(b),
      control: async (c, action) => { if (action === 'commit') running.delete(c.endpoint); return {
        protocol: 1, idle: c.endpoint === 'dev', nextWakeAt: null, lease: 'lease',
      }; } });
    return coordinator;
  };
  let coordinator = create();
  try {
    await coordinator.tick(); expect(starts).toEqual([]);
    await lifecycle!.exclusive(bindings[0]!, () => lifecycle!.connection(bindings[0]!, true));
    outgoing.get('dev')!.push(question);
    await coordinator.tick(); await coordinator.tick();
    expect(starts).toEqual(['dev', 'planner']); expect(delivered.map(m => m.id)).toEqual(['question']);
    now = 300000; await coordinator.tick(); expect(running.has('dev')).toBe(false);
    await coordinator.dispose(); coordinator = create(); answer = true;
    await coordinator.tick(); await coordinator.tick();
    expect(starts.filter(id => id === 'dev')).toHaveLength(2); expect(starts).toContain('verifier');
    verify = true; await coordinator.tick(); await coordinator.tick();
    expect(delivered.map(m => m.id)).toEqual(['question', 'answer', 'verify', 'verified']);
    expect(starts).toEqual(['dev', 'planner', 'dev', 'verifier']);
    expect(coordinator.error(bindings[0]!.id)).toBeNull();
  } finally { await coordinator.dispose(); rmSync(directory, { recursive: true, force: true }); }
});

test('event-driven collaboration wakes only the question recipient and restores a sleeping owner after coordinator restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cheshi-event-routing-'));
  const peers = [{ id: 'dev', name: 'Dev', role: 'development' }, { id: 'planner', name: 'Planner', role: 'planning' }, { id: 'verifier', name: 'Verifier', role: 'verification' }];
  const bindings = peers.map(p => bindingFor('/workspace', 'docker:test', p.id, 'account'));
  const running = new Set(['dev']), starts: string[] = [], callbacks = new Map<string, () => void>();
  const outgoing = new Map<string, Message[]>(peers.map(p => [p.id, []]));
  const delivered = new Map<string, Message>(); let exchanges = 0;
  const create = () => createAgentOrchestration({ filename: join(directory, 'mailbox.json'),
    peer: b => peers.find(p => p.id === b.agentId) ?? null,
    rooms: { bindings: () => bindings, roster: () => ({}), allowed: () => true, record: () => {} },
    watch: (c, changed) => { callbacks.set(c.endpoint, changed); return () => { callbacks.delete(c.endpoint); }; },
    connect: async (b, demand) => {
      if (!running.has(b.agentId) && demand) { running.add(b.agentId); starts.push(b.agentId); }
      return running.has(b.agentId) ? { endpoint: b.agentId, token: 'test' } : null;
    },
    exchange: async (c, value) => {
      exchanges++;
      const input = value as { messages: Message[]; acknowledged: string[] };
      for (const m of input.messages) delivered.set(m.id, m);
      return { protocol: 1, received: input.messages.map(m => m.id), outgoing: outgoing.get(c.endpoint)!.filter(m => !input.acknowledged.includes(m.id)) };
    },
  });
  let service = create();
  try {
    service.start(); await service.settled(); expect(starts).toEqual([]);
    const question: Message = { id: 'question', questionId: 'question', taskId: 'goal', kind: 'question', from: 'dev', to: 'planner', text: 'Email only?' };
    outgoing.get('dev')!.push(question); callbacks.get('dev')!(); await service.settled();
    expect(starts).toEqual(['planner']); expect([...delivered.keys()]).toEqual(['question']);
    const stable = exchanges; await new Promise(resolve => setTimeout(resolve, 2100)); expect(exchanges).toBe(stable);
    running.delete('dev'); await service.dispose(); expect(callbacks.size).toBe(0);
    service = create(); service.start(); await service.settled();
    outgoing.get('planner')!.push({ ...question, id: 'reply', kind: 'reply', from: 'planner', to: 'dev', text: 'Yes, email only.' });
    callbacks.get('planner')!(); await service.settled();
    expect(starts).toEqual(['planner', 'dev']); expect([...delivered.keys()]).toEqual(['question', 'reply']);
    const count = delivered.size; callbacks.get('planner')!(); await service.settled(); expect(delivered.size).toBe(count);
    expect(running.has('verifier')).toBe(false);
  } finally { await service.dispose(); rmSync(directory, { recursive: true, force: true }); }
});
