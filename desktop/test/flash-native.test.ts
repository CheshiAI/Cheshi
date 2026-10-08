import { fixtureSummary, readRequest } from './flash-test-helpers.ts';
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
  const otherText = '다른 계정에서 메뉴의 배경을 투명하게 하기로 결정했습니다.';
  const source = { list: async () => ({ sessions }), read: async (id: string) => ({ thread: { id, cwd: '/workspace',
    turns: [{ id: 'turn', status: 'completed', items: [{ id: 'message', type: 'agentMessage', text: id === 'other' ? otherText : text }] }] } }) };
  let runtime = new FlashRuntime(options);
  let memory = new FlashSessionMemory({ workspace: '/workspace', host: runtime, source, summarize: fixtureSummary });
  memory.accounts(account('a'));
  const signal = new AbortController().signal;
  const generation = () => runtime.transaction(connection => callFlash<{ generation: number }>(connection, 'status', {}), signal);
  try {
    await memory.synchronize();
    const first = await memory.execute('memory_search', { query: '데이터베이스 페이지 크기는?', limit: 10 }, 'caller', signal) as { matches: { source_id: string; text: string }[] };
    assert.equal(first.matches.length, 1); assert.equal(first.matches[0]!.text, text);
    const excluded = await memory.execute('memory_search', { query: '페이지 크기' }, 'session', signal, 'turn') as { matches: unknown[] };
    assert.deepEqual(excluded.matches, []);
    const earlier = await memory.execute('memory_search', { query: '페이지 크기' }, 'session', signal, 'next-turn') as { matches: unknown[] };
    assert.equal(earlier.matches.length, 1);
    const otherSession = await memory.execute('memory_search', { query: '페이지 크기' }, 'caller', signal, 'turn') as { matches: unknown[] };
    assert.equal(otherSession.matches.length, 1);
    const read = await memory.execute('memory_read', readRequest('session'), 'caller', signal) as { summary: string };
    assert.equal(read.summary, text);
    const before = await generation();
    await memory.synchronize(); assert.deepEqual(await generation(), before);
    // Releasing an adopting client must leave the original host process alive.
    const adopted = new FlashRuntime(options);
    await adopted.transaction(connection => callFlash(connection, 'status', {}), signal);
    await adopted.release(); assert.deepEqual(await generation(), before);
    text = '변경 후 데이터베이스 페이지 크기는 8192바이트입니다.';
    await memory.synchronize();
    const changed = await memory.execute('memory_read', readRequest('session'), 'caller', signal) as { summary: string };
    assert.equal(changed.summary, text);
    const saved = await generation();
    await memory.dispose();
    await assert.rejects(stat(join(directory, 'flash.sock')), { code: 'ENOENT' });
    runtime = new FlashRuntime(options);
    memory = new FlashSessionMemory({ workspace: '/workspace', host: runtime, source, summarize: fixtureSummary }); memory.accounts(account('a'));
    await memory.synchronize(); assert.deepEqual(await generation(), saved);
    memory.accounts(account('b')); await memory.synchronize();
    const other = await memory.execute('memory_search', { query: '페이지 크기' }, 'caller', signal) as { matches: unknown[] };
    assert.deepEqual(other.matches, []);
    // Historical titles can exceed Flash's 2,000-code-point metadata limit.
    sessions.push({ id: 'other', profileId: 'b', title: '가'.repeat(1999) + '😀'.repeat(4554), updatedAt: 1 });
    const both = { activeId: 'a', profiles: [...account('a').profiles, ...account('b').profiles] };
    memory.accounts(both);
    await memory.synchronize();
    assert.equal(memory.status().total, 2);
    const shared = await memory.execute('memory_search', { query: '다른 계정의 메뉴 배경 결정', limit: 10 }, 'caller', signal) as {
      matches: { source_id: string; text: string }[];
    };
    const matched = shared.matches.find(item => item.text === otherText);
    assert.ok(matched);
    const sharedRead = await memory.execute('memory_read', readRequest('other'), 'caller', signal) as { summary: string };
    assert.equal(sharedRead.summary, otherText);
    const beforeSwitch = await generation();
    memory.accounts({ ...both, activeId: 'b' });
    await memory.synchronize();
    assert.deepEqual(await generation(), beforeSwitch);
    sessions = [];
    memory.changed({ type: 'sessions-deleted', threadIds: ['session', 'other'] });
    await memory.synchronize();
    const integrity = await runtime.transaction(connection => callFlash<{ messages: number }>(connection, 'integrity', {}), signal);
    assert.equal(integrity.messages, 0);
  } finally { await memory.dispose(); await rm(directory, { recursive: true, force: true }); }
});
