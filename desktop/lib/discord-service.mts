import { createHash, randomUUID } from 'node:crypto';
import { discordId, discordPreferences, discordRecord, type DiscordSettings } from '../shared/discord.ts';
import { createDiscordStore, type DiscordEncryption, type DiscordBinding } from './discord-store.mts';
import { createDiscordRest, type DiscordRest, DiscordHttpError } from './discord-rest.mts';
import { createDiscordGateway } from './discord-gateway.mts';
import { ensureDiscordChannel } from './discord-channels.mts';
import { createChatNotifications } from './chat-notifications.mts';

export interface DiscordTarget {
  workspace: string; thread: string; title: string;
  execute(text: string, id: string, signal: AbortSignal): Promise<{ text: string; thread?: string }>;
}
export interface DiscordBridge {
  observe(target: DiscordTarget): string;
  sessions(workspace: string): Array<{ thread: string; title: string }>;
  continue(key: string, thread: string): void;
  event(key: string, event: unknown, queue: number | null): void;
  unavailable(key: string): void;
}
export function discordBindingKey(workspace: string, thread: string) {
  return createHash('sha256').update(JSON.stringify([workspace, thread])).digest('hex').slice(0, 24);
}
const snowflakeNow = () => ((BigInt(Date.now() - 1420070400000) << 22n)).toString();
const brief = (text: string) => text.length > 1800 ? `${text.slice(0, 1740)}\n…전체 응답은 Cheshi에서 확인하세요.` : text;

