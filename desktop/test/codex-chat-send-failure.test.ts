import { expect, test } from 'bun:test';
import { CodexAppServerClient } from '../lib/codex-app-server-client.mts';
import { codexThread, createCodexChatService, createFakeCodexClient } from './codex-chat-test-helpers';

async function failure(operation: Promise<unknown>): Promise<Error> {
  try { await operation; } catch (error) {
    if (error instanceof Error) return error;
    throw new Error('Expected an Error rejection.');
  }
  throw new Error('Expected the send to fail.');
}

test('marks preflight and explicit server rejections as definitely not sent', async () => {
  const rejected = new Error('Request rejected');
  rejected.name = 'CodexRequestRejectedError';
  const client = createFakeCodexClient({ 'thread/start': { thread: codexThread('thread') }, 'turn/start': rejected });
  const service = createCodexChatService(client);
  try {
    expect((await failure(service.sendMessage('', 'client'))).name).toBe('CodexMessageNotSent');
    expect(client.requests).toHaveLength(0);
    expect((await failure(service.sendMessage('Hello', 'client'))).name).toBe('CodexMessageNotSent');
    expect(client.requests.at(-1)?.method).toBe('turn/start');
  } finally { service.stop(); }
});

test('marks timeout and malformed turn acknowledgements as uncertain', async () => {
  for (const response of [new Error('Connection lost'), { turn: {} }]) {
    const service = createCodexChatService(createFakeCodexClient({
      'thread/start': { thread: codexThread('thread') }, 'turn/start': response,
    }));
    try {
      expect((await failure(service.sendMessage('Hello', 'client'))).name).toBe('CodexMessageDeliveryUnknown');
    } finally { service.stop(); }
  }
});

test('tags only JSON RPC error responses as explicit server rejections without starting a process', () => {
  const client = new CodexAppServerClient({ command: { executable: 'unused', args: [], environment: {} },
    cwd: '/workspace', clientInfo: { name: 'test', title: 'Test', version: '1' } });
  const captured: unknown[] = [];
  client.requests.reject = (_id, error) => { captured.push(error); return true; };
  client.handleLine(JSON.stringify({ id: 1, error: { code: -32602, message: 'Bad input' } }));
  const error = captured[0];
  if (!(error instanceof Error)) throw new Error('Expected the server rejection to be an Error.');
  expect(error.name).toBe('CodexRequestRejectedError');
  expect(error.message).toBe('Bad input');
});
