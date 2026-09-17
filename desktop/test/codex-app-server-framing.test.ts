import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CodexAppServerClient } from '../lib/codex-app-server-client.mts';

function createClient() {
  return new CodexAppServerClient({
    command: {
      executable: process.execPath,
      args: [fileURLToPath(new URL('./fixtures/codex-framing-server.mts', import.meta.url))],
      environment: {},
    },
    cwd: fileURLToPath(new URL('.', import.meta.url)),
    clientInfo: { name: 'framing-test', title: 'Framing test', version: '1' },
    requestTimeoutMs: 3000,
  });
}

test('native transport preserves Unicode separators and split UTF-8 across LF and CRLF frames', async () => {
  const client = createClient();
  const text = '한글\u2028줄 구분\u2029문단 구분🙂';
  const completed = new Promise<unknown>(resolve => {
    client.onNotification(event => {
      if (event.method === 'fixture/complete') resolve(event.params);
    });
  });
  try {
    assert.deepEqual(await client.request('thread/read'), { text });
    assert.deepEqual(await completed, { text });
    assert.equal(client.ready, true);
  } finally { await client.stop(); }
});

test('stopping discards partial frames and detaches the old stream before restart', async () => {
  const client = createClient();
  const partialReady = new Promise<void>(resolve => {
    client.onNotification(event => {
      if (event.method === 'fixture/partial-ready') resolve();
    });
  });
  try {
    await client.start();
    const oldChild = client.child!;
    const rejected = assert.rejects(client.request('fixture/partial'), { name: 'CodexAppServerStoppedError' });
    await partialReady;
    await client.stop();
    await rejected;
    assert.equal(oldChild.stdout.listenerCount('data'), 0);
    await client.start();
    oldChild.stdout.emit('data', 'invalid stale output\n');
    assert.deepEqual(await client.request('thread/read'), { text: '한글\u2028줄 구분\u2029문단 구분🙂' });
  } finally { await client.stop(); }
});

test('a malformed LF frame still rejects the request and discards later frames', async () => {
  const client = createClient();
  const notifications: string[] = [];
  const failures: Error[] = [];
  client.onNotification(event => notifications.push(String(event.method)));
  client.onDidFail(error => failures.push(error));
  try {
    await assert.rejects(client.request('fixture/malformed'), /returned invalid JSON/);
    await client.stop();
    assert.equal(failures.length, 1);
    assert.deepEqual(notifications, []);
    assert.equal(client.pid, null);
  } finally { await client.stop(); }
});
