import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { CodexChatService } from '../lib/codex-chat-service.mts';
import { createFakeCodexClient, codexThread } from './codex-chat-test-helpers.ts';
import { workspaceChatInstructions } from '../lib/workspace-chat-instructions.mts';
import { workspaceChatServiceOptions } from '../lib/workspace-chat-service-options.mts';
import { createWorkspaceChatHistory } from '../lib/workspace-chat-history.mts';

test('session turns retain user input without legacy recall instructions or additional context', async () => {
  const client = createFakeCodexClient({
    'thread/start': { thread: codexThread('actual') },
    'thread/resume': { thread: codexThread('actual') },
    'turn/start': { turn: { id: 'turn-one' } },
    'mcpServerStatus/list': { data: [], nextCursor: null },
  });
  const service = new CodexChatService({ client, ...workspaceChatServiceOptions('/workspace/cheshi', undefined, undefined) });
  try {
    await service.sendMessage('지난번 포기한 사유는?', 'message-id');
    const sent = client.requests.find(request => request.method === 'turn/start')!;
    expect(sent.params.additionalContext).toBeUndefined();
    expect(sent.params.input).toEqual([{ type: 'text', text: '지난번 포기한 사유는?', text_elements: [] }]);
    const instructions = workspaceChatInstructions('Cheshi');
    for (const removed of ['cheshi_history', 'TypeSafe', 'Jev', 'history_read']) expect(instructions).not.toContain(removed);
    expect(instructions).toContain('cheshi_codegraph');
  } finally { await service.stop(); }
});

test('workspace history exposes local session search without creating a recall MCP server', async () => {
  const history = createWorkspaceChatHistory({ cwd: '/workspace/cheshi', userDataDirectory: '/unused/cheshi-test',
    home: '/unused/cheshi-home', historyDirectory: '/unused/cheshi-search', openExternal: async () => {},
    codeGraph: { cli: { executable: 'bun', args: [] }, dataRoot: '/unused/cheshi-codegraph' } });
  try {
    expect(Object.keys(history).sort()).toEqual(['accounts', 'search']);
    expect(typeof history.search.search).toBe('function');
    expect(typeof history.accounts.createClient).toBe('function');
  } finally { await history.search.stop(); await history.accounts.stop(); }
});

test('session history modules load under native Node strip-only TypeScript', () => {
  const result = spawnSync('node', ['--input-type=module', '-e',
    "await import('./desktop/lib/workspace-chat-history.mts'); await import('./desktop/lib/workspace-chat-service-options.mts');"],
  { cwd: new URL('../..', import.meta.url), encoding: 'utf8' });
  expect(result.status).toBe(0);
  expect(result.stderr).not.toContain('ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX');
});
