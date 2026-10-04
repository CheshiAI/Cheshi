import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentStore } from './store.ts';
import { WorkerConversation } from './conversation.ts';
import { newGoal, validateDecision } from './decision.ts';
import { staleVerification, parseConversation } from './conversation-contract.ts';
import { candidateFixture } from './candidate-verification-fixture.ts';
const directories: string[] = [];
const temporary = () => { const p = mkdtempSync(join(tmpdir(), 'cheshi-conversation-')); directories.push(p); return p; };
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const store = new AgentStore(temporary()), control = new WorkerConversation(store, true);
  store.create('goal', 'Build login', { roomId: 'room', dialogue: { userText: 'Build login', questions: [], revisions: [] },
    goal: { ...newGoal(true), turns: 1, criteria: [{ criterion: 'Login works', met: false, evidence: '' }] } });
  store.update('goal', { status: 'waiting' });
  return { store, control, call: (name: string, args: unknown) => control.call(store.task('goal')!, name, args) };
}
test('requirement changes need the latest actual user input and reset evidence without weakening verification', () => {
  const f = fixture();
  const change = { inputId: 'email', criteria: ['Email login works'], reason: 'User limits login to email' };
  expect(() => f.call('revise_goal', change)).toThrow('latest user input');
  f.store.update('goal', { inputs: [{ id: 'old', prompt: 'Use social login' }, { id: 'email', prompt: 'Email only' }] });
  expect(() => f.call('revise_goal', { ...change, inputId: 'old' })).toThrow('latest user input');
  f.call('revise_goal', change);
  const saved = new AgentStore(f.store.directory).task('goal')!;
  expect(saved.goal).toMatchObject({ verificationRequired: true, criteria: [{ criterion: 'Email login works', met: false, evidence: '' }] });
  expect(saved.dialogue?.revisions).toMatchObject([{ inputId: 'email', source: 'Email only', before: ['Login works'], after: ['Email login works'] }]);
  expect(() => f.call('revise_goal', change)).toThrow('unused');
  expect(() => validateDecision(saved.goal!, { action: 'complete', reason: 'Done', progress: 'Done', nextAction: '', criteria: [{ criterion: 'Easier goal', met: true, evidence: 'Claim' }] }, false)).toThrow('original completion criteria');
});
test('same-room goal selection cannot redirect work to a different room or completed goal', () => {
  const f = fixture();
  f.store.create('intake', 'Email only', { roomId: 'other', dialogue: { userText: 'Email only', questions: [], revisions: [] } });
  expect(() => f.control.call(f.store.task('intake')!, 'continue_goal', { taskId: 'goal', reason: 'Related' })).toThrow('this room');
  f.store.update('intake', { roomId: 'room' }); f.store.update('goal', { status: 'completed' });
  expect(() => f.control.call(f.store.task('intake')!, 'continue_goal', { taskId: 'goal', reason: 'Related' })).toThrow('unfinished');
});
test('changed then reverted criteria cannot reuse an old candidate verification pass', () => {
  const f = candidateFixture(temporary());
  const request = f.requestVerification(); f.observe(request.taskId); f.draft(request.taskId); f.deliver(request.taskId);
  expect(f.inspect().verification?.status).toBe('pass');
  f.store.update('goal', { goal: { ...f.store.task('goal')!.goal!, turns: 1 }, dialogue: { userText: 'Build login', questions: [], revisions: [] }, inputs: [{ id: 'change', prompt: 'Check email login instead' }] });
  const control = new WorkerConversation(f.store, true);
  control.call(f.store.task('goal')!, 'revise_goal', { inputId: 'change', reason: 'New requirement', criteria: ['Email login works'] });
  expect(f.inspect().verification?.status).toBe('stale');
  f.store.update('goal', { inputs: [{ id: 'revert', prompt: 'Restore the original criteria' }] });
  control.call(f.store.task('goal')!, 'revise_goal', { inputId: 'revert', reason: 'User restores original', criteria: ['Candidate is correct'] });
  expect(staleVerification(f.store.task('goal')!, request.message.id)).toBe(true);
  expect(f.inspect().verification?.status).toBe('stale');
});
test('conversation parser rejects nonliteral flags and malformed provenance', () => {
  const d = { userText: 'Request', questions: [], revisions: [] };
  expect(() => parseConversation({ ...d, route: { taskId: 'goal', reason: 'Related', delivered: 'true' } })).toThrow();
  expect(() => parseConversation({ ...d, revisions: [{ inputId: 'input', reason: 'Claim', before: ['A'], after: ['B'], invalidated: [] }] })).toThrow();
});
