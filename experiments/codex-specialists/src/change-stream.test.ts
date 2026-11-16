import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkerChangeStream } from './change-stream';
import { AgentStore } from './store';

test('durable store changes publish sequence notifications; reconnect and restart provide fresh baselines', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cheshi-events-'));
  const events = new WorkerChangeStream(), store = new AgentStore(directory), abort = new AbortController();
  const remove = store.subscribe(() => events.changed());
  const read = async (reader: ReadableStreamDefaultReader<Uint8Array>) => JSON.parse(new TextDecoder().decode((await reader.read()).value));
  const reader = events.response(abort.signal).body!.getReader();
  try {
    const ready = await read(reader); expect(ready).toMatchObject({ kind: 'ready', sequence: 0 });
    store.create('task', 'No model is invoked');
    expect(await read(reader)).toMatchObject({ kind: 'change', sequence: 1, epoch: ready.epoch });
    // Unchanged writes cannot generate work or event feedback loops.
    store.update('task', { status: 'accepted' });
    const reconnect = events.response(new AbortController().signal).body!.getReader();
    expect(await read(reconnect)).toMatchObject({ kind: 'ready', sequence: 1, epoch: ready.epoch }); await reconnect.cancel();
    const restarted = new WorkerChangeStream(); const fresh = restarted.response(new AbortController().signal).body!.getReader();
    expect((await read(fresh)).epoch).not.toBe(ready.epoch); await fresh.cancel(); restarted.dispose();
    abort.abort(); expect((await reader.read()).done).toBe(true);
    expect(new AgentStore(directory).task('task')?.status).toBe('unknown');
  } finally { remove(); abort.abort(); events.dispose(); rmSync(directory, { recursive: true, force: true }); }
});
