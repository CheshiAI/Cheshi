import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentStore, validateTaskId } from './store.ts';

const directories: string[] = [];
function temporary(): string {
  const directory = mkdtempSync(join(tmpdir(), 'cheshi-specialist-store-'));
  directories.push(directory); return directory;
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true }); });

test('persists the thread, artifact, and successful work summary across restart', () => {
  const directory = temporary();
  const store = new AgentStore(directory);
  store.saveThread('native-thread', 'model');
  store.create('review', 'inspect fixture');
  store.complete('review', { status: 'completed', output: 'denominator defect', error: null });
  store.create('stopped', 'follow up');
  store.complete('stopped', { status: 'interrupted', output: 'partial', error: null });
  const restored = new AgentStore(directory);
  expect(restored.snapshot().threadId).toBe('native-thread');
  expect(restored.memory()).toBe('denominator defect');
  expect(restored.task('stopped')?.status).toBe('interrupted');
  expect(JSON.parse(readFileSync(join(directory, 'artifacts', 'review.json'), 'utf8')).output).toBe('denominator defect');
});

test('quarantines unfinished work on restart without replaying it', () => {
  const directory = temporary();
  const store = new AgentStore(directory);
  store.create('accepted', 'pending');
  store.create('running', 'already submitted');
  store.update('running', { status: 'running', threadId: 'thread', turnId: 'turn' });
  const restored = new AgentStore(directory);
  expect(restored.snapshot().tasks.map(task => task.status)).toEqual(['unknown', 'unknown']);
  expect(restored.task('running')?.turnId).toBe('turn');
  expect(restored.memory()).toBe('');
});

test('rejects unsafe artifact ids and corrupt persisted state', () => {
  for (const id of ['../auth', '', 'with space', 'x'.repeat(81)]) {
    expect(() => validateTaskId(id)).toThrow('Invalid task id');
  }
  expect(validateTaskId('safe_id-123')).toBe('safe_id-123');
  const directory = temporary();
  new AgentStore(directory);
  writeFileSync(join(directory, 'state', 'agent.json'), '{"version":2,"tasks":[]}');
  expect(() => new AgentStore(directory)).toThrow('Invalid saved agent state');
});
