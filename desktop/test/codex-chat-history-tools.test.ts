import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { CodexChatService } from '../lib/codex-chat-service.mts';
import { createFakeCodexClient, codexThread } from './codex-chat-test-helpers.ts';
import { workspaceChatInstructions } from '../lib/workspace-chat-instructions.mts';
import { callHistoryTool } from '../lib/codex-chat-history-tools.mts';

test.each([false, true])('turn context identifies the actual target thread when history tools are enabled: %s', async enabled => {
  const client = createFakeCodexClient({
    'thread/start': { thread: codexThread('actual') },
    'thread/resume': { thread: codexThread('actual') },
    'turn/start': { turn: { id: 'turn-one' } },
    'mcpServerStatus/list': { data: [], nextCursor: null },
  });
  const service = new CodexChatService({ client, cwd: '/workspace/cheshi', serviceName: 'cheshi',
    developerInstructions: workspaceChatInstructions('Cheshi'), historyToolsEnabled: enabled });
  try {
    await service.sendMessage('지난번 포기한 사유는?', 'message-id');
    const sent = client.requests.find(request => request.method === 'turn/start')!;
    if (enabled) expect(sent.params.additionalContext).toMatchObject({ cheshi_history: { kind: 'application', value: expect.stringContaining('actual') } });
    else expect(sent.params.additionalContext).toBeUndefined();
    expect(sent.params.input).toEqual([{ type: 'text', text: '지난번 포기한 사유는?', text_elements: [] }]);
  } finally { await service.stop(); }
});

test('unknown tools cannot invoke recall', async () => {
  let invoked = false;
  const unavailable = async () => { invoked = true; throw new Error('Unexpected call'); };
  let reason: unknown;
  try { await callHistoryTool({ search: unavailable, read: unavailable }, 'unknown', {}, new AbortController().signal); }
  catch (error) { reason = error; }
  expect(reason).toBeInstanceOf(Error);
  expect(invoked).toBe(false);
});

test('recall and MCP modules load under native Node strip-only TypeScript', () => {
  const result = spawnSync('node', ['--input-type=module', '-e',
    "await import('./desktop/lib/chat-history-recall.mts'); await import('./desktop/lib/chat-history-recall-model.mts'); await import('./desktop/lib/workspace-history-mcp.mts'); await import('./desktop/lib/workspace-chat-history.mts');"],
  { cwd: new URL('../..', import.meta.url), encoding: 'utf8' });
  expect(result.status).toBe(0);
  expect(result.stderr).not.toContain('ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX');
});
