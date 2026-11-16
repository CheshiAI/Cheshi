import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { withLocalHistoryLock } from '../lib/local-history-lock.mts';

assert.ok(process.versions.electron, 'This regression must run in Electron');
const directory = process.argv[2];
assert.ok(directory, 'A temporary lock directory is required');

let active = 0;
let completed = 0;
await Promise.all(Array.from({ length: 12 }, () => withLocalHistoryLock(directory, async () => {
  assert.equal(++active, 1, 'Only one writer may enter the critical section');
  await delay(2);
  active--;
  completed++;
})));
assert.equal(completed, 12);

await assert.rejects(withLocalHistoryLock(directory, async () => {
  throw new Error('Expected operation failure');
}), /Expected operation failure/);
assert.equal(await withLocalHistoryLock(directory, async () => 'recovered'), 'recovered');
console.log('Electron SQLite locking passed');
