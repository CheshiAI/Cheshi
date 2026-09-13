import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexAppServerClient } from '../lib/codex-app-server-client.mts';
import { recordValue } from '../lib/codex-service-utils.mts';
import { isolatedCodexTestEnvironment } from './isolated-codex-test-environment';

// Opt in with CHESHI_TEST_REAL_CODEX=1. This uses only local thread RPCs, a
// synthetic archive, and an isolated home without credentials or model requests.
const runtimeTest = process.env.CHESHI_TEST_REAL_CODEX === '1' ? test : test.skip;

async function seedThread(directory: string) {
  const id = randomUUID();
  const timestamp = new Date().toISOString();
  const folder = path.join(directory, 'sessions', ...timestamp.slice(0, 10).split('-'));
  const file = path.join(folder, `rollout-${timestamp.slice(0, 19).replaceAll(':', '-')}-${id}.jsonl`);
  await mkdir(folder, { recursive: true });
  const records = [
    { timestamp, type: 'session_meta', payload: {
      id, timestamp, cwd: directory, originator: 'cheshi-writer-test', cli_version: '0.154.0',
      source: 'cli', model_provider: 'offline', base_instructions: { text: 'Offline test fixture.' },
    } },
    { timestamp, type: 'response_item', payload: {
      type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Saved fixture question.' }],
    } },
    { timestamp, type: 'response_item', payload: {
      type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Saved fixture answer.' }],
    } },
  ];
  await writeFile(file, `${records.map(record => JSON.stringify(record)).join('\n')}\n`);
  return { id, file };
}

function client(directory: string) {
  return new CodexAppServerClient({
    command: {
      executable: process.env.CHESHI_CODEX?.trim() || 'codex',
      args: ['app-server', '--listen', 'stdio://'],
      environment: isolatedCodexTestEnvironment(directory),
    },
    cwd: directory,
    clientInfo: { name: 'cheshi-writer-test', title: 'Writer ownership test', version: '1' },
    capabilities: { experimentalApi: true },
    requestTimeoutMs: 10_000,
  });
}

function resume(server: CodexAppServerClient, directory: string, thread: { id: string; file: string }) {
  return server.request('thread/resume', {
    threadId: thread.id, path: thread.file, cwd: directory,
    model: 'offline-test', modelProvider: 'offline', approvalPolicy: 'never', sandbox: 'read-only',
  });
}

function status(response: unknown) {
  return recordValue(recordValue(response)?.thread)?.status;
}

async function expectWriterConflict(operation: Promise<unknown>, threadId: string) {
  let error: unknown;
  try { await operation; } catch (cause) { error = cause; }
  expect(error).toBeInstanceOf(Error);
  if (!(error instanceof Error)) throw new Error('Expected the second writer to be rejected.');
  expect(error.name).toBe('CodexRequestRejectedError');
  expect(error.message).toBe(`thread ${threadId} already has an active writer`);
}

runtimeTest('an idle app server keeps its thread writer after unsubscribe and releases it on shutdown', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cheshi-app-server-writer-'));
  const owner = client(directory);
  const contender = client(directory);
  try {
    await writeFile(path.join(directory, 'config.toml'), [
      'model = "offline-test"', 'model_provider = "offline"',
      '[model_providers.offline]', 'name = "Offline fixture"',
      'base_url = "http://127.0.0.1:9/v1"', 'wire_api = "responses"', 'requires_openai_auth = false', '',
    ].join('\n'));
    const source = await seedThread(directory);
    const unrelated = await seedThread(directory);
    expect(status(await resume(owner, directory, source))).toEqual({ type: 'idle' });
    // Reusing a loaded session on its owner is safe, as is a different session
    // on a different server. The collision requires the same persisted thread.
    expect(status(await resume(owner, directory, source))).toEqual({ type: 'idle' });
    expect(status(await resume(contender, directory, unrelated))).toEqual({ type: 'idle' });
    expect(status(await contender.request('thread/read', { threadId: source.id, includeTurns: true })))
      .toEqual({ type: 'notLoaded' });
    await expectWriterConflict(resume(contender, directory, source), source.id);

    expect(await owner.request('thread/unsubscribe', { threadId: source.id })).toEqual({ status: 'unsubscribed' });
    const loaded = recordValue(await owner.request('thread/loaded/list', {}));
    expect(loaded?.data).toContain(source.id);
    await expectWriterConflict(resume(contender, directory, source), source.id);

    await owner.stop();
    expect(status(await resume(contender, directory, source))).toEqual({ type: 'idle' });
  } finally {
    await Promise.all([owner.stop(), contender.stop()]);
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
