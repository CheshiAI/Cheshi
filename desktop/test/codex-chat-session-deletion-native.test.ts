import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexAppServerClient } from '../lib/codex-app-server-client.mts';
import type { CodexConversationAccess } from '../lib/codex-chat-account-continuity.mts';
import { CodexChatContexts } from '../lib/codex-chat-contexts.mts';
import { CodexChatService } from '../lib/codex-chat-service.mts';
import { CodexChatSessionDeletion } from '../lib/codex-chat-session-deletion.mts';
import { recordValue, stringValue } from '../lib/codex-service-utils.mts';
import { isolatedCodexTestEnvironment } from './isolated-codex-test-environment';

// Local thread RPCs only: isolated CODEX_HOME, synthetic history, no credentials,
// and no turn/start or model requests. Opt in with CHESHI_TEST_REAL_CODEX=1.
const runtimeTest = process.env.CHESHI_TEST_REAL_CODEX === '1' ? test : test.skip;

async function seedPaginatedThread(directory: string) {
  const id = randomUUID();
  const timestamp = new Date().toISOString();
  const folder = path.join(directory, 'sessions', ...timestamp.slice(0, 10).split('-'));
  const file = path.join(folder, `rollout-${timestamp.slice(0, 19).replaceAll(':', '-')}-${id}.jsonl`);
  await mkdir(folder, { recursive: true });
  const records = [
    { type: 'session_meta', payload: {
      id, timestamp, cwd: directory, originator: 'cheshi-fork-delete-test', cli_version: '0.154.0',
      source: 'cli', model_provider: 'offline', history_mode: 'paginated',
      base_instructions: { text: 'Offline deletion fixture.' },
    } },
    { type: 'response_item', payload: {
      type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Synthetic question.' }],
    } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'Synthetic question.', kind: 'plain' } },
    { type: 'response_item', payload: {
      type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Synthetic answer.' }],
    } },
  ];
  await writeFile(file, `${records.map((record, ordinal) =>
    JSON.stringify({ ...record, timestamp, ordinal })).join('\n')}\n`);
  return { id, file };
}

async function failure(operation: Promise<unknown>): Promise<Error> {
  try { await operation; } catch (error) { if (error instanceof Error) return error; throw error; }
  throw new Error('Expected the operation to fail.');
}

function persistedFork(value: unknown) {
  const thread = recordValue(value);
  const id = stringValue(thread?.id);
  const file = stringValue(thread?.path);
  if (!id || !file) throw new Error('Codex did not persist the fork fixture.');
  return { id, file };
}

runtimeTest('deletes a real paginated fork chain through the catalog in dependency order', async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cheshi-fork-delete-')));
  const client = new CodexAppServerClient({
    command: {
      executable: process.env.CHESHI_CODEX?.trim() || 'codex',
      args: ['app-server', '--listen', 'stdio://'],
      environment: isolatedCodexTestEnvironment(directory),
    },
    cwd: directory,
    clientInfo: { name: 'cheshi-fork-delete-test', title: 'Fork deletion test', version: '1' },
    capabilities: { experimentalApi: true },
    requestTimeoutMs: 10_000,
  });
  let service: CodexChatService | undefined;
  let contexts: CodexChatContexts | undefined;
  try {
    await writeFile(path.join(directory, 'config.toml'), [
      'model = "offline-test"', 'model_provider = "offline"',
      '[model_providers.offline]', 'name = "Offline fixture"',
      'base_url = "http://127.0.0.1:9/v1"', 'wire_api = "responses"', 'requires_openai_auth = false', '',
    ].join('\n'));
    const root = await seedPaginatedThread(directory);
    const chain: Array<{ id: string; file: string }> = [root];
    for (let generation = 0; generation < 2; generation += 1) {
      const source = chain.at(-1)!;
      const response = await client.request('thread/fork', {
        threadId: source.id, cwd: directory, model: 'offline-test', modelProvider: 'offline',
        approvalPolicy: 'never', sandbox: 'read-only', excludeTurns: true, deferGoalContinuation: true,
      });
      const thread = recordValue(recordValue(response)?.thread);
      expect(thread?.forkedFromId).toBe(source.id);
      expect(thread?.historyMode).toBe('paginated');
      chain.push(persistedFork(thread));
    }
    expect(chain.every(thread => existsSync(thread.file))).toBe(true);
    const rejection = await failure(client.request('thread/delete', { threadId: root.id }));
    expect(rejection.name).toBe('CodexRequestRejectedError');
    expect(rejection.message).toBe(`cannot delete thread ${root.id}: forked history still references it`);

    const deletions: string[] = [];
    const forgotten: string[] = [];
    const conversations: CodexConversationAccess = {
      async list() { return { sessions: [] }; },
      async resolve(id) { return id; },
      async locations() { return chain.map(thread => ({ profileId: 'fixture', threadId: thread.id })); },
      async forget(id) { forgotten.push(id); },
      async request(profileId, method, params) {
        expect(profileId).toBe('fixture');
        if (method === 'thread/delete') deletions.push(String(recordValue(params)?.threadId));
        return await client.request(method, params);
      },
    };
    const options = { cwd: directory, serviceName: 'test', developerInstructions: 'Offline fixture.' };
    service = new CodexChatService({ ...options, client, conversations });
    contexts = new CodexChatContexts({ service: options, emit() {},
      createClient() { throw new Error('This fixture must not open additional chat clients.'); } });
    const deletion = new CodexChatSessionDeletion({ service, contexts, relays: { get: () => null } });
    const currentId = chain.at(-1)!.id;
    const result = await deletion.deleteSession(service, currentId);
    expect(new Set(result.threadIds)).toEqual(new Set(chain.map(thread => thread.id)));
    expect(deletions).toEqual(chain.map(thread => thread.id).reverse());
    expect(forgotten).toEqual([currentId]);
    expect(chain.every(thread => !existsSync(thread.file))).toBe(true);
    expect(recordValue(await client.request('thread/list', { modelProviders: [], limit: 100 }))?.data).toEqual([]);
    expect(recordValue(await client.request('thread/loaded/list', {}))?.data).toEqual([]);
  } finally {
    await Promise.all([service?.stop(), contexts?.stop(), client.stop()]);
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