export function createDiscordService(options: {
  directory: string; encryption: DiscordEncryption;
  rest?: typeof createDiscordRest; gateway?: typeof createDiscordGateway;
}) {
  const store = createDiscordStore(options.directory, options.encryption);
  const data = store.data;
  let lifetime = new AbortController(), rest: DiscordRest | undefined, bot = '', connected = false;
  let gateway: ReturnType<typeof createDiscordGateway> | undefined;
  let status = store.error ?? 'Not connected', disposed = false, epoch = 0, saving = false;
  let work: Promise<unknown> = Promise.resolve();
  let timer: ReturnType<typeof setInterval> | undefined;
  let connectionRetry: ReturnType<typeof setTimeout> | undefined;
  const targets = new Map<string, DiscordTarget>();
  const trackers = new Map<string, ReturnType<typeof createChatNotifications>>();
  const verified = new Map<string, string>();
  const outputs = new Map<string, Map<string, string>>();
  const persist = () => {
    try { store.write(); return true; }
    catch { status = 'Could not save Discord state. Connection stopped to prevent duplicate work.'; connected = false; gateway?.stop(); lifetime.abort(); return false; }
  };
  const session = () => epoch;
  const snapshot = (): DiscordSettings => ({ ...data.preferences, hasToken: Boolean(data.encryptedToken), connected, status,
    channels: Object.values(data.bindings).filter(binding => binding.channel).length, pending: data.outbox.length });
  const schedule = (task: () => Promise<unknown>) => {
    const version = session();
    const next = work.then(async () => { if (version === epoch && !disposed) await task(); });
    work = next.catch(error => { if (version === epoch && !disposed) status = error instanceof DiscordHttpError ? error.message : 'Discord operation could not finish. Check the connection and retry.'; });
    return work;
  };
  function enqueue(key: string, text: string, alert: boolean) {
    if (!data.preferences.enabled || !data.bindings[key] || data.bindings[key].disabled) return;
    if (!alert) data.outbox = data.outbox.filter(entry => entry.binding !== key || entry.alert);
    if (data.outbox.length >= 1000) { status = 'Discord delivery queue is full. Reconnect before continuing.'; return; }
    data.outbox.push({ id: randomUUID().replaceAll('-', '').slice(0, 24), binding: key, text: brief(text), alert });
    if (persist()) void schedule(flush);
  }
  async function ensure(key: string, binding: DiscordBinding) {
    if (!rest || !connected || binding.disabled || verified.get(key) === binding.title) return;
    const title = binding.title;
    binding.channel = await ensureDiscordChannel(rest, data, bot, key, binding);
    binding.cursor ||= binding.channel;
    store.write(); verified.set(key, title);
  }
  async function flush() {
    if (!rest || !connected) return;
    for (const entry of [...data.outbox]) {
      const binding = data.bindings[entry.binding];
      if (!binding || binding.disabled) continue;
      await ensure(entry.binding, binding);
      const update = !entry.alert && binding.statusMessage;
      let message: Record<string, unknown> | undefined;
      if (entry.attempted && !update) {
        const recent = await rest('GET', `/channels/${binding.channel}/messages?limit=100`);
        if (Array.isArray(recent)) message = recent.map(discordRecord).find(item => item.nonce === entry.id && discordRecord(item.author).id === bot);
        // Nonce uniqueness has a short server-side lifetime. Never blindly retry an
        // uncertain POST after restart; preserve it for inspection instead of duplicating.
        if (!message) { status = 'A Discord delivery is unconfirmed. Check the channel; it will not be resent automatically.'; continue; }
      }
      if (!message) {
        entry.attempted = true; store.write();
        try {
          message = discordRecord(await rest(update ? 'PATCH' : 'POST', `/channels/${binding.channel}/messages${update ? `/${update}` : ''}`, {
            content: entry.alert ? `<@${data.preferences.ownerId}> ${entry.text}` : entry.text,
            allowed_mentions: { parse: [], users: entry.alert ? [data.preferences.ownerId] : [], replied_user: false },
            ...(!update ? { nonce: entry.id, enforce_nonce: true, ...(!entry.alert ? { flags: 4096 } : {}) } : {}),
          }));
        } catch (error) {
          if (error instanceof DiscordHttpError && [400, 401, 403, 404, 429].includes(error.status)) entry.attempted = false;
          if (update && error instanceof DiscordHttpError && error.status === 404) { delete binding.statusMessage; entry.attempted = false; }
          store.write(); throw error;
        }
      }
      if (!entry.alert) binding.statusMessage = discordId(message.id);
      data.outbox = data.outbox.filter(item => item.id !== entry.id); store.write();
    }
  }
  async function receive(value: Record<string, unknown>) {
    if (!connected || value.guild_id !== data.preferences.guildId || value.webhook_id || (value.type !== 0 && value.type !== 19)) return;
    const author = discordRecord(value.author);
    if (author.id !== data.preferences.ownerId || author.bot === true) return;
    const found = Object.entries(data.bindings).find(([, binding]) => binding.channel === value.channel_id && !binding.disabled);
    if (!found) return;
    const [key, binding] = found, id = discordId(value.id);
    if (BigInt(id) <= BigInt(binding.cursor || '0')) return;
    await ensure(key, binding);
    // Commit receipt BEFORE invoking the chat runtime. An uncertain/crashed command
    // is never automatically executed again, even after a Gateway replay.
    binding.cursor = id; store.write();
    const target = targets.get(key);
    if (!target) { enqueue(key, '이 세션의 작업 공간을 Cheshi에서 열어 주세요. 명령은 실행되지 않았습니다.', true); return; }
    const text = typeof value.content === 'string' ? value.content.trim() : '';
    if (!text || text.length > 8000 || (Array.isArray(value.attachments) && value.attachments.length)) {
      enqueue(key, '현재는 8,000자 이내의 텍스트 지시를 지원합니다. 첨부 파일은 Cheshi에서 추가해 주세요.', true); return;
    }
    try {
      const result = await target.execute(text, `discord-${id}`, lifetime.signal);
      if (result.thread && result.thread !== binding.thread) {
        binding.thread = result.thread; target.thread = result.thread; store.write();
      }
      enqueue(key, result.text, false);
    } catch { enqueue(key, '명령 실행 여부를 확인할 수 없습니다. Cheshi에서 확인해 주세요. 자동 재실행하지 않습니다.', true); }
  }
  async function recover() {
    if (!rest || !connected) return;
    verified.clear();
    for (const [key, binding] of Object.entries(data.bindings)) {
      if (binding.disabled) continue;
      await ensure(key, binding);
      // Read oldest unseen messages first. Cursor advances for every examined
      // message, including our own replies, so reconnects have bounded work.
      for (let page = 0; page < 10; page++) {
        const messages = await rest('GET', `/channels/${binding.channel}/messages?after=${binding.cursor}&limit=100`);
        if (!Array.isArray(messages)) break;
        const sorted = messages.map(discordRecord).sort((a, b) => BigInt(discordId(a.id)) < BigInt(discordId(b.id)) ? -1 : 1);
        for (const message of sorted) {
          await receive({ ...message, guild_id: data.preferences.guildId, channel_id: binding.channel });
          if (BigInt(discordId(message.id)) > BigInt(binding.cursor)) { binding.cursor = discordId(message.id); store.write(); }
        }
        if (messages.length < 100) break;
      }
    }
    await flush();
  }
  async function start() {
    epoch++; gateway?.stop(); lifetime.abort(); connected = false; verified.clear(); clearInterval(timer); clearTimeout(connectionRetry);
    await work;
    lifetime = new AbortController();
    rest = undefined;
    if (!data.preferences.enabled || disposed) { status = store.error ?? 'Disabled'; return; }
    const version = epoch;
    status = 'Connecting…';
    const token = store.token();
    const client = (options.rest ?? createDiscordRest)(token, lifetime.signal);
    const self = discordRecord(await client('GET', '/users/@me'));
    const guild = discordRecord(await client('GET', `/guilds/${data.preferences.guildId}`));
    if (version !== epoch || disposed) return;
    if (self.bot !== true || guild.owner_id !== data.preferences.ownerId) throw new Error('Use a personal bot in a server owned by your registered Discord user.');
    bot = discordId(self.id); rest = client;
    gateway = (options.gateway ?? createDiscordGateway)({ token, signal: lifetime.signal,
      gateway: async () => await client('GET', '/gateway/bot') as Awaited<ReturnType<Parameters<typeof createDiscordGateway>[0]['gateway']>>,
      status: (text, ready) => { if (version === epoch) { status = text; connected = ready; } },
      dispatch: (type, value) => {
        if (version !== epoch) return;
        if (type === 'READY' || type === 'RESUMED') void schedule(recover);
        if (type === 'CHANNEL_UPDATE' || type === 'CHANNEL_DELETE') {
          for (const [key, binding] of Object.entries(data.bindings)) if (binding.channel === value.id) verified.delete(key);
        }
        if (type === 'MESSAGE_CREATE') void schedule(() => receive(value));
      },
    });
    timer = setInterval(() => { void schedule(async () => {
      for (const [key, binding] of Object.entries(data.bindings)) await ensure(key, binding);
      await flush();
    }); }, 15_000); timer.unref?.();
  }
  async function connect() {
    try { await start(); }
    catch {
      status = 'Could not connect Discord. Check settings and secure storage. Retrying…';
      if (!disposed && data.preferences.enabled) {
        connectionRetry = setTimeout(() => { void connect(); }, 30_000); connectionRetry.unref?.();
      }
    }
  }
  const bridge: DiscordBridge = {
    sessions(workspace) { return Object.values(data.bindings).filter(binding => binding.workspace === workspace && !binding.disabled)
      .map(({ thread, title }) => ({ thread, title })); },
    continue(key, thread) { const binding = data.bindings[key]; if (binding) { binding.thread = thread; persist(); } },
    observe(target) {
      // Account continuation retains the original channel even when its backing ID changes.
      const existing = Object.entries(data.bindings).find(([, item]) => item.workspace === target.workspace && item.thread === target.thread);
      const key = existing?.[0] ?? discordBindingKey(target.workspace, target.thread);
      targets.set(key, target);
      if (!data.preferences.enabled) return key;
      const binding = data.bindings[key] ??= { workspace: target.workspace, thread: target.thread, title: target.title,
        channel: '', cursor: snowflakeNow() };
      if (binding.title !== target.title) { binding.title = target.title; verified.delete(key); }
      if (persist()) void schedule(() => ensure(key, binding)); return key;
    },
    event(key, value, queue) {
      if (!data.preferences.enabled || !data.bindings[key]) return;
      const event = discordRecord(value), thread = data.bindings[key].thread;
      let tracker = trackers.get(key);
      if (!tracker) {
        tracker = createChatNotifications({ workspace: data.bindings[key].workspace, notify: notification => {
          const result = [...(outputs.get(key)?.values() ?? [])].join('\n\n');
          const text = notification.kind === 'completed' ? (result || '작업과 대기열이 완료되었습니다.')
            : notification.kind === 'attention' ? '승인 또는 질문에 응답이 필요합니다. Cheshi에서 확인해 주세요.' : '작업이 실패했습니다. Cheshi에서 확인해 주세요.';
          enqueue(key, text, true);
        } }); trackers.set(key, tracker);
      }
      if (queue !== null) tracker.queue('discord', [{ threadId: thread, count: queue }]);
      tracker.event('discord', { ...event, threadId: thread });
      if (event.type === 'turn-started') { outputs.set(key, new Map()); enqueue(key, '작업 중…', false); }
      if (event.type === 'assistant-completed' && typeof event.text === 'string') {
        const messages = outputs.get(key) ?? new Map<string, string>();
        messages.set(String(event.itemId), event.text); outputs.set(key, messages);
      }
      if (event.type === 'turn-completed') enqueue(key, event.status === 'completed' ? (queue ? `대기열 ${queue}개 남음` : '응답 완료') : event.status === 'failed' ? '실패' : '중지됨', false);
      if (event.type === 'session-deleted') { data.bindings[key].disabled = true; persist(); }
    },
    unavailable(key) { targets.delete(key); trackers.get(key)?.dispose(); trackers.delete(key); },
  };
  return {
    ...bridge, get: snapshot,
    async save(value: unknown) {
      if (saving) throw new Error('Discord settings are being saved.');
      saving = true;
      try {
        const input = discordRecord(value), preferences = discordPreferences(input);
        if (input.token !== undefined && typeof input.token !== 'string') throw new TypeError('Invalid bot token.');
        store.save(preferences, input.token as string | undefined);
        await connect();
        for (const target of targets.values()) bridge.observe(target);
        return snapshot();
      } finally { saving = false; }
    },
    async test() {
      if (!connected) throw new Error('Connect Discord first.');
      const key = Object.keys(data.bindings).find(key => data.bindings[key]?.disabled !== true);
      if (!key) throw new Error('Start a new chat to create its Discord channel first.');
      enqueue(key, 'Cheshi Discord 연결 테스트입니다.', true); await schedule(flush); return snapshot();
    },
    start: connect,
    dispose() { disposed = true; epoch++; clearInterval(timer); clearTimeout(connectionRetry); gateway?.stop(); lifetime.abort(); for (const tracker of trackers.values()) tracker.dispose(); targets.clear(); return work; },
  };
}
