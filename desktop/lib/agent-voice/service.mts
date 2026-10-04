import { randomInt } from 'node:crypto';
import { parseVoiceFrame, voiceId, voiceRecord, voiceSocketUrl, voiceText, VOICE_RECONNECT_MS, VOICE_END_MESSAGES, voiceEndReason, type VoiceEndReason } from '../../../connect/shared/voice-protocol.ts';
import { parseVoiceRequest, type VoiceSnapshot } from '../../shared/agent-voice.ts';
import { VoiceStorage, digest, matches, secret, type Device } from './storage.mts';
import { VoiceChats, type ChatAccess } from './chats.mts';
import { VoiceDiagnostics } from './diagnostics.mts';
import { VoiceRealtime, type VoiceCallbacks, type VoiceClient } from './realtime.mts';

interface Pairing { token: string; roomId: string; expires: number }
interface Pending { peerId: string; id: string; token: string; name: string; code: string }
interface Call { id: string; peerId: string | null; sdp: string | null; receipts: { id: string; text: string }[]; expires: number | null; timer: ReturnType<typeof setTimeout> | null; device: Device; voice: Pick<VoiceRealtime, 'start' | 'stop' | 'speak'>; final: boolean; last: string; answer: { questionId: string; answerTo: string } | null; seen: Set<string> }
export interface VoiceOptions {
  directory: string; workspace: string; origin?: string; chats: ChatAccess;
  account(): string; ready(): Promise<void>; createClient(): VoiceClient;
  socket?(url: string): WebSocket;
  realtime?(callbacks: VoiceCallbacks): Pick<VoiceRealtime, 'start' | 'stop' | 'speak'>;
  deferAccountReady?: boolean;
  reconnectMs?: number;
  retryMs?: number;
}
/** Owns one workspace's approved phone connections, never a generic remote RPC endpoint. */
export class AgentVoice {
  private readonly options: VoiceOptions;
  private readonly storage: VoiceStorage;
  private readonly chats: VoiceChats;
  private readonly diagnostics: VoiceDiagnostics;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private socket: WebSocket | null = null;
  private pairing: Pairing | null = null;
  private pending: Pending | null = null;
  private peers = new Map<string, Device>();
  private call: Call | null = null;
  private ending: Promise<void> | null = null;
  private shutdownFailed = false;
  private error: string | null = null;
  private connectionError: string | null = null;
  private connected = false;
  private disposed = false;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval>;
  private pongAt = 0;
  private operation = Promise.resolve();
  private accountReady: boolean;
  constructor(options: VoiceOptions) {
    this.diagnostics = new VoiceDiagnostics(options.directory);
    this.accountReady = options.deferAccountReady !== true;
    this.options = options; this.storage = new VoiceStorage(options.directory); this.chats = new VoiceChats(this.storage, options.chats);
    this.heartbeat = setInterval(() => {
      if (this.pairing && this.pairing.expires < Date.now()) { this.pairing = null; this.rejectPending(); }
      if (this.connected && Date.now() - this.pongAt > 75000) { this.diagnostics.record('heartbeat-timeout'); if (this.socket) this.disconnect(this.socket); }
      else if (this.connected) this.send({ type: 'ping' });
      this.publish();
    }, 15000); this.heartbeat.unref();
    if (this.storage.state.devices.length) this.connect();
  }
  get busy() { return this.call !== null || this.ending !== null || this.shutdownFailed; }
  snapshot(): VoiceSnapshot {
    return { configured: !!this.options.origin, connected: this.connected, error: this.error ?? this.connectionError, calling: this.busy,
      link: this.pairing && this.options.origin ? `${this.options.origin}/#host=${digest(this.storage.state.token)}&pair=${this.pairing.token}` : null,
      expiresAt: this.pairing?.expires ?? null,
      pending: this.pending ? { id: this.pending.peerId, name: this.pending.name, code: this.pending.code } : null,
      devices: this.storage.state.devices.map(({ id, name, roomId, roomName }) => ({ id, name, roomId, roomName })) };
  }
  async request(value: unknown) {
    const r = parseVoiceRequest(value);
    if (r.action === 'stop') await this.end('hangup');
    if (r.action === 'pair') {
      await this.options.ready(); this.chats.room(r.roomId);
      if (!this.options.origin) throw new Error('The connection service has not been configured for this build.');
      voiceSocketUrl(this.options.origin);
      this.rejectPending(); this.pairing = { token: secret(), roomId: r.roomId, expires: Date.now() + 120000 }; this.connect();
    }
    if (r.action === 'reject' && this.pending?.peerId === r.id) this.rejectPending();
    if (r.action === 'approve') {
      const pending = this.pending, pairing = this.pairing;
      if (!pending || pending.peerId !== r.id || !pairing || pairing.expires < Date.now()) throw new Error('Pairing expired. Create a new link.');
      if (this.storage.state.devices.length >= 32) throw new Error('Remove a linked phone before adding another.');
      const room = this.chats.room(pairing.roomId);
      const device: Device = { id: pending.id, name: pending.name, hash: digest(pending.token), account: this.options.account(),
        roomId: room.id, roomName: room.name, threadId: null };
      if (this.storage.state.devices.some(d => d.id === device.id)) throw new Error('This phone is already paired.');
      this.storage.state.devices.push(device); this.storage.save();
      this.pending = null; this.pairing = null; this.allow(pending.peerId, device);
    }
    if (r.action === 'revoke') {
      this.storage.state.devices = this.storage.state.devices.filter(d => d.id !== r.id); this.storage.save();
      for (const [peerId, device] of this.peers) if (device.id === r.id) { this.send({ type: 'reject', peerId }); this.peers.delete(peerId); }
      if (this.call?.device.id === r.id) await this.end('revoked');
    }
    return this.snapshot();
  }
  private rejectPending() {
    if (this.pending) this.send({ type: 'reject', peerId: this.pending.peerId }); this.pending = null;
  }
  private send(value: unknown) { if (this.socket?.readyState === 1) this.socket.send(JSON.stringify(value)); }
  private event(peerId: string | null, payload: unknown) { if (peerId) this.send({ type: 'event', peerId, payload }); }
  private callEvent(call: Call, payload: Record<string, unknown>) {
    if (this.call === call) this.event(call.peerId, { ...payload, callId: call.id });
  }
  private suspendCall(reason: 'host-disconnected' | 'phone-disconnected') {
    const call = this.call; if (!call) return;
    call.peerId = null;
    if (call.expires !== null) return;
    const delay = this.options.reconnectMs ?? VOICE_RECONNECT_MS;
    call.expires = Date.now() + delay;
    this.diagnostics.record('call-suspended', { reason });
    call.timer = setTimeout(() => { if (this.call === call) void this.end('control-timeout'); }, delay);
    call.timer.unref();
  }
  private scheduleReconnect() {
    if (this.disposed || this.retry || !(this.storage.state.devices.length || this.pairing)) return;
    this.retry = setTimeout(() => { this.retry = null; this.connect(); }, this.options.retryMs ?? 1000);
    this.retry.unref();
  }
  private clearConnectTimer() { if (this.connectTimer) clearTimeout(this.connectTimer); this.connectTimer = null; }
  private disconnect(socket: WebSocket, code?: number) {
    if (socket !== this.socket) return;
    this.clearConnectTimer(); this.diagnostics.record('control-close', { code });
    this.socket = null; this.connected = false; this.pending = null; this.peers.clear();
    socket.close();
    if (code === 1008 || code === 1003) { void this.end('control-rejected'); return; }
    this.suspendCall('host-disconnected'); this.scheduleReconnect();
  }
  private connect() {
    if (this.disposed || this.socket || !this.options.origin) return;
    if (this.retry) { clearTimeout(this.retry); this.retry = null; }
    try {
      const socket = (this.options.socket ?? (url => new WebSocket(url)))(voiceSocketUrl(this.options.origin)); this.socket = socket;
      this.clearConnectTimer();
      this.connectTimer = setTimeout(() => { if (socket === this.socket && !this.connected) this.disconnect(socket); }, 10000);
      this.connectTimer.unref();
      socket.onopen = () => { if (socket === this.socket) this.send({ type: 'authenticate', role: 'host', hostId: digest(this.storage.state.token), token: this.storage.state.token }); };
      socket.onmessage = event => {
        if (socket !== this.socket) return;
        this.operation = this.operation.then(async () => { if (socket === this.socket) await this.receive(parseVoiceFrame(String(event.data)), socket); })
          .catch(() => { this.error = 'A phone request failed. Check the phone and Chats for its delivery status.'; });
      };
      socket.onerror = () => { if (socket !== this.socket) return; this.diagnostics.record('control-error'); this.connectionError = 'Cannot reach the connection service.'; };
      socket.onclose = event => this.disconnect(socket, event?.code);
    } catch { this.connectionError = 'Invalid or unavailable connection service.'; this.scheduleReconnect(); }
  }
  private async receive(frame: Record<string, unknown>, socket: WebSocket) {
    if (frame.type === 'ready' || frame.type === 'pong') {
      if (!this.connected) this.diagnostics.record('control-open');
      this.clearConnectTimer(); this.connected = true; this.connectionError = null; this.pongAt = Date.now(); return;
    }
    const peerId = voiceId(frame.peerId);
    if (frame.type === 'hello') {
      await this.options.ready();
      if (socket !== this.socket) return;
      const id = voiceId(frame.deviceId), token = voiceText(frame.token, 128);
      const device = this.storage.state.devices.find(d => d.id === id && matches(d.hash, digest(token)) && d.account === this.options.account());
      if (device) { this.chats.room(device.roomId); this.allow(peerId, device); return; }
      if (!this.pairing || this.pending || this.pairing.expires < Date.now() || typeof frame.pairing !== 'string' || !matches(this.pairing.token, frame.pairing)) {
        this.send({ type: 'reject', peerId }); return;
      }
      this.pending = { peerId, id, token, name: voiceText(frame.name, 80), code: String(randomInt(100000, 1000000)) };
      this.send({ type: 'challenge', peerId, code: this.pending.code }); return;
    }
    if (frame.type === 'disconnected') {
      this.peers.delete(peerId); if (this.pending?.peerId === peerId) this.pending = null;
      if (this.call?.peerId === peerId) this.suspendCall('phone-disconnected'); return;
    }
    const device = this.peers.get(peerId);
    if (!device || frame.type !== 'request') return;
    try {
      if (device.account !== this.options.account()) throw new Error('Pair this phone again after switching accounts.');
      this.chats.room(device.roomId);
      const payload = voiceRecord(frame.payload);
      if (payload.type === 'resume') {
        const id = voiceId(payload.callId), call = this.call;
        if (!call || call.id !== id || call.device.id !== device.id || call.device.account !== device.account
          || call.device.roomId !== device.roomId || (call.expires !== null && call.expires <= Date.now())) {
          this.event(peerId, { type: 'ended', callId: id, reason: 'session-lost' }); return;
        }
        this.chats.reconcile(device);
        if (call.timer) clearTimeout(call.timer); call.timer = null; call.expires = null; call.peerId = peerId;
        this.diagnostics.record('call-resumed'); this.error = null;
        this.callEvent(call, { type: 'resumed' });
        if (call.sdp) this.callEvent(call, { type: 'sdp', sdp: call.sdp });
        for (const receipt of call.receipts) this.callEvent(call, { type: 'receipt', ...receipt });
        this.publish(); return;
      }
      if (payload.type === 'hangup') {
        const call = this.call;
        if (call && call.device.id === device.id && call.id === voiceId(payload.callId)) await this.end(voiceEndReason(payload.reason ?? 'hangup'));
        return;
      }
      if (payload.type === 'status') { this.event(peerId, { type: 'room', ...this.chats.view(device) }); return; }
      if (payload.type === 'answer') {
        if (this.call?.peerId !== peerId || this.call.id !== voiceId(payload.callId)) throw new Error('Start a call first.');
        const questionId = voiceId(payload.questionId), answerTo = voiceId(payload.answerTo);
        if (!this.chats.view(device).questions.some(q => q.id === questionId && q.answerTo === answerTo)) throw new Error('Question is no longer available.');
        this.call.answer = { questionId, answerTo }; return;
      }
      if (payload.type !== 'call') throw new Error('Unknown phone request.');
      const id = voiceId(payload.callId);
      if (this.busy) { this.event(peerId, { type: 'ended', callId: id, reason: 'session-lost' }); return; }
      const sdp = voiceText(payload.sdp, 64000);
      this.chats.reconcile(device);
      let call: Call;
      const callbacks: VoiceCallbacks = {
        sdp: sdp => { if (this.call !== call) return; call.sdp = sdp; this.callEvent(call, { type: 'sdp', sdp }); },
        transcript: (role, text, final) => { if (this.call === call) this.transcript(call, role, text, final); },
        failed: () => { if (this.call === call) void this.end('provider-error'); },
        closed: () => { if (this.call === call) void this.end('provider-closed'); },
      };
      const voice = this.options.realtime?.(callbacks) ?? new VoiceRealtime(this.options.createClient(), this.options.workspace, callbacks);
      call = { id, peerId, device, voice, sdp: null, receipts: [], expires: null, timer: null, final: false, last: '', answer: null, seen: new Set() };
      this.call = call; this.error = null; this.diagnostics.record('call-start');
      // Do not block hangup behind asynchronous provider startup.
      void voice.start(sdp).then(() => { if (this.call === call) this.publish(); }).catch(() => {
        if (this.call === call) void this.end('startup-failed');
      });
    } catch (error) { this.event(peerId, { type: 'error', message: error instanceof Error ? error.message : 'Phone request failed.' }); }
  }
  private allow(peerId: string, device: Device) {
    for (const [other, d] of this.peers) if (other !== peerId && d.id === device.id) { if (this.call?.peerId === other) this.suspendCall('phone-disconnected'); this.send({ type: 'reject', peerId: other }); this.peers.delete(other); }
    this.peers.set(peerId, device); this.send({ type: 'approve', peerId });
    this.event(peerId, { type: 'room', ...this.chats.view(device) });
  }
  private transcript(call: Call, role: string, text: string, final: boolean) {
    if (this.call !== call || !['user', 'assistant'].includes(role)) return;
    if (call.device.account !== this.options.account() || !this.storage.state.devices.includes(call.device)) { void this.end('account-changed'); return; }
    if (call.expires !== null && call.expires <= Date.now()) { void this.end('control-timeout'); return; }
    this.callEvent(call, { type: 'transcript', role, text: text.slice(0, 16000), final });
    if (role !== 'user') return;
    if (!final) { call.final = false; return; }
    if (call.final && call.last === text) return;
    call.final = true; call.last = text;
    try {
      const id = this.chats.deliver(call.device, voiceText(text), call.answer); call.answer = null;
      call.receipts.push({ id, text }); call.receipts = call.receipts.slice(-20);
      this.callEvent(call, { type: 'receipt', id, text }); call.voice.speak('연결된 Chats 방에 전달했습니다.'); this.publish();
    } catch (error) { this.callEvent(call, { type: 'error', message: error instanceof Error ? error.message : 'Instruction was not accepted.' }); }
  }
  private publish() {
    const call = this.call; if (!call) return;
    try {
      const view = this.chats.view(call.device); this.callEvent(call, { type: 'room', ...view });
      for (const q of view.questions) if (!call.seen.has(`q:${q.id}`)) { call.seen.add(`q:${q.id}`); call.voice.speak(q.text); }
      for (const m of view.messages) if (m.sender !== 'user' && !call.seen.has(m.id)) { call.seen.add(m.id); call.voice.speak(m.text); }
    } catch { void this.end('room-unavailable'); }
  }
  async end(reason: VoiceEndReason = 'hangup') {
    const call = this.call; this.call = null;
    if (!call) { await this.ending; return; }
    if (call.timer) clearTimeout(call.timer);
    this.diagnostics.record('call-ended', { reason });
    if (reason !== 'hangup') this.error = VOICE_END_MESSAGES[reason];
    this.event(call.peerId, { type: 'ended', callId: call.id, reason });
    this.ending = call.voice.stop().catch(() => { this.shutdownFailed = true; this.error = 'Could not confirm voice process shutdown. Close this workspace before calling again.'; });
    try { await this.ending; } finally { this.ending = null; }
  }
  resetAccount() {
    // Restoring the saved profile at startup is not a user account switch.
    if (!this.accountReady) return;
    this.storage.state.devices = []; this.storage.save(); this.pairing = null; this.rejectPending();
    void this.end('account-changed'); this.peers.clear(); this.socket?.close();
  }
  accountsReady() { this.accountReady = true; }
  async dispose() {
    this.disposed = true; clearInterval(this.heartbeat); if (this.retry) clearTimeout(this.retry);
    this.clearConnectTimer(); await this.end('shutdown'); this.socket?.close();
  }
}
