import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { VoiceRelay, type RelaySocket } from '../server/src/relay.ts';
import { voiceServerUrl } from '../shared/voice-protocol.ts';

class Socket implements RelaySocket {
  messages: Record<string, unknown>[] = [];
  closed = false;
  code: number | undefined;
  send(text: string) { this.messages.push(JSON.parse(text)); }
  close(code?: number) { this.closed = true; this.code = code; }
}
const hostId = createHash('sha256').update('test-owner-secret').digest('hex');
function harness() {
  const relay = new VoiceRelay();
  const host = new Socket(), phone = new Socket();
  relay.opened(host); relay.receive(host, JSON.stringify({ type: 'authenticate', role: 'host', hostId, token: 'test-owner-secret' }));
  relay.opened(phone); relay.receive(phone, JSON.stringify({ type: 'authenticate', role: 'phone', hostId, deviceId: 'device', name: 'Phone', token: 'device-secret', pairing: 'link-secret' }));
  const peerId = host.messages.at(-1)!.peerId;
  return { relay, host, phone, peerId, send: (socket: Socket, value: unknown) => relay.receive(socket, JSON.stringify(value)) };
}
describe('connection relay boundaries', () => {
  test('requires Mac approval before any instruction', () => {
    const h = harness();
    try { h.send(h.phone, { type: 'request', payload: { type: 'call' } }); expect(h.phone.closed).toBe(true); expect(h.host.messages.length).toBe(2); }
    finally { h.relay.dispose(); }
  });
  test('relays approval codes and only approved phone payloads', () => {
    const h = harness();
    try {
      h.send(h.host, { type: 'challenge', peerId: h.peerId, code: '123456' });
      expect(h.phone.messages.at(-1)).toEqual({ type: 'challenge', code: '123456' });
      h.send(h.host, { type: 'approve', peerId: h.peerId });
      h.send(h.phone, { type: 'request', payload: { type: 'call', sdp: 'offer' } });
      expect(h.host.messages.at(-1)).toEqual({ type: 'request', peerId: h.peerId, payload: { type: 'call', sdp: 'offer' } });
      h.send(h.host, { type: 'event', peerId: h.peerId, payload: { type: 'sdp', sdp: 'answer' } });
      expect(h.phone.messages.at(-1)?.type).toBe('event');
      h.relay.closed(h.host); expect(h.phone.closed).toBe(true);
    } finally { h.relay.dispose(); }
  });
  test('rejects impersonation and duplicate host connections', () => {
    const h = harness();
    try {
      for (const token of ['wrong', 'test-owner-secret']) {
        const fake = new Socket(); h.relay.opened(fake);
        h.send(fake, { type: 'authenticate', role: 'host', hostId, token }); expect(fake.closed).toBe(true);
      }
    } finally { h.relay.dispose(); }
  });
  test('Mac reconnecting is retryable while a rejected device remains terminal', () => {
    const h = harness();
    try {
      h.send(h.host, { type: 'reject', peerId: h.peerId }); expect(h.phone.code).toBe(1008);
      h.relay.closed(h.host);
      const phone = new Socket(); h.relay.opened(phone);
      h.send(phone, { type: 'authenticate', role: 'phone', hostId, deviceId: 'device', name: 'Phone', token: 'device-secret' });
      expect(phone.code).toBe(1013);
    } finally { h.relay.dispose(); }
  });
  test('cannot route across Mac identities', () => {
    const h = harness();
    try {
      const other = new Socket(), token = 'other-secret'; h.relay.opened(other);
      h.send(other, { type: 'authenticate', role: 'host', hostId: createHash('sha256').update(token).digest('hex'), token });
      h.send(other, { type: 'approve', peerId: h.peerId }); expect(h.phone.messages).toHaveLength(0);
    } finally { h.relay.dispose(); }
  });
  test('rejects invalid, oversized and flooded frames', () => {
    const h = harness();
    try {
      h.relay.receive(h.phone, 'x'.repeat(100000)); expect(h.phone.closed).toBe(true);
      for (let i = 0; i < 162; i++) h.send(h.host, { type: 'ping' }); expect(h.host.closed).toBe(true);
    } finally { h.relay.dispose(); }
  });
  test('only HTTPS or loopback development endpoints are accepted', () => {
    expect(voiceServerUrl('https://connect.example').protocol).toBe('https:');
    expect(voiceServerUrl('http://127.0.0.1:8788').protocol).toBe('http:');
    for (const url of ['http://example.com', 'https://user:secret@example.com', 'https://example.com/path', 'file:///tmp']) expect(() => voiceServerUrl(url)).toThrow();
  });
});
