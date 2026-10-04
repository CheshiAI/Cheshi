import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerLifecycle } from '../lib/agent-management/lifecycle.mts';
import { createAgentOrchestration } from '../lib/agent-orchestration/service.mts';
import { bindingFor, type Message, type Binding } from '../lib/agent-orchestration/mailbox.mts';
import type { AgentDetails } from '../shared/agent-management.ts';

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
