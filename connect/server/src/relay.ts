import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { parseVoiceFrame, voiceId, voiceText } from '../../shared/voice-protocol.ts';

export interface RelaySocket { send(text: string): unknown; close(code?: number, reason?: string): unknown }
interface Peer { socket: RelaySocket; role: 'host' | 'phone'; host: string; id: string; approved: boolean; count: number; window: number }
/** No account credentials, recordings, SDP or conversation bodies are persisted here. */
export class VoiceRelay {
  private readonly peers = new Map<RelaySocket, Peer>();
  private readonly hosts = new Map<string, Peer>();
  private readonly timers = new Map<RelaySocket, ReturnType<typeof setTimeout>>();
  constructor(privateLimit = 1024) { this.limit = privateLimit; }
  private readonly limit: number;
  opened(socket: RelaySocket) {
    if (this.timers.size + this.peers.size >= this.limit) { socket.close(1013, 'Service at capacity'); return; }
    const timer = setTimeout(() => socket.close(1008, 'Authentication expired'), 15000);
    timer.unref(); this.timers.set(socket, timer);
  }
  private send(peer: Peer, value: unknown) { peer.socket.send(JSON.stringify(value)); }
  receive(socket: RelaySocket, text: string) {
    try {
      const value = parseVoiceFrame(text), peer = this.peers.get(socket);
      if (!peer) { this.authenticate(socket, value); return; }
      const now = Date.now();
      if (now - peer.window > 10000) { peer.window = now; peer.count = 0; }
      if (++peer.count > 160) throw new Error('Rate limit');
      if (value.type === 'ping') { this.send(peer, { type: 'pong' }); return; }
      if (peer.role === 'host') {
        const target = [...this.peers.values()].find(p => p.role === 'phone' && p.host === peer.host && p.id === value.peerId);
        if (!target) return;
        if (value.type === 'challenge' && !target.approved) { this.send(target, { type: 'challenge', code: voiceText(value.code, 6) }); return; }
        if (value.type === 'approve') {
          target.approved = true; clearTimeout(this.timers.get(target.socket)); this.timers.delete(target.socket);
          this.send(target, { type: 'approved' }); return;
        }
        if (value.type === 'reject') { target.socket.close(1008, 'Connection declined'); return; }
        if (value.type !== 'event' || !target.approved) throw new Error('Invalid host frame');
        this.send(target, { type: 'event', payload: value.payload });
      } else {
        if (!peer.approved || value.type !== 'request') throw new Error('Device approval required');
        const host = this.hosts.get(peer.host); if (!host) { socket.close(1013, 'Mac reconnecting'); return; }
        this.send(host, { type: 'request', peerId: peer.id, payload: value.payload });
      }
    } catch { socket.close(1008, 'Invalid or unauthorized connection'); }
  }
  private authenticate(socket: RelaySocket, value: Record<string, unknown>) {
    if (!this.timers.has(socket) || value.type !== 'authenticate') throw new Error('Authentication required');
    const host = voiceId(value.hostId), now = Date.now();
    if (value.role === 'host') {
      const hash = createHash('sha256').update(voiceText(value.token, 128)).digest('hex');
      if (host.length !== hash.length || !timingSafeEqual(Buffer.from(host), Buffer.from(hash))) throw new Error('Invalid identity');
      if (this.hosts.has(host)) { socket.close(1013, 'Host reconnecting'); return; }
      const peer: Peer = { socket, role: 'host', host, id: host, approved: true, count: 0, window: now };
      this.peers.set(socket, peer); this.hosts.set(host, peer);
      clearTimeout(this.timers.get(socket)); this.timers.delete(socket);
      this.send(peer, { type: 'ready' });
    } else if (value.role === 'phone') {
      const owner = this.hosts.get(host); if (!owner) { socket.close(1013, 'Mac reconnecting'); return; }
      if ([...this.peers.values()].filter(p => p.host === host && p.role === 'phone').length >= 8) throw new Error('Too many phones');
      const peer: Peer = { socket, role: 'phone', host, id: randomUUID(), approved: false, count: 0, window: now };
      this.peers.set(socket, peer);
      clearTimeout(this.timers.get(socket));
      const timer = setTimeout(() => socket.close(1008, 'Approval expired'), 120000); timer.unref(); this.timers.set(socket, timer);
      this.send(owner, { type: 'hello', peerId: peer.id, deviceId: voiceId(value.deviceId),
        token: voiceText(value.token, 128), name: voiceText(value.name, 80),
        pairing: typeof value.pairing === 'string' ? voiceText(value.pairing, 128) : null });
    } else throw new Error('Invalid role');
  }
  closed(socket: RelaySocket) {
    clearTimeout(this.timers.get(socket)); this.timers.delete(socket);
    const peer = this.peers.get(socket); this.peers.delete(socket);
    if (!peer) return;
    if (peer.role === 'host') {
      if (this.hosts.get(peer.host) === peer) this.hosts.delete(peer.host);
      for (const other of this.peers.values()) if (other.host === peer.host) other.socket.close(1012, 'Mac disconnected');
    } else {
      const host = this.hosts.get(peer.host); if (host) this.send(host, { type: 'disconnected', peerId: peer.id });
    }
  }
  dispose() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    for (const socket of new Set([...this.timers.keys(), ...this.peers.keys()])) socket.close(1001, 'Service restarting');
    this.timers.clear(); this.peers.clear(); this.hosts.clear();
  }
}
