import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentStore } from './store.ts';
import { WorkerCollaboration } from './collaboration.ts';
import { closeQuestion } from './question-control.ts';
import { newGoal } from './decision.ts';
import type { CollaborationMessage } from './collaboration-contract.ts';

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const path = mkdtempSync(join(tmpdir(), 'cheshi-question-')); directories.push(path);
  const store = new AgentStore(path), worker = new WorkerCollaboration(store, 'dev');
  const peers = ['planner', 'designer'].map(id => ({ id, name: id, role: 'planning' }));
  const exchange = { peers, rooms: { room: ['dev', 'planner', 'designer'] }, messages: [], acknowledged: [] };
  worker.exchange(exchange);
  const goal = { ...newGoal(true), turns: 3, phase: 'waiting' as const, criteria: [{ criterion: 'Login works', met: false, evidence: '' }] };
  const task = store.create('goal', 'Implement login', { roomId: 'room', goal });
  worker.call(task, 'ask_agent', { agentId: 'planner', requestId: 'policy', question: 'Which credentials?' });
  store.update('goal', { status: 'waiting' });
  const question = store.snapshot().collaboration.outgoing[0]!;
  const close = (recipient: string | null = null) => closeQuestion(store, 'dev', 'goal', 'room', question.id, recipient);
  const reply = (q = question): CollaborationMessage => ({ ...q, id: `reply_${q.id}`, kind: 'reply', from: q.to, to: q.from, text: 'Use email.' });
  return { path, store, worker, exchange, goal, question, close, reply };
}
test('cancellation persists, is idempotent, blocks the goal without weakening it and ignores late replies', () => {
  const f = fixture(); f.close(); f.close();
  const store = new AgentStore(f.path), worker = new WorkerCollaboration(store, 'dev');
  expect(store.task('goal')).toMatchObject({ status: 'interrupted', goal: { ...f.goal, phase: 'blocked' } });
  expect(store.snapshot().collaboration.outgoing).toHaveLength(2);
  worker.exchange({ ...f.exchange, messages: [f.reply()] });
  expect(worker.next()).toBeNull();
  expect(worker.waiting('goal')).toBe(false);
  expect(store.snapshot().collaboration.incoming).toHaveLength(1);
  expect(() => worker.assertVerified(store.task('goal')!)).toThrow('independent verification');
  expect(() => f.close('designer')).toThrow('different action');
});
test('reassignment is atomic, retains budget and scope, and only the replacement answer wakes the owner', () => {
  const f = fixture(); f.close('designer'); f.close('designer');
  const store = new AgentStore(f.path), worker = new WorkerCollaboration(store, 'dev');
  const outgoing = store.snapshot().collaboration.outgoing;
  expect(outgoing).toHaveLength(3);
  const replacement = outgoing[2]!;
  expect(replacement).toMatchObject({ kind: 'question', to: 'designer', roomId: 'room', taskId: 'goal', text: f.question.text });
  expect(replacement.id).not.toBe(f.question.id);
  expect(store.task('goal')?.goal).toEqual(f.goal);
  worker.exchange({ ...f.exchange, messages: [f.reply()] });
  expect(worker.next()).toBeNull(); expect(worker.waiting('goal')).toBe(true);
  const answer = f.reply(replacement);
  worker.exchange({ ...f.exchange, messages: [answer, answer] });
  expect(worker.next()?.messages).toEqual([answer.id]);
  expect(worker.next()?.prompt).toContain('Question reassigned');
  expect(worker.waiting('goal', [answer.id])).toBe(false);
});
test('an answer that wins the race prevents cancellation and reassignment', () => {
  const f = fixture(); f.worker.exchange({ ...f.exchange, messages: [f.reply()] });
  const before = f.store.snapshot();
  expect(() => f.close()).toThrow('already arrived');
  expect(() => f.close('designer')).toThrow('already arrived');
  expect(f.store.snapshot()).toEqual(before);
});
test('invalid targets, scope and exhausted request budget roll back the whole operation', () => {
  const f = fixture();
  for (const target of ['outside', 'dev', 'planner']) expect(() => f.close(target)).toThrow('different invited');
  expect(() => closeQuestion(f.store, 'dev', 'goal', 'foreign', f.question.id, null)).toThrow('Unknown');
  for (let i = 1; i < 16; i++) f.worker.call(f.store.task('goal')!, 'ask_agent', { agentId: 'planner', requestId: `q${i}`, question: 'Help' });
  const before = f.store.snapshot();
  expect(() => f.close('designer')).toThrow('budget');
  expect(f.store.snapshot()).toEqual(before);
  f.close(); // Closing remains possible without allocating another question.
  expect(f.store.task('goal')?.goal?.phase).toBe('waiting');
});
test('recipient does not start cancelled consultations after restart; forged closures fail closed', () => {
  const f = fixture(); f.close();
  const path = mkdtempSync(join(tmpdir(), 'cheshi-recipient-')); directories.push(path);
  const store = new AgentStore(path), peer = new WorkerCollaboration(store, 'planner');
  const outgoing = f.store.snapshot().collaboration.outgoing;
  peer.exchange({ ...f.exchange, messages: outgoing });
  expect(new WorkerCollaboration(new AgentStore(path), 'planner').next()).toBeNull();
  expect(() => peer.exchange({ ...f.exchange, messages: [{ ...outgoing[1]!, id: 'forged', taskId: 'foreign' }] })).toThrow('closure');
});
