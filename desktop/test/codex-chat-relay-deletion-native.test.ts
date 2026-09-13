import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CodexAppServerClient } from '../lib/codex-app-server-client.mts';
import type { CodexConversationAccess } from '../lib/codex-chat-account-continuity.mts';
import { CodexChatContexts } from '../lib/codex-chat-contexts.mts';
import { CodexChatService } from '../lib/codex-chat-service.mts';
import { CodexChatSessionDeletion } from '../lib/codex-chat-session-deletion.mts';
import { CodexConversationCatalog } from '../lib/codex-conversation-catalog.mts';
import { recordValue, stringValue } from '../lib/codex-service-utils.mts';
import { isolatedCodexTestEnvironment } from './isolated-codex-test-environment';

// Reproduce both stopped-relay participants with synthetic messages and separate
// CODEX_HOMEs. Only local history RPCs are allowed; no credentials or model calls.
const runtimeTest = process.env.CHESHI_TEST_REAL_CODEX === '1' ? test : test.skip;
type PhysicalThread = { profileId: string; threadId: string; file: string };

function persistedThread(response: unknown, profileId: string): PhysicalThread {
  const thread = recordValue(recordValue(response)?.thread);
  const threadId = stringValue(thread?.id);
  const file = stringValue(thread?.path);
  if (!threadId || !file) throw new Error('Codex did not persist the fixture thread.');
  return { profileId, threadId, file };
}

async function seedThread(home: string, cwd: string, threadId: string, message: string): Promise<PhysicalThread> {
  const timestamp = new Date().toISOString();
  const folder = path.join(home, 'sessions', ...timestamp.slice(0, 10).split('-'));
  const file = path.join(folder, `rollout-${timestamp.slice(0, 19).replaceAll(':', '-')}-${threadId}.jsonl`);
  await mkdir(folder, { recursive: true });
  const records = [
    { type: 'session_meta', payload: { id: threadId, timestamp, cwd,
      originator: 'cheshi-relay-delete-test', cli_version: '0.154.0', source: 'vscode',
      model_provider: 'offline', history_mode: 'paginated', base_instructions: { text: 'Offline fixture.' } } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: message }] } },
    { type: 'event_msg', payload: { type: 'user_message', message, kind: 'plain' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Synthetic answer.' }] } },
  ];
  await writeFile(file, `${records.map((record, ordinal) => JSON.stringify({ ...record, timestamp, ordinal })).join('\n')}\n`);
  return { profileId: 'primary', threadId, file };
}

async function failure(operation: Promise<unknown>): Promise<Error> {
  try { await operation; } catch (error) { if (error instanceof Error) return error; throw error; }
  throw new Error('Expected the operation to fail.');
}

