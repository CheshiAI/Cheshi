import { expect, test } from 'bun:test';
import { WorkerChangeStream } from '../../experiments/codex-specialists/src/change-stream';
import { watchWorker } from '../lib/agent-orchestration/worker-events.mts';

async function until(condition: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!condition()) { if (Date.now() > deadline) throw new Error('Event was not delivered'); await new Promise(resolve => setTimeout(resolve, 10)); }
}

test('authenticated worker stream delivers changes, resynchronizes after restart, and disconnects cleanly', async () => {
  let events = new WorkerChangeStream(), connections = 0, updates = 0;
  const errors: Error[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0,
    fetch: request => { connections++; return events.handle(request, 'fixture-token'); } });
  const endpoint = `http://127.0.0.1:${server.port}`;
  let stop = () => {};
  try {
    expect((await fetch(`${endpoint}/events`, { method: 'POST' })).status).toBe(401);
    expect((await fetch(`${endpoint}/events`, { method: 'POST', headers: { authorization: 'Bearer fixture-token', origin: 'https://example.com' } })).status).toBe(403);
    connections = 0;
    stop = watchWorker({ endpoint, token: 'fixture-token' }, () => { updates++; }, error => errors.push(error));
    await until(() => updates === 1); events.changed(); await until(() => updates === 2);
    expect(connections).toBe(1);
    events.dispose(); events = new WorkerChangeStream();
    await until(() => connections === 2 && updates === 3); expect(errors).toHaveLength(1);
    events.changed(); await until(() => updates === 4);
    stop(); await new Promise(resolve => setTimeout(resolve, 20));
    events.changed(); expect(updates).toBe(4);
  } finally { stop(); events.dispose(); await server.stop(true); }
});

test('worker watcher rejects external and credential-bearing endpoints before connecting', () => {
  for (const endpoint of ['https://example.com', 'http://localhost:80', 'http://user:pass@127.0.0.1:80', 'http://127.0.0.1:80/path']) {
    expect(() => watchWorker({ endpoint, token: 'test' }, () => {}, () => {})).toThrow('loopback');
  }
});
