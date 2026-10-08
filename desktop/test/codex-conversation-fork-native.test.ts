import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { CodexAppServerClient } from '../lib/codex-app-server-client.mts';
import { CodexConversationCatalog } from '../lib/codex-conversation-catalog.mts';
import { CodexChatService } from '../lib/codex-chat-service.mts';
import { recordValue } from '../lib/codex-service-utils.mts';
import { isolatedCodexTestEnvironment } from './isolated-codex-test-environment';

// Isolated synthetic history and local RPCs only; no credentials or model requests.
const runtimeTest = process.env.CHESHI_TEST_REAL_CODEX === '1' ? test : test.skip;

runtimeTest('opens and lists a created fork before Codex lists it, including after catalog and server restart', async () => {
  const directory = await realpath(await mkdtemp('/private/tmp/cheshi-fork-catalog-native-'));
  const options = {
    command: { executable: process.env.CHESHI_CODEX?.trim() || 'codex', args: ['app-server', '--listen', 'stdio://'],
      environment: isolatedCodexTestEnvironment(directory) },
    cwd: directory, clientInfo: { name: 'cheshi-fork-catalog-test', title: 'Fork catalog test', version: '1' },
    capabilities: { experimentalApi: true }, requestTimeoutMs: 10_000,
  };
  const writer = new CodexAppServerClient(options);
  const reader = new CodexAppServerClient(options);
  let service: CodexChatService | undefined;
  try {
    const id = randomUUID(), timestamp = new Date().toISOString();
    const folder = join(directory, 'sessions', ...timestamp.slice(0, 10).split('-'));
    await mkdir(folder, { recursive: true });
    await writeFile(join(directory, 'config.toml'), [
      'model = "offline-test"', 'model_provider = "offline"', '[model_providers.offline]',
      'name = "Offline fixture"', 'base_url = "http://127.0.0.1:9/v1"', 'wire_api = "responses"',
      'requires_openai_auth = false', '',
    ].join('\n'));
    const records = [
      { type: 'session_meta', payload: { id, timestamp, cwd: directory, source: 'cli', cli_version: '0.154.0',
        originator: 'cheshi-fork-catalog-test', model_provider: 'offline', history_mode: 'paginated',
        base_instructions: { text: 'Offline fixture.' } } },
      { type: 'response_item', payload: { type: 'message', role: 'user',
        content: [{ type: 'input_text', text: 'Synthetic fork fixture.' }] } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'Synthetic fork fixture.', kind: 'plain' } },
    ];
    await writeFile(join(folder, `rollout-${timestamp.slice(0, 19).replaceAll(':', '-')}-${id}.jsonl`),
      records.map((record, ordinal) => JSON.stringify({ ...record, timestamp, ordinal })).join('\n') + '\n');
    const catalogOptions = { directory: join(directory, 'catalog'), cwd: directory,
      profiles: async () => [{ id: 'fixture', home: directory }],
      request: (_profile: string, method: string, params?: unknown) => reader.request(method, params) };
    let catalog = new CodexConversationCatalog(catalogOptions);
    service = new CodexChatService({ client: writer, cwd: directory, serviceName: 'test', developerInstructions: 'Offline fixture.',
      conversations: {
        list: () => catalog.list(), resolve: id => catalog.resolve(id, 'fixture', writer),
        read: (id, method, params) => catalog.read(id, method, params),
        registerCreated: thread => catalog.registerCreated('fixture', thread),
        locations: id => catalog.locations(id), request: catalogOptions.request, forget: id => catalog.forget(id),
      } });
    await service.openSession(id);
    const fork = await service.forkSession();
    const forkId = String(fork.session.id);
    const listed = recordValue(await reader.request('thread/list', { cwd: directory, modelProviders: [],
      sourceKinds: ['cli', 'vscode', 'appServer', 'exec', 'unknown'] }))!;
    expect((listed.data as Array<{ id: string }>).some(thread => thread.id === forkId)).toBe(false);
    expect((await service.openSession(forkId)).session.id).toBe(forkId);
    expect((await catalog.list()).sessions.some(session => session.id === forkId)).toBe(true);
    expect(await catalog.locations(forkId)).toEqual([{ profileId: 'fixture', threadId: forkId }]);
    await writer.stop();
    await reader.stop();
    catalog = new CodexConversationCatalog(catalogOptions);
    expect((await service.openSession(forkId)).session.id).toBe(forkId);
    expect((await catalog.list()).sessions.some(session => session.id === forkId)).toBe(true);
    await reader.request('thread/delete', { threadId: forkId });
    await catalog.confirmDeletion(forkId, { profileId: 'fixture', threadId: forkId, threadIds: [forkId] });
    await catalog.forget(forkId);
    expect((await catalog.list()).sessions.some(session => session.id === forkId)).toBe(false);
    expect((await catalog.list()).sessions.some(session => session.id === id)).toBe(true);
  } finally {
    await Promise.all([service?.stop(), writer.stop(), reader.stop()]);
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
