import { afterEach, describe, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import config from '../../forge.config.mts';
import { AgentVoice } from '../lib/agent-voice/service.mts';
import { VoiceStorage, type Device } from '../lib/agent-voice/storage.mts';
import { VoiceChats } from '../lib/agent-voice/chats.mts';
import { VoiceRealtime, type VoiceCallbacks, type VoiceClient } from '../lib/agent-voice/realtime.mts';
import { createAgentVoiceApi } from '../lib/agent-voice-preload.cts';
import { parseVoiceSnapshot } from '../shared/agent-voice.ts';
import type { ChatsRequest, ChatsSnapshot } from '../shared/agent-chats.ts';
import type { JsonObject } from '../lib/codex-chat-types.mts';

const directories: string[] = [];
const directory = () => { const result = mkdtempSync(path.join(os.tmpdir(), 'cheshi-voice-test-')); directories.push(result); return result; };
afterEach(() => { directories.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });
async function rejected(operation: Promise<unknown>, pattern: RegExp) {
  let error: unknown; try { await operation; } catch (e) { error = e; }
  expect(error).toBeInstanceOf(Error); expect((error as Error).message).toMatch(pattern);
}
async function until(predicate: () => boolean) {
  const end = Date.now() + 2000;
  while (!predicate()) { if (Date.now() > end) throw new Error('Missing expected voice event.'); await new Promise(resolve => setTimeout(resolve, 1)); }
}
function chats() {
  const state: ChatsSnapshot = { rooms: [{ id: 'room', workspace: '/test', name: 'Test room', engineId: 'docker:local',
    members: [{ id: 'agent', accountId: 'account', name: 'Homie' }], defaultAgentId: 'agent', createdAt: 'now' }], messages: [] };
  const sent: Extract<ChatsRequest, { action: 'send' }>[] = [];
  const request = (r: ChatsRequest) => {
    if (r.action === 'send') {
      sent.push(r);
      if (!state.messages.some(m => m.id === r.id)) state.messages.push({ id: r.id, roomId: r.roomId, threadId: r.threadId, sender: 'user', recipient: 'agent', kind: 'message', text: r.text, createdAt: 'now', status: 'queued' });
    }
    return state;
  };
  return { state, sent, request };
}
class Socket {
  readyState = 1;
  frames: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send(text: string) { this.frames.push(JSON.parse(text)); }
  close() { this.readyState = 3; this.onclose?.(); }
  receive(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
}
async function host(deferAccountReady = false) {
  const data = chats(), socket = new Socket(); let callbacks!: VoiceCallbacks, stopped = 0;
  const voice = new AgentVoice({ directory: directory(), workspace: '/test', origin: 'https://connect.example', chats: data.request,
    deferAccountReady,
    account: () => 'account', ready: async () => {}, createClient: () => { throw new Error('Use fake voice.'); },
    socket: () => socket as unknown as WebSocket,
    realtime: value => { callbacks = value; return { start: async () => {}, stop: async () => { stopped++; }, speak: () => {} }; },
  });
  await voice.request({ action: 'pair', roomId: 'room' });
  const pairing = new URLSearchParams(new URL(voice.snapshot().link!).hash.slice(1)).get('pair');
  socket.onopen?.(); socket.receive({ type: 'ready' });
  socket.receive({ type: 'hello', peerId: 'peer', deviceId: 'phone', name: 'Test phone', token: 'test-device-secret', pairing });
  await until(() => !!voice.snapshot().pending);
  await voice.request({ action: 'approve', id: 'peer' });
  return { ...data, socket, voice, callbacks: () => callbacks, stopped: () => stopped,
    call: async () => { socket.receive({ type: 'request', peerId: 'peer', payload: { type: 'call', sdp: 'offer' } }); await until(() => voice.busy); } };
}

describe('voice authorization and durable Chats delivery', () => {
  test('partial transcripts never dispatch and repeated final event dispatches once', async () => {
    const h = await host();
    try {
      await h.call(); h.callbacks().transcript('user', '로그인', false); expect(h.sent).toHaveLength(0);
      h.callbacks().transcript('user', '로그인 폼 만들어줘', true); h.callbacks().transcript('user', '로그인 폼 만들어줘', true);
      expect(h.sent).toHaveLength(1); expect(h.sent[0]?.automatic).toBe(true); expect(h.sent[0]?.roomId).toBe('room');
      h.socket.receive({ type: 'request', peerId: 'peer', payload: { type: 'hangup' } });
      await until(() => !h.voice.busy); expect(h.stopped()).toBe(1); expect(h.state.messages).toHaveLength(1);
    } finally { await h.voice.dispose(); }
  });
  test('unknown phones and raw phone text cannot bypass approval or transcription', async () => {
    const h = await host();
    try {
      h.socket.receive({ type: 'request', peerId: 'stranger', payload: { type: 'call', sdp: 'offer' } });
      h.socket.receive({ type: 'request', peerId: 'peer', payload: { type: 'send', text: 'run arbitrary command' } });
      await until(() => h.socket.frames.some(f => (f.payload as JsonObject)?.type === 'error'));
      expect(h.voice.busy).toBe(false); expect(h.sent).toHaveLength(0);
      await h.voice.request({ action: 'revoke', id: 'phone' }); expect(h.voice.snapshot().devices).toHaveLength(0);
      expect(h.socket.frames.some(f => f.type === 'reject')).toBe(true);
    } finally { await h.voice.dispose(); }
  });
  test('account reset revokes phones and closes the call', async () => {
    const h = await host();
    try { await h.call(); h.voice.resetAccount(); expect(h.voice.snapshot().devices).toHaveLength(0); await until(() => !h.voice.busy); expect(h.stopped()).toBe(1); }
    finally { await h.voice.dispose(); }
  });
  test('restoring the saved account at startup preserves approvals; a later switch revokes them', async () => {
    const h = await host(true);
    try {
      h.voice.resetAccount(); expect(h.voice.snapshot().devices).toHaveLength(1);
      h.voice.accountsReady(); h.voice.resetAccount(); expect(h.voice.snapshot().devices).toHaveLength(0);
    } finally { await h.voice.dispose(); }
  });
  test('answers must explicitly identify a pending question', async () => {
    const h = await host();
    try {
      await h.call(); h.callbacks().transcript('user', '로그인', true);
      h.state.messages[0]!.dialogue = { userText: '로그인', questions: [{ id: 'q1', text: '이메일만 지원할까요?', answer: null }], revisions: [] };
      h.state.messages[0]!.status = 'completed';
      h.callbacks().transcript('user', '이메일만', false); h.callbacks().transcript('user', '이메일만', true); expect(h.sent).toHaveLength(1);
      h.socket.receive({ type: 'request', peerId: 'peer', payload: { type: 'answer', questionId: 'q1', answerTo: h.sent[0]!.id } });
      await new Promise(resolve => setImmediate(resolve));
      h.callbacks().transcript('user', '네', false); h.callbacks().transcript('user', '네', true);
      expect(h.sent).toHaveLength(2); expect(h.sent[1]?.questionId).toBe('q1'); expect(h.sent[1]?.threadId).toBe(h.sent[0]?.id);
    } finally { await h.voice.dispose(); }
  });
  test('interrupted acknowledgments replay the same durable identity after restart', () => {
    const dir = directory(), storage = new VoiceStorage(dir), data = chats();
    const device: Device = { id: 'phone', hash: 'hash', account: 'account', name: 'Phone', roomId: 'room', roomName: 'Room', threadId: null };
    storage.state.devices.push(device); storage.save();
    let failed = false;
    const bridge = new VoiceChats(storage, r => { const result = data.request(r); if (r.action === 'send' && !failed) { failed = true; throw new Error('Interrupted acknowledgment'); } return result; });
    expect(() => bridge.deliver(device, 'Make a form', null)).toThrow();
    const restored = new VoiceStorage(dir), resumed = new VoiceChats(restored, data.request);
    expect(() => resumed.reconcile({ ...restored.state.devices[0]!, account: 'different-account' })).toThrow('account');
    resumed.reconcile(restored.state.devices[0]!);
    expect(data.sent).toHaveLength(2); expect(data.sent[0]?.id).toBe(data.sent[1]?.id); expect(data.state.messages).toHaveLength(1);
    expect(restored.state.pending).toHaveLength(0);
    expect(readFileSync(path.join(dir, 'voice.json'), 'utf8')).not.toContain('Interrupted acknowledgment');
  });
  test('missing room and mismatched question fail before dispatch', () => {
    const data = chats(), storage = new VoiceStorage(directory());
    const bridge = new VoiceChats(storage, data.request), device: Device = { id: 'd', hash: 'hash', account: 'a', name: 'P', roomId: 'room', roomName: 'R', threadId: null };
    expect(() => bridge.deliver(device, 'answer', { questionId: 'q', answerTo: 'other' })).toThrow();
    data.state.rooms = []; expect(() => bridge.deliver(device, 'request', null)).toThrow(); expect(data.sent).toHaveLength(0);
  });
});

function client(account = 'chatgpt') {
  const notifications = new Set<(event: JsonObject) => void>(), calls: { method: string; params: unknown }[] = [];
  let stops = 0;
  const transport: VoiceClient = {
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === 'account/read') return { account: { type: account } };
      if (method === 'config/read') return { config: { mcp_servers: { dangerous: { command: 'tool', enabled: true, timeout: null } } } };
      if (method === 'thread/start') return { thread: { id: 'thread', ephemeral: true } };
      return {};
    }, respond: async () => {}, onNotification: fn => { notifications.add(fn); return () => { notifications.delete(fn); }; },
    onRequest: () => () => {}, onDidFail: () => () => {}, stop: async () => { stops++; },
  };
  return { transport, calls, stops: () => stops, emit: (method: string, params: JsonObject) => notifications.forEach(fn => fn({ method, params: { threadId: 'thread', ...params } })) };
}
test('voice uses subscription v3 WebRTC and disables configured tools', async () => {
  const c = client(), answers: string[] = [], failures: string[] = [];
  const session = new VoiceRealtime(c.transport, '/tmp', { sdp: x => answers.push(x), failed: x => failures.push(x), transcript: () => {}, closed: () => {} });
  await session.start('offer');
  const start = c.calls.find(x => x.method === 'thread/start')!.params as JsonObject;
  expect(start.sandbox).toBe('read-only'); expect((start.config as JsonObject).mcp_servers).toEqual({ dangerous: { command: 'tool', enabled: false } });
  const realtime = c.calls.find(x => x.method === 'thread/realtime/start')!.params as JsonObject;
  expect(realtime.version).toBe('v3'); expect(realtime.transport).toEqual({ type: 'webrtc', sdp: 'offer' });
  c.emit('thread/realtime/sdp', { sdp: 'answer' }); expect(answers).toEqual(['answer']);
  c.emit('turn/started', {}); expect(failures).toHaveLength(1); expect(c.stops()).toBe(1);
  await session.stop(); expect(c.stops()).toBe(1);
});
test('API-key-only accounts cannot start voice', async () => {
  const c = client('apiKey'); const session = new VoiceRealtime(c.transport, '/tmp', { sdp: () => {}, failed: () => {}, transcript: () => {}, closed: () => {} });
  await rejected(session.start('offer'), /ChatGPT/); expect(c.calls.some(x => x.method === 'thread/start')).toBe(false); expect(c.stops()).toBe(1);
});
test('preload rejects truthy flags and strips unrelated fields', async () => {
  const raw = { configured: true, connected: false, calling: false, error: null, link: null, expiresAt: null, pending: null, devices: [] };
  expect(() => parseVoiceSnapshot({ ...raw, connected: 'true' })).toThrow();
  expect(await createAgentVoiceApi({ invoke: async () => ({ ...raw, token: 'not-for-renderer' }) }).request({ action: 'status' })).toEqual(raw);
});
test('packaging includes voice runtime and native Node loads its dependency chain', async () => {
  const ignore = (await config()).packagerConfig?.ignore; if (typeof ignore !== 'function') throw new Error('Missing package filter');
  for (const name of ['workspace', 'service', 'storage', 'chats', 'realtime']) expect(ignore(`/desktop/lib/agent-voice/${name}.mts`)).toBe(false);
  expect(ignore('/desktop/shared/agent-voice.ts')).toBe(false); expect(ignore('/desktop/lib/agent-voice/voice.json')).toBe(true);
  for (const entry of ['/connect', '/connect/shared', '/connect/shared/voice-protocol.ts']) expect(ignore(entry)).toBe(false);
  for (const entry of ['/connect/client', '/connect/server', '/connect/test', '/connect/shared/voice.json', '/connect/tsconfig.json']) expect(ignore(entry)).toBe(true);
  // Load only the shipped dependency tree, so a missing packaged import cannot
  // accidentally resolve from the source checkout.
  const root = path.resolve(import.meta.dirname, '../..'), packaged = directory(), copied = new Set<string>();
  const transpiler = new Bun.Transpiler({ loader: 'ts' });
  const copyRuntime = (relative: string) => {
    if (copied.has(relative)) return;
    expect(ignore(`/${relative}`)).toBe(false);
    const source = path.join(root, relative), target = path.join(packaged, relative);
    mkdirSync(path.dirname(target), { recursive: true }); copyFileSync(source, target); copied.add(relative);
    for (const dependency of transpiler.scan(readFileSync(source, 'utf8')).imports) {
      if (dependency.path.startsWith('.')) {
        copyRuntime(path.relative(root, path.resolve(path.dirname(source), dependency.path)));
      }
    }
  };
  writeFileSync(path.join(packaged, 'package.json'), JSON.stringify({ type: 'module' }));
  copyRuntime('desktop/lib/agent-voice/workspace.mts');
  expect(copied.has('connect/shared/voice-protocol.ts')).toBe(true);
  const result = spawnSync(process.env.CHESHI_TEST_NODE || 'node', ['--input-type=module', '-e', "await import('./desktop/lib/agent-voice/workspace.mts')"], { cwd: packaged, encoding: 'utf8' });
  expect(result.stderr).toBe(''); expect(result.status).toBe(0);
});