for (const selected of ['A', 'B'] as const) {
  runtimeTest(`deletes stopped relay ${selected} across two real account stores while preserving its peer`, async () => {
    const directory = await realpath(await mkdtemp('/private/tmp/cheshi-relay-delete-'));
    const cwd = path.join(directory, 'workspace');
    const homes = new Map(['primary', 'secondary'].map(id => [id, path.join(directory, id)]));
    const clients = new Map<string, CodexAppServerClient>();
    let service: CodexChatService | undefined;
    let contexts: CodexChatContexts | undefined;
    try {
      await mkdir(cwd);
      for (const [id, home] of homes) {
        await mkdir(home);
        await writeFile(path.join(home, 'config.toml'), [
          'model = "offline-test"', 'model_provider = "offline"',
          '[model_providers.offline]', 'name = "Offline fixture"',
          'base_url = "http://127.0.0.1:9/v1"', 'wire_api = "responses"', 'requires_openai_auth = false', '',
        ].join('\n'));
        clients.set(id, new CodexAppServerClient({
          command: { executable: process.env.CHESHI_CODEX?.trim() || 'codex', args: ['app-server', '--listen', 'stdio://'],
            environment: isolatedCodexTestEnvironment(home) },
          cwd, clientInfo: { name: 'cheshi-relay-delete-test', title: 'Relay deletion test', version: '1' },
          capabilities: { experimentalApi: true }, requestTimeoutMs: 10_000,
        }));
      }
      const importCopy = async (thread: PhysicalThread, profileId: string): Promise<PhysicalThread> => {
        const file = path.join(homes.get(profileId)!, path.relative(homes.get(thread.profileId)!, thread.file));
        await mkdir(path.dirname(file), { recursive: true });
        await copyFile(thread.file, file);
        return { ...thread, profileId, file };
      };
      const fork = async (source: PhysicalThread): Promise<PhysicalThread> => {
        const response = await clients.get(source.profileId)!.request('thread/fork', {
          threadId: source.threadId, cwd, model: 'offline-test', modelProvider: 'offline',
          approvalPolicy: 'never', sandbox: 'read-only', excludeTurns: true, deferGoalContinuation: true,
        });
        expect(recordValue(recordValue(response)?.thread)?.forkedFromId).toBe(source.threadId);
        return persistedThread(response, source.profileId);
      };
      const rootIds = { A: randomUUID(), B: randomUUID() };
      const relayId = randomUUID();
      const chains = new Map<string, PhysicalThread[]>();
      for (const participant of ['A', 'B'] as const) {
        const message = `[Cheshi relay]\n${JSON.stringify({ relayId, step: participant === 'A' ? 1 : 2,
          sourceThreadId: rootIds[participant === 'A' ? 'B' : 'A'], mode: 'review', round: 1,
          role: participant === 'A' ? 'proposal' : 'review', displayText: 'Synthetic stopped relay.' })}\nSynthetic stopped relay.`;
        const root = await seedThread(homes.get('primary')!, cwd, rootIds[participant], message);
        const importedRoot = await importCopy(root, 'secondary');
        const middle = await fork(importedRoot);
        const importedMiddle = await importCopy(middle, 'primary');
        const current = await fork(importedMiddle);
        chains.set(participant, [root, importedRoot, middle, importedMiddle, current]);
      }
      const target = chains.get(selected)!;
      const peer = chains.get(selected === 'A' ? 'B' : 'A')!;
      const currentId = target.at(-1)!.threadId;
      const peerId = peer.at(-1)!.threadId;
      const peerBefore = await Promise.all(peer.map(thread => readFile(thread.file, 'utf8')));
      const peerTranscript = recordValue(recordValue(await clients.get('primary')!.request('thread/read', {
        threadId: peerId, includeTurns: true,
      }))?.thread)?.turns;
      expect(peerTranscript).toBeInstanceOf(Array);
      const rejection = await failure(clients.get('primary')!.request('thread/delete', { threadId: target[0]!.threadId }));
      expect(rejection.message).toContain('forked history still references it');
      const catalogDirectory = path.join(directory, 'catalog');
      await mkdir(catalogDirectory);
      const location = ({ profileId, threadId }: PhysicalThread) => ({ profileId, threadId });
      await writeFile(path.join(catalogDirectory, 'conversations.json'), JSON.stringify({ version: 1,
        chains: [...chains.values()].map(chain => ({ current: location(chain.at(-1)!), locations: chain.map(location) })) }));
      const deletions: Array<{ profileId: string; threadId: string }> = [];
      const request: CodexConversationAccess['request'] = (profileId, method, params) => {
        if (method === 'thread/delete') deletions.push({ profileId, threadId: String(recordValue(params)?.threadId) });
        return clients.get(profileId)!.request(method, params);
      };
      const catalog = new CodexConversationCatalog({ directory: catalogDirectory, cwd, request,
        profiles: async () => [...homes].map(([id, home]) => ({ id, home })) });
      const conversations: CodexConversationAccess = {
        list: () => catalog.list(), resolve: (id, client) => catalog.resolve(id, 'primary', client),
        locations: id => catalog.locations(id), request,
        deletionProgress: id => catalog.deletionProgress(id),
        confirmDeletion: (id, deletion) => catalog.confirmDeletion(id, deletion), forget: id => catalog.forget(id),
      };
      const options = { cwd, serviceName: 'test', developerInstructions: 'Offline fixture.' };
      service = new CodexChatService({ ...options, client: clients.get('primary')!, conversations });
      contexts = new CodexChatContexts({ service: options, emit() {},
        createClient() { throw new Error('Unexpected additional chat client.'); } });
      service.viewedThreadId = peerId;
      const deletion = new CodexChatSessionDeletion({ service, contexts, relays: { get: () => null } });
      expect(new Set((await deletion.deleteSession(service, currentId)).threadIds)).toEqual(new Set(target.map(thread => thread.threadId)));
      expect(deletions).toEqual([target[4]!, target[3]!, target[0]!, target[2]!, target[1]!].map(location));
      expect(target.every(thread => !existsSync(thread.file))).toBe(true);
      expect(await Promise.all(peer.map(thread => readFile(thread.file, 'utf8')))).toEqual(peerBefore);
      expect(service.viewedThreadId).toBe(peerId);
      expect(await catalog.locations(peerId)).toEqual(peer.map(location));
      expect(await catalog.owner(peerId)).toEqual(location(peer.at(-1)!));
      expect(recordValue(recordValue(await catalog.read(peerId, 'thread/read', { includeTurns: true }))?.thread)?.turns).toEqual(peerTranscript);
      expect((await failure(catalog.owner(currentId))).message).toBe('This conversation was deleted.');
    } finally {
      await Promise.all([service?.stop(), contexts?.stop(), ...[...clients.values()].map(client => client.stop())]);
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
}
