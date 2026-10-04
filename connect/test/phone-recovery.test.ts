import { describe, expect, test } from 'bun:test';
import { PhoneConnection } from '../client/src/connection.ts';
import { PhoneCall } from '../client/src/call.ts';
import type { VoiceEndReason } from '../shared/voice-protocol.ts';

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 5));
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Missing phone event'); await tick(); }
}
class Socket {
  readyState = 1;
  sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  send(text: string) { this.sent.push(JSON.parse(text)); }
  close() { this.readyState = 3; }
  drop(code = 1006) { this.readyState = 3; this.onclose?.({ code }); }
  receive(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
}
function connection(recoveryMs = 100) {
  const sockets: Socket[] = [], ended: VoiceEndReason[] = [], frames: Record<string, unknown>[] = [];
  let interruptions = 0;
  const phone = new PhoneConnection({ url: 'wss://example.test/connect', retryMs: 1, recoveryMs,
    authenticate: () => ({ type: 'authenticate', deviceId: 'device', token: 'private-token' }),
    socket: () => { const socket = new Socket(); sockets.push(socket); return socket as unknown as WebSocket; },
    frame: frame => { frames.push(frame); }, changed: () => {}, interrupted: () => { interruptions++; }, ended: reason => ended.push(reason),
  });
  phone.start(); sockets[0]!.onopen?.(); sockets[0]!.receive({ type: 'approved' });
  return { phone, sockets, ended, frames, interruptions: () => interruptions };
}
describe('phone control recovery', () => {
  test('temporary close reauthenticates but deadline remains until call recovery is confirmed', async () => {
    const h = connection();
    try {
      await until(() => h.phone.approved); h.sockets[0]!.drop();
      expect(h.ended).toHaveLength(0); expect(h.interruptions()).toBe(1);
      await until(() => h.sockets.length === 2);
      const next = h.sockets[1]!; next.onopen?.(); next.receive({ type: 'approved' });
      await until(() => h.phone.approved);
      expect(next.sent[0]).toEqual(h.sockets[0]!.sent[0]);
      h.phone.send({ type: 'resume', callId: 'same-call' });
      await until(() => h.ended.length === 1);
      expect(h.ended).toEqual(['control-timeout']); expect(h.phone.active).toBe(false);
    } finally { h.phone.stop(); }
  });
  test('successful recovery clears deadline and stale socket events are ignored', async () => {
    const h = connection(50);
    try {
      await until(() => h.phone.approved); h.sockets[0]!.drop(1012);
      await until(() => h.sockets.length === 2); h.sockets[1]!.receive({ type: 'approved' });
      await until(() => h.phone.approved); h.phone.recovered();
      h.sockets[0]!.drop(1008); h.sockets[0]!.receive({ type: 'event', payload: 'stale' });
      await new Promise(resolve => setTimeout(resolve, 70));
      expect(h.ended).toHaveLength(0); expect(h.phone.approved).toBe(true); expect(h.frames).toHaveLength(2);
    } finally { h.phone.stop(); }
  });
  test('policy rejection stops retries and explicit stop cancels an outstanding retry', async () => {
    const h = connection();
    try {
      await until(() => h.phone.approved); h.sockets[0]!.drop(1008); await tick();
      expect(h.ended).toEqual(['control-rejected']); expect(h.sockets).toHaveLength(1);
      h.phone.start(); h.sockets[1]!.drop(); h.phone.stop(); await tick(); expect(h.sockets).toHaveLength(2);
    } finally { h.phone.stop(); }
  });
});
class Peer extends EventTarget {
  connectionState = 'new'; iceGatheringState = 'complete'; localDescription: { sdp: string } | null = null;
  remoteDescription: unknown = null; answers = 0; closed = false;
  onconnectionstatechange: (() => void) | null = null;
  ontrack: unknown;
  addTrack() {} createDataChannel() {}
  async createOffer() { return { sdp: 'offer' }; }
  async setLocalDescription(value: { sdp: string }) { this.localDescription = value; }
  async setRemoteDescription(value: unknown) { this.answers++; this.remoteDescription = value; }
  close() { this.closed = true; }
  state(value: string) { this.connectionState = value; this.onconnectionstatechange?.(); }
}
function media() {
  const peer = new Peer(), ended: VoiceEndReason[] = [], track = new EventTarget(); let stops = 0;
  Object.assign(track, { stop: () => { stops++; }, enabled: true });
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  const call = new PhoneCall({ srcObject: null } as HTMLAudioElement, () => {}, reason => ended.push(reason), {
    stream: async () => stream, peer: () => peer as unknown as RTCPeerConnection, recoveryMs: 25,
  });
  return { peer, call, ended, track, stops: () => stops };
}
describe('phone media recovery', () => {
  test('disconnected recovers without closing media; replayed SDP is idempotent', async () => {
    const h = media();
    try {
      await h.call.offer(); h.peer.state('disconnected'); expect(h.peer.closed).toBe(false);
      h.peer.state('connected'); await new Promise(resolve => setTimeout(resolve, 40));
      expect(h.ended).toHaveLength(0); expect(h.stops()).toBe(0);
      await Promise.all([h.call.answer('answer'), h.call.answer('answer')]); expect(h.peer.answers).toBe(1);
    } finally { h.call.close(); }
  });
  test('prolonged outage ends once and terminates microphone tracks', async () => {
    const h = media();
    try {
      await h.call.offer(); h.peer.state('disconnected'); h.peer.state('disconnected');
      await until(() => h.ended.length === 1);
      expect(h.ended).toEqual(['media-timeout']); expect(h.stops()).toBe(1); expect(h.peer.closed).toBe(true);
      h.peer.state('failed'); expect(h.ended).toHaveLength(1);
    } finally { h.call.close(); }
  });
  test('failed transport and ended microphone terminate immediately', async () => {
    const h = media(), second = media();
    try {
      await h.call.offer(); h.peer.state('failed'); expect(h.ended).toEqual(['media-failed']);
      await second.call.offer(); second.track.dispatchEvent(new Event('ended')); expect(second.ended).toEqual(['microphone-ended']);
    } finally { h.call.close(); second.call.close(); }
  });
});
