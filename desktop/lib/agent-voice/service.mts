import { randomInt } from 'node:crypto';
import { parseVoiceFrame, voiceId, voiceRecord, voiceSocketUrl, voiceText } from '../../../connect/shared/voice-protocol.ts';
import { parseVoiceRequest, type VoiceSnapshot } from '../../shared/agent-voice.ts';
import { VoiceStorage, digest, matches, secret, type Device } from './storage.mts';
import { VoiceChats, type ChatAccess } from './chats.mts';
import { VoiceRealtime, type VoiceCallbacks, type VoiceClient } from './realtime.mts';

interface Pairing { token: string; roomId: string; expires: number }
interface Pending { peerId: string; id: string; token: string; name: string; code: string }
interface Call { peerId: string; device: Device; voice: Pick<VoiceRealtime, 'start' | 'stop' | 'speak'>; final: boolean; last: string; answer: { questionId: string; answerTo: string } | null; seen: Set<string> }
export interface VoiceOptions {
  directory: string; workspace: string; origin?: string; chats: ChatAccess;
  account(): string; ready(): Promise<void>; createClient(): VoiceClient;
  socket?(url: string): WebSocket;
  realtime?(callbacks: VoiceCallbacks): Pick<VoiceRealtime, 'start' | 'stop' | 'speak'>;
  deferAccountReady?: boolean;
}
/** Owns one workspace's approved phone connections, never a generic remote RPC endpoint. */
export class AgentVoice {
  private readonly options: VoiceOptions;
  private readonly storage: VoiceStorage;
  private readonly chats: VoiceChats;
  private socket: WebSocket | null = null;
  private pairing: Pairing | null = null;
  private pending: Pending | null = null;
  private peers = new Map<string, Device>();
  private call: Call | null = null;
  private ending: Promise<void> | null = null;
  private shutdownFailed = false;
  private error: string | null = null;
  private connected = false;
  private disposed = false;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval>;
  private pongAt = 0;
  private operation = Promise.resolve();
  private accountReady: boolean;
  constructor(options: VoiceOptions) {
    this.accountReady = options.deferAccountReady !== true;
    this.options = options; this.storage = new VoiceStorage(options.directory); this.chats = new VoiceChats(this.storage, options.chats);
    this.heartbeat = setInterval(() => {
      if (this.pairing && this.pairing.expires < Date.now()) { this.pairing = null; this.rejectPending(); }
      if (this.connected && Date.now() - this.pongAt > 75000) this.socket?.close();
      else if (this.connected) this.send({ type: 'ping' });
      this.publish();
    }, 15000); this.heartbeat.unref();
    if (this.storage.state.devices.length) this.connect();
  }
  get busy() { return this.call !== null || this.ending !== null || this.shutdownFailed; }
  snapshot(): VoiceSnapshot {
    return { configured: !!this.options.origin, connected: this.connected, error: this.error, calling: this.busy,
      link: this.pairing && this.options.origin ? `${this.options.origin}/#host=${digest(this.storage.state.token)}&pair=${this.pairing.token}` : null,
      expiresAt: this.pairing?.expires ?? null,
      pending: this.pending ? { id: this.pending.peerId, name: this.pending.name, code: this.pending.code } : null,
      devices: this.storage.state.devices.map(({ id, name, roomId, roomName }) => ({ id, name, roomId, roomName })) };
  }
  async request(value: unknown) {
    const r = parseVoiceRequest(value);
    if (r.action === 'stop') await this.end();
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
      if (this.call?.device.id === r.id) await this.end();
    }
    return this.snapshot();
  }
  private rejectPending() {
    if (this.pending) this.send({ type: 'reject', peerId: this.pending.peerId }); this.pending = null;
  }
  private send(value: unknown) { if (this.socket?.readyState === 1) this.socket.send(JSON.stringify(value)); }
  private event(peerId: string, payload: unknown) { this.send({ type: 'event', peerId, payload }); }
  private connect() {
    if (this.disposed || this.socket || !this.options.origin) return;
    if (this.retry) { clearTimeout(this.retry); this.retry = null; }
    try {
      const socket = (this.options.socket ?? (url => new WebSocket(url)))(voiceSocketUrl(this.options.origin)); this.socket = socket;
      socket.onopen = () => this.send({ type: 'authenticate', role: 'host', hostId: digest(this.storage.state.token), token: this.storage.state.token });
      socket.onmessage = event => {
        if (socket !== this.socket) return;
        this.operation = this.operation.then(async () => { if (socket === this.socket) await this.receive(parseVoiceFrame(String(event.data))); })
          .catch(() => { this.error = 'A phone request failed. Check the phone and Chats for its delivery status.'; });
      };
      socket.onerror = () => { this.error = 'Cannot reach the connection service.'; };
      socket.onclose = () => {
        if (socket !== this.socket) return;
        this.socket = null; this.connected = false; this.pending = null; this.peers.clear(); void this.end();
        if (!this.disposed && (this.storage.state.devices.length || this.pairing)) this.retry = setTimeout(() => this.connect(), 5000);
      };
    } catch { this.error = 'Invalid or unavailable connection service.'; }
  }
  private async receive(frame: Record<string, unknown>) {
    if (frame.type === 'ready' || frame.type === 'pong') { this.connected = true; this.pongAt = Date.now(); this.error = null; return; }
    const peerId = voiceId(frame.peerId);
    if (frame.type === 'hello') {
      await this.options.ready();
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
      if (this.call?.peerId === peerId) await this.end(); return;
    }
    const device = this.peers.get(peerId);
    if (!device || frame.type !== 'request') return;
    try {
      if (device.account !== this.options.account()) throw new Error('Pair this phone again after switching accounts.');
      this.chats.room(device.roomId);
      const payload = voiceRecord(frame.payload);
      if (payload.type === 'hangup') { if (this.call?.peerId === peerId) await this.end(); return; }
      if (payload.type === 'status') { this.event(peerId, { type: 'room', ...this.chats.view(device) }); return; }
      if (payload.type === 'answer') {
        if (this.call?.peerId !== peerId) throw new Error('Start a call first.');
        const questionId = voiceId(payload.questionId), answerTo = voiceId(payload.answerTo);
        if (!this.chats.view(device).questions.some(q => q.id === questionId && q.answerTo === answerTo)) throw new Error('Question is no longer available.');
        this.call.answer = { questionId, answerTo }; return;
      }
      if (payload.type !== 'call') throw new Error('Unknown phone request.');
      if (this.busy) throw new Error('Another call is active or still ending.');
      this.chats.reconcile(device);
      const callbacks: VoiceCallbacks = {
        sdp: sdp => this.event(peerId, { type: 'sdp', sdp }),
        transcript: (role, text, final) => this.transcript(peerId, role, text, final),
        failed: message => { this.event(peerId, { type: 'error', message }); void this.end(); },
        closed: () => { void this.end(); },
      };
      const voice = this.options.realtime?.(callbacks) ?? new VoiceRealtime(this.options.createClient(), this.options.workspace, callbacks);
      this.call = { peerId, device, voice, final: false, last: '', answer: null, seen: new Set() };
      // Do not block hangup behind asynchronous provider startup.
      void voice.start(voiceText(payload.sdp, 64000)).then(() => this.publish()).catch(() => {
        if (this.call?.voice === voice) { this.event(peerId, { type: 'error', message: 'Voice startup failed. Check ChatGPT login and voice availability on the Mac.' }); void this.end(); }
      });
    } catch (error) { this.event(peerId, { type: 'error', message: error instanceof Error ? error.message : 'Phone request failed.' }); }
  }
  private allow(peerId: string, device: Device) {
    for (const [other, d] of this.peers) if (d.id === device.id) { this.send({ type: 'reject', peerId: other }); this.peers.delete(other); }
    this.peers.set(peerId, device); this.send({ type: 'approve', peerId });
    this.event(peerId, { type: 'room', ...this.chats.view(device) });
  }
  private transcript(peerId: string, role: string, text: string, final: boolean) {
    const call = this.call; if (!call || call.peerId !== peerId || !['user', 'assistant'].includes(role)) return;
    this.event(peerId, { type: 'transcript', role, text: text.slice(0, 16000), final });
    if (role !== 'user') return;
    if (!final) { call.final = false; return; }
    if (call.final && call.last === text) return;
    call.final = true; call.last = text;
    try {
      const id = this.chats.deliver(call.device, voiceText(text), call.answer); call.answer = null;
      this.event(peerId, { type: 'receipt', id, text }); call.voice.speak('연결된 Chats 방에 전달했습니다.'); this.publish();
    } catch (error) { this.event(peerId, { type: 'error', message: error instanceof Error ? error.message : 'Instruction was not accepted.' }); }
  }
  private publish() {
    const call = this.call; if (!call) return;
    try {
      const view = this.chats.view(call.device); this.event(call.peerId, { type: 'room', ...view });
      for (const q of view.questions) if (!call.seen.has(`q:${q.id}`)) { call.seen.add(`q:${q.id}`); call.voice.speak(q.text); }
      for (const m of view.messages) if (m.sender !== 'user' && !call.seen.has(m.id)) { call.seen.add(m.id); call.voice.speak(m.text); }
    } catch { this.event(call.peerId, { type: 'error', message: 'The linked room is unavailable.' }); void this.end(); }
  }
  async end() {
    const call = this.call; this.call = null;
    if (!call) { await this.ending; return; }
    this.event(call.peerId, { type: 'ended' });
    this.ending = call.voice.stop().catch(() => { this.shutdownFailed = true; this.error = 'Could not confirm voice process shutdown. Close this workspace before calling again.'; });
    try { await this.ending; } finally { this.ending = null; }
  }
  resetAccount() {
    // Restoring the saved profile at startup is not a user account switch.
    if (!this.accountReady) return;
    this.storage.state.devices = []; this.storage.save(); this.pairing = null; this.rejectPending();
    this.peers.clear(); this.socket?.close(); void this.end();
  }
  accountsReady() { this.accountReady = true; }
  async dispose() {
    this.disposed = true; clearInterval(this.heartbeat); if (this.retry) clearTimeout(this.retry);
    this.socket?.close(); await this.end();
  }
}
