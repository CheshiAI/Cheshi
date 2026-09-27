import { expect, test } from 'bun:test';
import { assertPortOwner, listenerPids, locateMainProcess } from '../scripts/inspect-desktop.mts';
import { InspectorClient } from '../scripts/inspector-client.mts';

test('only the exact checkout main process is selected, including paths with spaces', () => {
  const root = '/tmp/project with spaces';
  const exe = `${root}/desktop/.development/Cheshi Development.app/Contents/MacOS/Electron`;
  const rows = [`100 ${exe} ${root}/`, `101 ${exe} language-server.mts`,
    `102 /tmp/other/desktop/.development/Cheshi Development.app/Contents/MacOS/Electron /tmp/other/`];
  expect(locateMainProcess(rows.join('\n'), root)).toBe(100);
  expect(() => locateMainProcess(rows.slice(1).join('\n'), root)).toThrow('found 0');
  expect(() => locateMainProcess([...rows, `103 ${exe} ${root}`].join('\n'), root)).toThrow('found 2');
});

test('listener ownership must be exclusive to the selected app', () => {
  expect(listenerPids('p10\nn127.0.0.1:9229\np10\np20\n')).toEqual([10, 20]);
  expect(() => assertPortOwner([], 10)).toThrow();
  expect(() => assertPortOwner([20], 10)).toThrow();
  expect(() => assertPortOwner([10, 20], 10)).toThrow();
  expect(() => assertPortOwner([10], 10)).not.toThrow();
});

async function rejects(operation: Promise<unknown>, message: string) {
  let failure: unknown;
  try { await operation; } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain(message);
}

test('transport correlates responses, reports protocol and evaluation failures, and times out', async () => {
  const server = Bun.serve<{ connected: true }>({
    hostname: '127.0.0.1', port: 0,
    fetch(request, server) { return server.upgrade(request, { data: { connected: true } }) ? undefined : new Response('no', { status: 400 }); },
    websocket: {
      message(socket, message) {
        const request = JSON.parse(String(message)) as { id: number; method: string; params: { expression?: string } };
        if (request.method === 'hang') return;
        if (request.method === 'fail') { socket.send(JSON.stringify({ id: request.id, error: { message: 'protocol failure' } })); return; }
        const result = request.params.expression === 'throw'
          ? { exceptionDetails: { text: 'renderer failure' } } : { result: { value: request.params.expression } };
        setTimeout(() => socket.send(JSON.stringify({ id: request.id, result })), request.params.expression === 'slow' ? 30 : 0);
      },
    },
  });
  const client = await InspectorClient.connect(`ws://127.0.0.1:${server.port}`);
  try {
    expect(await Promise.all([client.evaluate('slow'), client.evaluate('fast')])).toEqual(['slow', 'fast']);
    await rejects(client.evaluate('throw'), 'renderer failure');
    await rejects(client.send('fail', {}, 1000), 'protocol failure');
    await rejects(client.send('hang', {}, 20), 'timed out');
    const pending = client.send('hang', {}, 1000);
    client.close();
    await rejects(pending, 'closed');
  } finally { client.close(); await server.stop(true); }
});
