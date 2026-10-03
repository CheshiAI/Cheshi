import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentStore } from './store.ts';
import { WorkerCollaboration } from './collaboration.ts';
import { closeQuestion, setQuestionDeadline } from './question-control.ts';
import { newGoal } from './decision.ts';
import { questionDeadline, type CollaborationMessage } from './collaboration-contract.ts';
import { parseQuestionDeadline } from '../../../desktop/shared/agent-question.ts';
import { SpecialistAgent } from './agent.ts';
import type { RpcClient } from './app-server-client.ts';

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const path = mkdtempSync(join(tmpdir(), 'cheshi-expiry-')); directories.push(path);
  let now = Date.now();
  const clock = () => now, advance = (ms: number) => { now += ms; };
  const store = new AgentStore(path), worker = new WorkerCollaboration(store, 'dev', undefined, clock);
  const exchange = { peers: ['planner', 'designer'].map(id => ({ id, name: id, role: 'planning' })),
    rooms: { room: ['dev', 'planner', 'designer'] }, messages: [], acknowledged: [] };
  worker.exchange(exchange);
  const goal = { ...newGoal(true), turns: 3, phase: 'waiting' as const, criteria: [{ criterion: 'Login works', met: false, evidence: '' }] };
  const task = store.create('goal', 'Implement login', { roomId: 'room', goal });
  worker.call(task, 'ask_agent', { agentId: 'planner', requestId: 'policy', question: 'Which credentials?' });
  store.update('goal', { status: 'waiting' });
  const question = store.snapshot().collaboration.outgoing[0]!;
  const deadline = new Date(now + 60_000).toISOString();
  const set = (value: unknown = deadline, id = question.id) => setQuestionDeadline(store, 'dev', 'goal', 'room', id, value, clock());
  const reply = (q = question): CollaborationMessage => ({ ...q, id: `reply_${q.id}`, kind: 'reply', from: q.to, to: q.from, text: 'Use email.' });
  return { path, store, worker, exchange, goal, question, deadline, set, reply, clock, advance };
}
test('deadline is optional, editable, removable and persisted without changing the dispatched question identity', () => {
  const f = fixture(), original = f.store.snapshot().collaboration.outgoing;
  f.worker.expire(); expect(f.store.snapshot().collaboration.questionDeadlines).toBeUndefined();
  f.set(); f.set();
  const changed = new Date(f.clock() + 120_000).toISOString(); f.set(changed);
  expect(new AgentStore(f.path).snapshot().collaboration.questionDeadlines?.[f.question.id]).toBe(changed);
  f.set(null); f.advance(180_000); f.worker.expire();
  expect(f.store.snapshot().collaboration.outgoing).toEqual(original);
  expect(f.store.task('goal')?.goal).toEqual(f.goal);
});
test.each([-1, 0, 1])('owner receipt at deadline offset %s determines acceptance atomically', offset => {
  const f = fixture(); f.set(); f.advance(60_000 + offset);
  f.worker.exchange({ ...f.exchange, messages: [f.reply()] });
  f.advance(120_000); // A timely receipt remains valid even if execution is delayed.
  const next = f.worker.next(), c = f.store.snapshot().collaboration;
  expect(c.incoming).toHaveLength(1);
  expect(c.outgoing.filter(m => m.closureReason === 'expired')).toHaveLength(offset < 0 ? 0 : 1);
  if (offset < 0) expect(next?.messages).toEqual([f.reply().id]);
  else {
    expect(next).toBeNull(); expect(c.consumed).toEqual([]);
    expect(f.store.task('goal')).toMatchObject({ status: 'interrupted', goal: { ...f.goal, phase: 'blocked' } });
    f.worker.exchange({ ...f.exchange, messages: [f.reply()] }); f.worker.expire();
    expect(f.store.snapshot().collaboration).toEqual(c);
  }
});
test('restart and normal agent pump expire overdue questions without model calls; late receipt never resumes', () => {
  const f = fixture(); f.set(); f.advance(60_000);
  const store = new AgentStore(f.path), collaboration = new WorkerCollaboration(store, 'dev', undefined, f.clock);
  let requests = 0;
  const client: RpcClient = { request: async () => { requests++; throw new Error('No model call expected'); },
    subscribe: () => () => {}, onFailure: () => () => {}, handleTools: () => {} };
  const agent = new SpecialistAgent({ store, collaboration, client, workspace: '/workspace', profile: '' });
  agent.pump();
  expect(store.task('goal')?.goal?.phase).toBe('blocked');
  collaboration.exchange({ ...f.exchange, messages: [f.reply()] }); agent.pump(); agent.pump();
  expect(requests).toBe(0); expect(agent.busy).toBe(false);
  expect(new AgentStore(f.path).snapshot().collaboration.outgoing.filter(m => m.closureReason === 'expired')).toHaveLength(1);
  expect(() => collaboration.assertVerified(store.task('goal')!)).toThrow('independent verification');
});
test('expiry leaves other pending work intact and its answer can resume the goal', () => {
  const f = fixture(); f.set();
  f.worker.call(f.store.task('goal')!, 'ask_agent', { agentId: 'designer', requestId: 'layout', question: 'Which layout?' });
  const second = f.store.snapshot().collaboration.outgoing[1]!;
  f.advance(60_000); f.worker.expire();
  expect(f.store.task('goal')?.goal).toEqual(f.goal);
  f.worker.exchange({ ...f.exchange, messages: [f.reply(), f.reply(second)] });
  expect(f.worker.next()?.messages).toEqual([f.reply(second).id]);
  expect(f.worker.waiting('goal', [f.reply(second).id])).toBe(false);
});
test.each(['running', 'unknown'] as const)('expiry does not overwrite %s execution or authorize automatic replay', status => {
  const f = fixture(); f.set(); f.store.update('goal', { status, goal: { ...f.goal, phase: 'active' } });
  f.advance(60_000); f.worker.expire();
  expect(f.store.task('goal')).toMatchObject({ status, goal: { ...f.goal, phase: 'active' } });
  expect(f.worker.next()).toBeNull();
  if (status === 'running') {
    f.store.update('goal', { status: 'waiting', goal: f.goal }); f.worker.expire();
    expect(f.store.task('goal')?.goal?.phase).toBe('blocked');
  }
});
test('expired, answered, foreign and invalid deadlines cannot revive or alter a question', () => {
  const f = fixture(), before = f.store.snapshot();
  for (const invalid of [undefined, true, 1, '', 'tomorrow', '2026-02-30T00:00:00.000Z', '2026-10-03T00:00:00+09:00']) {
    expect(() => setQuestionDeadline(f.store, 'dev', 'goal', 'room', f.question.id, invalid, f.clock())).toThrow();
    expect(() => questionDeadline(invalid)).toThrow(); expect(() => parseQuestionDeadline(invalid)).toThrow();
  }
  expect(() => f.set(new Date(f.clock()).toISOString())).toThrow('future');
  expect(() => setQuestionDeadline(f.store, 'dev', 'goal', 'other', f.question.id, f.deadline, f.clock())).toThrow('Unknown');
  expect(f.store.snapshot()).toEqual(before);
  f.set(); f.advance(60_000);
  expect(() => f.set(null)).toThrow('closed');
  expect(() => f.set(new Date(f.clock() + 60_000).toISOString())).toThrow('closed');
  expect(f.store.task('goal')?.goal?.phase).toBe('blocked');
  const answered = fixture(); answered.worker.exchange({ ...answered.exchange, messages: [answered.reply()] });
  expect(() => answered.set()).toThrow('already arrived');
});
test('reassignment inherits the remaining deadline; recipient restart skips an expired consultation', () => {
  const f = fixture(); f.set(); closeQuestion(f.store, 'dev', 'goal', 'room', f.question.id, 'designer');
  const replacement = f.store.snapshot().collaboration.outgoing[2]!;
  expect(f.store.snapshot().collaboration.questionDeadlines?.[replacement.id]).toBe(f.deadline);
  f.advance(60_000); f.worker.expire();
  const path = mkdtempSync(join(tmpdir(), 'cheshi-expired-peer-')); directories.push(path);
  const peer = new WorkerCollaboration(new AgentStore(path), 'designer');
  peer.exchange({ ...f.exchange, messages: f.store.snapshot().collaboration.outgoing.filter(m => m.to === 'designer') });
  expect(new WorkerCollaboration(new AgentStore(path), 'designer').next()).toBeNull();
});
