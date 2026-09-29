import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { spawn } from 'node:child_process';
import { watchAppleCalendar } from '../lib/apple-calendar-watch.mts';
import { createSchedulerTestClock } from './scheduler-test-clock';

function fixture() {
  const clock = createSchedulerTestClock();
  const processes: ReturnType<typeof child>[] = [];
  let changes = 0; let clockChanges = 0; const errors: string[] = [];
  function child() {
    const process = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      kill() { queueMicrotask(() => process.emit('close', null)); return true; } });
    process.stdin.once('finish', () => queueMicrotask(() => process.emit('close', 0)));
    return process;
  }
  const spawnProcess = ((file: string, args: string[]) => {
    expect(file).toBe('/test/calendar'); expect(args).toEqual(['--watch']);
    const process = child(); processes.push(process); return process;
  }) as unknown as typeof spawn;
  const watcher = watchAppleCalendar({ executable: '/test/calendar', spawnProcess, schedule: clock.schedule,
    changed() { changes++; }, clockChanged() { clockChanges++; }, error: message => errors.push(message) });
  return { watcher, clock, processes, errors, changes: () => changes, clockChanges: () => clockChanges };
}
test('one idle observer accepts fragmented change frames and stops on parent pipe closure', async () => {
  const value = fixture();
  value.processes[0]!.stdout.write('rea'); expect(value.changes()).toBe(0);
  value.processes[0]!.stdout.write('dy\nchanged\nclock-changed\n');
  expect(value.changes()).toBe(2); expect(value.clockChanges()).toBe(1); expect(value.clock.timers.size).toBe(0);
  await value.clock.advance(86_400_000); expect(value.processes).toHaveLength(1);
  await value.watcher.stop(); expect(value.clock.timers.size).toBe(0);
  value.processes[0]!.stdout.write('changed\n'); expect(value.changes()).toBe(2);
});
test('transport failure retries with bounded backoff, then stops instead of polling forever', async () => {
  const value = fixture();
  for (let attempt = 0; attempt < 6; attempt++) {
    value.processes[attempt]!.stdout.write('unexpected\n'); await Promise.resolve();
    if (attempt < 5) await value.clock.advance(1000 * 2 ** attempt);
  }
  expect(value.processes).toHaveLength(6); expect(value.clock.timers.size).toBe(0);
  expect(value.errors.at(-1)).toContain('disconnected'); await value.watcher.stop();
});
test('a helper that never becomes ready times out and shutdown cancels reconnect', async () => {
  const value = fixture(); await value.clock.advance(10_000);
  expect(value.errors.at(-1)).toContain('disconnected');
  await value.watcher.stop(); await value.clock.advance(60_000);
  expect(value.processes).toHaveLength(1); expect(value.clock.timers.size).toBe(0);
});
