import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentVoice } from '../../desktop/lib/agent-voice/service.mts';
import type { VoiceCallbacks } from '../../desktop/lib/agent-voice/realtime.mts';
import type { ChatsRequest, ChatsSnapshot } from '../../desktop/shared/agent-chats.ts';
import { PhoneConnection } from '../client/src/connection.ts';
import { VoiceRelay, type RelaySocket } from '../server/src/relay.ts';
import { voiceRecord } from '../shared/voice-protocol.ts';

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Expected recovery event missing'); await new Promise(resolve => setTimeout(resolve, 2)); }
}
/** The real relay protocol with deterministic disconnections, no provider or network. */
class Link {
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  private readonly relay: VoiceRelay;
  private readonly server: RelaySocket;
  constructor(relay: VoiceRelay) {
    this.relay = relay;
    this.server = { send: text => queueMicrotask(() => { if (this.readyState === 1) this.onmessage?.({ data: text }); }), close: code => this.close(code) };
    relay.opened(this.server); queueMicrotask(() => this.onopen?.());
  }
  send(text: string) { if (this.readyState === 1) this.relay.receive(this.server, text); }
  close(code = 1006) {
    if (this.readyState === 3) return;
    this.readyState = 3; this.relay.closed(this.server); this.onclose?.({ code });
  }
}

test('phone and host restore an approved call through the relay without a second provider or Chats request', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'cheshi-control-recovery-'));
  const relay = new VoiceRelay(), hostLinks: Link[] = [], phoneLinks: Link[] = [];
  const state: ChatsSnapshot = { rooms: [{ id: 'room', workspace: '/test', name: 'Room', engineId: 'docker:local',
    members: [{ id: 'agent', accountId: 'account', name: 'Homie' }], defaultAgentId: 'agent', createdAt: 'now' }], messages: [] };
  let callbacks!: VoiceCallbacks, starts = 0, stops = 0;
  const sent: ChatsRequest[] = [];
  const host = new AgentVoice({ directory, workspace: '/test', origin: 'https://example.test', retryMs: 2, reconnectMs: 500,
    account: () => 'account', ready: async () => {}, createClient: () => { throw new Error('No provider in this test'); },
    chats: request => { if (request.action === 'send') sent.push(request); return state; },
    socket: () => { const link = new Link(relay); hostLinks.push(link); return link as unknown as WebSocket; },
    realtime: value => { callbacks = value; return { start: async () => { starts++; callbacks.sdp('answer'); }, stop: async () => { stops++; }, speak: () => {} }; },
  });
  let pairing: string | null = null, hostId: string | null = null, live = false, resumed = 0;
  const receipts = new Set<string>(), failures: string[] = [];
  const phone = new PhoneConnection({ url: 'wss://example.test/connect', retryMs: 1, recoveryMs: 1000,
    authenticate: () => ({ type: 'authenticate', role: 'phone', hostId, deviceId: 'phone', token: 'device-test-token', name: 'Phone', pairing }),
    socket: () => { const link = new Link(relay); phoneLinks.push(link); return link as unknown as WebSocket; },
    changed: () => {}, interrupted: () => {}, ended: reason => failures.push(reason),
    frame: frame => {
      if (frame.type === 'approved') {
        pairing = null;
        if (live) phone.send({ type: 'resume', callId: 'call-1' }); else phone.recovered();
      }
      if (frame.type !== 'event') return;
      const payload = voiceRecord(frame.payload);
      if (payload.type === 'resumed') { resumed++; phone.recovered(); }
      if (payload.type === 'receipt') receipts.add(String(payload.id));
      if (payload.type === 'ended') live = false;
    },
  });
  try {
    await host.request({ action: 'pair', roomId: 'room' });
    const params = new URLSearchParams(new URL(host.snapshot().link!).hash.slice(1)); pairing = params.get('pair'); hostId = params.get('host');
    await until(() => host.snapshot().connected); phone.start();
    await until(() => !!host.snapshot().pending); await host.request({ action: 'approve', id: host.snapshot().pending!.id });
    await until(() => phone.approved);
    live = true; phone.send({ type: 'call', callId: 'call-1', sdp: 'offer' }); await until(() => starts === 1);
    phoneLinks[0]!.close(); callbacks.transcript('user', 'Make a login form', true);
    await until(() => resumed === 1 && receipts.size === 1);
    expect(stops).toBe(0); expect(starts).toBe(1); expect(sent).toHaveLength(1);
    hostLinks[0]!.close(); await until(() => resumed === 2);
    callbacks.transcript('user', 'Make a login form', true);
    expect(sent).toHaveLength(1); expect(starts).toBe(1); expect(failures).toHaveLength(0);
    phone.send({ type: 'hangup', callId: 'call-1', reason: 'hangup' });
    await until(() => stops === 1); expect(sent).toHaveLength(1);
  } finally { phone.stop(); await host.dispose(); relay.dispose(); rmSync(directory, { recursive: true, force: true }); }
});
