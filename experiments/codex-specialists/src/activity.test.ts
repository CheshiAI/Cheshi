import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentStore } from './store.ts';
import { projectTaskActivities, recordTaskActivity } from './activity.ts';
import { parseTaskActivities } from './activity-contract.ts';
import { TurnObserver } from './turn.ts';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'cheshi-activity-')); directories.push(directory);
  const store = new AgentStore(directory); store.create('task', 'Build login', { roomId: 'room' });
  const observer = new TurnObserver((method, item, turnId) => recordTaskActivity(store, 'task', method, item, turnId));
  return { directory, store, observer };
}

test('captures scoped public messages and commands before acknowledgement, updates once and survives restart', async () => {
  const { directory, store, observer } = fixture();
  const emit = (method: string, item: Record<string, unknown>, threadId = 'thread') => observer.receive({ method, params: { threadId, turnId: 'turn', item } });
  emit('item/completed', { id: 'private', type: 'agentMessage', text: 'OTHER_TASK' }, 'other');
  emit('item/completed', { id: 'reason', type: 'reasoning', text: 'PRIVATE_REASONING' });
  emit('item/completed', { id: 'intro', type: 'agentMessage', phase: 'commentary', text: 'Implementing email login' });
  emit('item/started', { id: 'cmd', type: 'commandExecution', command: 'bun test' });
  observer.identify('thread', 'turn');
  const started = store.task('task')!.activity![1]!;
  expect(started.status).toBe('running');
  const command = { id: 'cmd', type: 'commandExecution', command: 'bun test', status: 'completed', exitCode: 1, aggregatedOutput: '1 test failed' };
  emit('item/completed', command); emit('item/completed', command);
  observer.receive({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'completed', items: [command,
    { id: 'final', type: 'agentMessage', phase: 'final_answer', text: 'Fix needed' }] } } });
  const result = await observer.result;
  expect(result.output).toBe('Fix needed');
  const activity = new AgentStore(directory).task('task')!.activity!;
  expect(activity).toHaveLength(3);
  expect(activity[1]).toMatchObject({ id: started.id, createdAt: started.createdAt, status: 'failed', text: '1 test failed' });
  expect(activity[2]).toMatchObject({ final: true, text: 'Fix needed' });
  expect(JSON.stringify(activity)).not.toContain('PRIVATE'); expect(JSON.stringify(activity)).not.toContain('OTHER_TASK');
  expect(parseTaskActivities(activity)).toEqual(activity);
});

test('turn identity prevents reused item ids from replacing earlier execution and lost completions stay unknown', () => {
  const { store } = fixture();
  for (const turn of ['one', 'two']) recordTaskActivity(store, 'task', 'item/started', { type: 'commandExecution', id: 'cmd', command: 'check' }, turn);
  store.complete('task', { status: 'interrupted', output: '', error: null });
  expect(store.task('task')!.activity!.map(item => item.status)).toEqual(['unknown', 'unknown']);
  expect(new Set(store.task('task')!.activity!.map(item => item.id)).size).toBe(2);
});

test('bounded excerpts preserve explicit truncation and inspection transport budgets', () => {
  const { store } = fixture();
  recordTaskActivity(store, 'task', 'item/completed', { type: 'fileChange', id: 'file', status: 'completed',
    changes: [{ path: 'login.ts', diff: '+'.repeat(20000) }] }, 'turn');
  const task = store.task('task')!;
  expect(task.activity![0]?.truncated).toBe(true); expect(task.activity![0]?.text.length).toBe(16000);
  const tasks = Array.from({ length: 100 }, (_, i) => ({ ...task, id: String(i) }));
  const projected = projectTaskActivities(tasks);
  expect(Buffer.byteLength(JSON.stringify(projected.map(t => t.activity)))).toBeLessThan(520000);
  expect(projected[0]?.activityTruncated).toBe(true); expect(projected.at(-1)?.activity).toHaveLength(1);
  expect(() => parseTaskActivities([{ ...task.activity![0], final: 'yes' }])).toThrow();
});


test('a restarted worker keeps unfinished execution cards unknown without replaying them', () => {
  const { directory, store } = fixture();
  store.update('task', { status: 'running' });
  recordTaskActivity(store, 'task', 'item/started', { type: 'commandExecution', id: 'cmd', command: 'check' }, 'turn');
  const task = new AgentStore(directory).task('task')!;
  expect(task.status).toBe('unknown');
  expect(task.activity).toHaveLength(1);
  expect(task.activity![0]?.status).toBe('unknown');
});

test('file changes retain kinds, rename destinations and diffs through restart and contract parsing', () => {
  const { directory, store } = fixture();
  recordTaskActivity(store, 'task', 'item/completed', { type: 'fileChange', id: 'files', status: 'completed', changes: [
    { path: '/workspace/new.ts', kind: { type: 'add' }, diff: '+new' },
    { path: '/workspace/old.ts', kind: { type: 'delete' }, diff: '-old' },
    { path: '/workspace/before.ts', kind: { type: 'update', move_path: '/workspace/after.ts' }, diff: '@@ -1 +1 @@\n-old\n+new' },
  ] }, 'turn');
  const saved = new AgentStore(directory).task('task')!.activity!;
  const parsed = parseTaskActivities(saved);
  expect(parsed).toEqual(saved);
  expect(parsed[0]!.changes?.map(change => change.kind)).toEqual(['add', 'delete', 'update']);
  expect(parsed[0]!.changes?.[2]?.movePath).toBe('/workspace/after.ts');
  expect(parsed[0]!.changes?.[2]?.diff).toContain('+new');
});

test('structured file payloads are bounded, incomplete lines omitted, legacy records still parse', () => {
  const { store } = fixture();
  recordTaskActivity(store, 'task', 'item/completed', { type: 'fileChange', id: 'large', changes: [
    { path: 'a.ts', kind: 'update', diff: '@@ -1 +1 @@\n-old\n+' + 'x'.repeat(20000) },
  ] }, 'turn');
  const saved = store.task('task')!.activity![0]!;
  expect(saved.truncated).toBe(true);
  expect(saved.changes![0]!.diff).toBe('@@ -1 +1 @@\n-old\n');
  expect(parseTaskActivities([saved])[0]!.changes).toEqual(saved.changes);
  const { changes, ...legacy } = saved;
  expect(parseTaskActivities([legacy])).toEqual([legacy]);
  for (const invalid of [
    [{ path: 'a', kind: 'update', diff: 'x'.repeat(16000), movePath: null }],
    [{ path: 'a', kind: 'invalid', diff: '', movePath: null }],
    Array.from({ length: 101 }, () => ({ path: 'a', kind: 'update', diff: '', movePath: null })),
  ]) expect(() => parseTaskActivities([{ ...saved, changes: invalid }])).toThrow();
  recordTaskActivity(store, 'task', 'item/completed', { type: 'fileChange', id: 'many', changes:
    Array.from({ length: 101 }, (_, i) => ({ path: `${i}.ts`, kind: 'add', diff: '+x' })) }, 'turn');
  expect(store.task('task')!.activity![1]!.changes).toHaveLength(100);
  expect(store.task('task')!.activity![1]!.truncated).toBe(true);
});
