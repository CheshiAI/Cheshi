import { expect, test } from 'bun:test';
import { CodexChatService } from '../lib/codex-chat-service.mts';
import { createFakeCodexClient, codexThread } from './codex-chat-test-helpers';

test('connected projects follow each turn without widening the permission profile or changing session identity', async () => {
  let roots = ['/workspace/app', '/workspace/plugin'];
  const client = createFakeCodexClient({
    'thread/start': { thread: codexThread('session') },
    'mcpServerStatus/list': { data: [], nextCursor: null },
    'turn/start': { turn: { id: 'turn', status: 'inProgress', items: [] } },
  });
  const service = new CodexChatService({ client, cwd: roots[0]!, serviceName: 'cheshi',
    developerInstructions: 'Respect repository instructions.', getWorkspaceProjects: () => [...roots] });
  try {
    await service.sendMessage('Inspect both projects', 'message-1');
    const start = client.requests.find(request => request.method === 'thread/start')!.params;
    expect(start.runtimeWorkspaceRoots).toEqual(roots);
    expect(start.permissions).toBe(':read-only');
    expect(start.sandbox).toBeUndefined();
    expect(start.developerInstructions).toContain('/workspace/plugin');
    const first = client.requests.find(request => request.method === 'turn/start')!.params;
    expect(first.runtimeWorkspaceRoots).toEqual(roots);
    expect(first.permissions).toBe(':read-only');
    client.emit('turn/completed', { threadId: 'session', turn: { id: 'turn', status: 'completed' } });
    roots = ['/workspace/app'];
    await service.sendMessage('Continue with the remaining project', 'message-2');
    const turns = client.requests.filter(request => request.method === 'turn/start');
    expect(turns[1]!.params.threadId).toBe('session');
    expect(turns[1]!.params.runtimeWorkspaceRoots).toEqual(roots);
    expect(JSON.stringify(turns[1]!.params.additionalContext)).not.toContain('/workspace/plugin');
    expect(client.requests.filter(request => request.method === 'thread/start')).toHaveLength(1);
    client.emit('turn/completed', { threadId: 'session', turn: { id: 'turn', status: 'completed' } });
  } finally { await service.stop(); }
});

test('resumed sessions receive the current project roots and keep their cwd', async () => {
  const client = createFakeCodexClient({ 'thread/resume': { thread: codexThread('existing') } });
  const service = new CodexChatService({ client, cwd: '/workspace/app', serviceName: 'cheshi',
    developerInstructions: 'Respect repository instructions.', getWorkspaceProjects: () => ['/workspace/app', '/workspace/plugin'] });
  try {
    expect(await service.ensureWritableThread('existing')).toBe('existing');
    expect(client.requests[0]?.params).toMatchObject({ cwd: '/workspace/app', runtimeWorkspaceRoots: ['/workspace/app', '/workspace/plugin'], permissions: ':read-only' });
  } finally { await service.stop(); }
});
