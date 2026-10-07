import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { FlashRuntime } from '../lib/flash/runtime.mts';
import { FlashSessionMemory } from '../lib/flash/session-memory.mts';
import { callFlash } from '../lib/flash/client.mts';
import type { CodexAccountsSnapshot } from '../shared/codex-accounts.ts';

test('native Node host with offline Gemma: scoped search, read, edit, delete, adoption and restart', {
  skip: process.env.CHESHI_TEST_FLASH !== '1', timeout: 180_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flash-native-'));
  const options = { directory,
    executable: process.env.CHESHI_FLASH_EXECUTABLE || fileURLToPath(new URL('../../../cheshi-flash/.venv/bin/cheshi-flash', import.meta.url)),
    modelCache: process.env.CHESHI_FLASH_MODEL_CACHE || join(homedir(), 'Library/Caches/CheshiFlash/hub') };
  const account = (id: string): CodexAccountsSnapshot => ({ activeId: id, profiles: [{ id, label: id, email: `${id}@example.com`,
    login: { state: 'signed_in', error: null }, usage: { state: 'ready', authenticated: true, plan: null, rateLimits: [], error: null } }] });
  let text = '프로젝트의 데이터베이스 페이지 크기는 4096바이트로 결정했습니다.';
  let sessions = [{ id: 'session', profileId: 'a', title: 'Local memory decision', updatedAt: 1 }];
  const source = { list: async () => ({ sessions }), read: async () => ({ thread: { id: 'session', cwd: '/workspace',
    turns: [{ id: 'turn', status: 'completed', items: [{ id: 'message', type: 'agentMessage', text }] }] } }) };
  let runtime = new FlashRuntime(options);
  let memory = new FlashSessionMemory({ workspace: '/workspace', host: runtime, source });
  memory.accounts(account('a'));
  const signal = new AbortController().signal;
  const generation = () => runtime.transaction(connection => callFlash<{ generation: number }>(connection, 'status', {}), signal);
  try {
    await memory.synchronize();
    const first = await memory.execute('memory_search', { query: '데이터베이스 페이지 크기는?', limit: 10 }, 'caller', signal) as { matches: { source_id: string; text: string }[] };
    assert.equal(first.matches.length, 1); assert.equal(first.matches[0]!.text, text);
    const read = await memory.execute('memory_read', { source_id: first.matches[0]!.source_id, length: 4 }, 'caller', signal) as { source: { text: string; next_offset: number } };
    assert.equal(read.source.text, [...text].slice(0, 4).join('')); assert.equal(read.source.next_offset, 4);
    const before = await generation();
    await memory.synchronize(); assert.deepEqual(await generation(), before);
    // Releasing an adopting client must leave the original host process alive.
    const adopted = new FlashRuntime(options);
    await adopted.transaction(connection => callFlash(connection, 'status', {}), signal);
    await adopted.release(); assert.deepEqual(await generation(), before);
    text = '변경 후 데이터베이스 페이지 크기는 8192바이트입니다.';
    await memory.synchronize();
    const changed = await memory.execute('memory_read', { source_id: first.matches[0]!.source_id }, 'caller', signal) as { source: { text: string } };
    assert.equal(changed.source.text, text);
    const saved = await generation();
    await memory.dispose();
    await assert.rejects(stat(join(directory, 'flash.sock')), { code: 'ENOENT' });
    runtime = new FlashRuntime(options);
    memory = new FlashSessionMemory({ workspace: '/workspace', host: runtime, source }); memory.accounts(account('a'));
    await memory.synchronize(); assert.deepEqual(await generation(), saved);
    memory.accounts(account('b')); await memory.synchronize();
    const other = await memory.execute('memory_search', { query: '페이지 크기' }, 'caller', signal) as { matches: unknown[] };
    assert.deepEqual(other.matches, []);
    sessions = [];
    memory.changed({ type: 'sessions-deleted', threadIds: ['session'] });
    await memory.synchronize();
    const integrity = await runtime.transaction(connection => callFlash<{ messages: number }>(connection, 'integrity', {}), signal);
    assert.equal(integrity.messages, 0);
  } finally { await memory.dispose(); await rm(directory, { recursive: true, force: true }); }
});
