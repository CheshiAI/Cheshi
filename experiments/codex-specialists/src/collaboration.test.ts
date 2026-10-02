import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentStore } from './store.ts';
import { WorkerCollaboration } from './collaboration.ts';
import { identifier, type CollaborationMessage } from './collaboration-contract.ts';
const directories: string[] = [];
function setup() {
  const path = mkdtempSync(join(tmpdir(), 'cheshi-collaboration-')); directories.push(path);
  const store = new AgentStore(path), collaboration = new WorkerCollaboration(store, 'dev');
  const peers = [{ id: 'planner', name: 'Planner', role: 'planning' }];
  collaboration.exchange({ peers, messages: [], acknowledged: [] });
  return { path, store, collaboration, peers, task: store.create('login', 'Implement login') };
}
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

test('outgoing questions survive restart and acknowledgements only stop transmission, not waiting', () => {
  const f = setup();
  const response = f.collaboration.call(f.task, 'ask_agent', { agentId: 'planner', requestId: 'policy', question: 'Credentials?' });
  f.store.complete('login', { status: 'waiting', output: 'Validation done', error: null });
  const store = new AgentStore(f.path), restored = new WorkerCollaboration(store, 'dev');
  const outgoing = restored.exchange({ peers: f.peers, messages: [], acknowledged: [] }).outgoing;
  expect(outgoing).toHaveLength(1);
  expect(outgoing[0]!.id).toBe(identifier(response.questionId));
  expect(restored.exchange({ peers: f.peers, messages: [], acknowledged: [response.questionId] }).outgoing).toEqual([]);
  expect(restored.waiting('login')).toBe(true);
  expect(store.task('login')?.status).toBe('waiting');
});

test('inbox identity conflicts and invalid replies roll back the entire exchange', () => {
  const f = setup();
  const q: CollaborationMessage = { id: 'q1', kind: 'question', from: 'planner', to: 'dev', taskId: 'root', questionId: 'q1', text: 'Question' };
  f.collaboration.exchange({ peers: f.peers, messages: [q], acknowledged: [] });
  expect(() => f.collaboration.exchange({ peers: [], messages: [{ ...q, text: 'changed' }], acknowledged: [] })).toThrow('conflict');
  expect(f.store.snapshot().collaboration.peers).toEqual(f.peers);
  expect(() => f.collaboration.exchange({ peers: f.peers, messages: [{ ...q, id: 'r1', kind: 'reply' }], acknowledged: [] })).toThrow('Unsolicited');
  expect(f.store.snapshot().collaboration.incoming).toEqual([q]);
});

test('consultations cannot recursively delegate or reply on behalf of another task', () => {
  const f = setup();
  expect(() => f.collaboration.call({ ...f.task, consultation: 'q' }, 'ask_agent', { agentId: 'planner', requestId: 'q', question: 'More work' })).toThrow('cannot delegate');
  expect(() => f.collaboration.call(f.task, 'reply_agent', { questionId: 'foreign', answer: 'Approved' })).toThrow('this consultation');
  for (let i = 0; i < 16; i++) f.collaboration.call(f.task, 'ask_agent', { agentId: 'planner', requestId: `q${i}`, question: 'Clarification' });
  expect(() => f.collaboration.call(f.task, 'ask_agent', { agentId: 'planner', requestId: 'extra', question: 'More' })).toThrow('budget');
});
