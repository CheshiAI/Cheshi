import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDiscordService, type DiscordTarget } from '../lib/discord-service.mts';
import type { createDiscordGateway } from '../lib/discord-gateway.mts';
import type { createDiscordRest } from '../lib/discord-rest.mts';
import { createDiscordStore } from '../lib/discord-store.mts';

const owner = '111111111111111111', guild = '222222222222222222', bot = '333333333333333333';
const token = 'test-only-discord-secret-never-real';
const preferences = { enabled: true, ownerId: owner, guildId: guild, deviceName: 'Studio' };
const encryption = { isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from([...value].reverse().join('')),
  decryptString: (value: Buffer) => [...value.toString()].reverse().join('') };
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function eventually(check: () => boolean) {
  for (let count = 0; count < 150; count++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('Expected observable Discord state did not arrive.');
}
function fixture(directory = mkdtempSync(path.join(tmpdir(), 'cheshi-discord-'))) {
  const channels: Record<string, unknown>[] = [], messages: Record<string, unknown>[] = [], calls: string[] = [];
  let gateway: Parameters<typeof createDiscordGateway>[0] | undefined;
  let next = BigInt(Date.now() - 1420070400000) << 22n;
  const id = () => { const now = BigInt(Date.now() - 1420070400000) << 22n; next = (next > now ? next : now) + 1n; return String(next); };
  const rest: typeof createDiscordRest = () => async (method, route, body) => {
    calls.push(`${method} ${route}`);
    const payload = (body ?? {}) as Record<string, unknown>;
    if (route === '/users/@me') return { id: bot, bot: true };
    if (route === `/guilds/${guild}`) return { owner_id: owner };
    if (route === `/guilds/${guild}/channels`) {
      if (method === 'GET') return channels;
      const channel = { ...payload, id: id() }; channels.push(channel); return channel;
    }
    if (route.includes('/messages')) {
      const channel = route.split('/')[2];
      if (method === 'GET') {
        const after = new URL(`https://test${route}`).searchParams.get('after');
        return messages.filter(message => message.channel_id === channel && (!after || BigInt(String(message.id)) > BigInt(after)));
      }
      const existing = method === 'PATCH' ? messages.find(message => route.endsWith(String(message.id))) : undefined;
      if (existing) { Object.assign(existing, payload); return existing; }
      const message = { ...payload, id: id(), channel_id: channel, author: { id: bot, bot: true }, type: 0 };
      messages.push(message); return message;
    }
    if (method === 'PATCH') { const channel = channels.find(channel => route.endsWith(String(channel.id))); Object.assign(channel!, payload); return channel; }
    throw new Error('Unexpected request');
  };
  const create = () => createDiscordService({ directory, encryption, rest,
    gateway: options => { gateway = options; return { stop() {} }; } });
  let service = create();
  cleanups.push(() => { rmSync(directory, { recursive: true, force: true }); });
  cleanups.push(() => service.dispose().then(() => {}));
  const ready = () => { gateway!.status('Connected', true); gateway!.dispatch('READY', {}); };
  const inbound = (channel: string, content = '안녕', patch: Record<string, unknown> = {}) => {
    const message = { id: id(), channel_id: channel, guild_id: guild, type: 0, author: { id: owner }, content, ...patch };
    gateway!.dispatch('MESSAGE_CREATE', message); return message;
  };
  return { get service() { return service; }, async restart() { await service.dispose(); service = create(); await service.start(); },
    directory, ready, inbound, channels, messages, calls,
    event: (type: string, message: Record<string, unknown>) => gateway!.dispatch(type, message),
    dispatch: (message: Record<string, unknown>) => gateway!.dispatch('MESSAGE_CREATE', message) };
}

test('session discovery creates one private channel, updates its title, and accepts only the owner in that channel', async () => {
  const f = fixture(); await f.service.save({ ...preferences, token }); f.ready();
  const executed: string[] = [];
  const target: DiscordTarget = { workspace: '/project', thread: 'session-1', title: 'New chat',
    execute: async text => { executed.push(text); return { text: '작업 중' }; } };
  f.service.observe(target); f.service.observe(target);
  await eventually(() => f.service.get().channels === 1);
  const channel = String(f.channels.find(channel => channel.type === 0)!.id);
  expect(f.channels.filter(channel => channel.type === 0)).toHaveLength(1);
  const permissions = f.channels.find(channel => channel.type === 0)!.permission_overwrites as Array<{ id: string; deny: string }>;
  expect(permissions.find(item => item.id === guild)?.deny).toBe('1024');
  f.service.observe({ ...target, title: '버그 수정' });
  await eventually(() => String(f.channels.find(channel => channel.type === 0)!.name).startsWith('버그-수정'));
  f.inbound(channel, 'other user', { author: { id: bot } });
  f.inbound(channel, 'webhook', { webhook_id: bot });
  f.inbound(channel, 'other server', { guild_id: bot });
  f.inbound(bot, 'other channel');
  const command = f.inbound(channel, 'execute once'); f.dispatch(command);
  await eventually(() => executed.length === 1);
  expect(executed).toEqual(['execute once']);
  expect(readFileSync(path.join(f.directory, 'discord.json'), 'utf8')).not.toContain(token);
  expect(JSON.stringify(f.service.get())).not.toContain(token);
});

test('completion waits for the queue and sends the final answer with a restricted owner mention', async () => {
  const f = fixture(); await f.service.save({ ...preferences, token }); f.ready();
  const key = f.service.observe({ workspace: '/project', thread: 's1', title: 'Test', execute: async () => ({ text: 'ok' }) });
  await eventually(() => f.service.get().channels === 1);
  f.service.event(key, { type: 'turn-started', turnId: 'turn1' }, 1);
  f.service.event(key, { type: 'assistant-completed', itemId: 'answer', text: '테스트 완료 @everyone' }, 1);
  f.service.event(key, { type: 'turn-completed', turnId: 'turn1', status: 'completed' }, 1);
  await new Promise(resolve => setTimeout(resolve, 400));
  expect(f.messages.some(item => String(item.content).includes('테스트 완료'))).toBe(false);
  f.service.event(key, { type: 'queue-changed' }, 0);
  await eventually(() => f.messages.some(item => String(item.content).includes('테스트 완료')));
  const result = f.messages.find(item => String(item.content).includes('테스트 완료'))!;
  expect(result.allowed_mentions).toEqual({ parse: [], users: [owner], replied_user: false });
});

test('a received command is not replayed after restart and a continuation keeps its original channel', async () => {
  const f = fixture(); await f.service.save({ ...preferences, token }); f.ready();
  let executions = 0;
  const key = f.service.observe({ workspace: '/project', thread: 'old', title: 'Test', execute: async () => { executions++; return { text: 'ok', thread: 'continued' }; } });
  await eventually(() => f.service.get().channels === 1);
  const channel = String(f.channels.find(item => item.type === 0)!.id);
  const received = f.inbound(channel);
  await eventually(() => executions === 1 && f.service.sessions('/project')[0]?.thread === 'continued');
  expect(f.service.observe({ workspace: '/project', thread: 'continued', title: 'Test', execute: async () => ({ text: 'ok' }) })).toBe(key);
  await f.restart();
  f.service.observe({ workspace: '/project', thread: 'continued', title: 'Test', execute: async () => { executions++; return { text: 'ok' }; } });
  f.ready(); f.dispatch(received);
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(executions).toBe(1); expect(f.channels.filter(item => item.type === 0)).toHaveLength(1);
  const stored = createDiscordStore(f.directory, encryption);
  expect(BigInt(stored.data.bindings[key]!.cursor)).toBeGreaterThanOrEqual(BigInt(received.id));
  expect(stored.data.bindings[key]!.channel).toBe(channel);
  const other = fixture(); await other.service.save({ ...preferences, token });
  expect(createDiscordStore(other.directory, encryption).data.deviceId).not.toBe(stored.data.deviceId);
});

test('disabling prevents new execution and unavailable sessions never route to another target', async () => {
  const f = fixture(); await f.service.save({ ...preferences, token }); f.ready();
  let count = 0;
  const key = f.service.observe({ workspace: '/one', thread: 'same-id', title: 'Test', execute: async () => { count++; return { text: 'ok' }; } });
  await eventually(() => f.service.get().channels === 1);
  const channel = String(f.channels.find(item => item.type === 0)!.id);
  f.service.unavailable(key); f.inbound(channel);
  await eventually(() => f.messages.some(item => String(item.content).includes('명령은 실행되지')));
  await f.service.save({ ...preferences, enabled: false }); f.inbound(channel);
  await new Promise(resolve => setTimeout(resolve, 20)); expect(count).toBe(0);
});

test('channel privacy changes block execution and attention/failure alerts are deduplicated', async () => {
  const f = fixture(); await f.service.save({ ...preferences, token }); f.ready();
  let executions = 0;
  const key = f.service.observe({ workspace: '/private', thread: 'private', title: 'Private', execute: async () => { executions++; return { text: 'ok' }; } });
  await eventually(() => f.service.get().channels === 1);
  f.service.event(key, { type: 'turn-started', turnId: 'turn' }, 0);
  for (let index = 0; index < 2; index++) f.service.event(key, { type: 'approval-requested', approval: { id: 'request' } }, 0);
  for (let index = 0; index < 2; index++) f.service.event(key, { type: 'turn-completed', turnId: 'turn', status: 'failed' }, 0);
  await eventually(() => f.messages.filter(item => String(item.content).includes('실패했습니다')).length === 1);
  expect(f.messages.filter(item => String(item.content).includes('응답이 필요'))).toHaveLength(1);
  const channel = f.channels.find(item => item.type === 0)!;
  channel.permission_overwrites = [];
  f.event('CHANNEL_UPDATE', channel); f.inbound(String(channel.id));
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(executions).toBe(0);
});
