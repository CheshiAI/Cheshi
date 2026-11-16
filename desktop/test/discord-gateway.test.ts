import { expect, test } from 'bun:test';
import { createDiscordGateway } from '../lib/discord-gateway.mts';

test('gateway acknowledges heartbeat requests, dispatches ready events, and stops on rejected intents', async () => {
  const sent: Array<{ op: number; d: unknown }> = [], statuses: string[] = [], events: string[] = [];
  const socket = { readyState: 1, onmessage: null as ((event: { data: string }) => void) | null,
    onerror: null as (() => void) | null, onclose: null as ((event: { code: number }) => void) | null,
    send(text: string) { sent.push(JSON.parse(text)); }, close() {} };
  const controller = new AbortController();
  const gateway = createDiscordGateway({ token: 'test-only-token', signal: controller.signal,
    gateway: async () => ({ url: 'wss://gateway.discord.gg' }), socket: () => socket as unknown as WebSocket,
    status: text => { statuses.push(text); }, dispatch: type => { events.push(type); } });
  try {
    await Promise.resolve();
    const receive = (packet: unknown) => socket.onmessage!({ data: JSON.stringify(packet) });
    receive({ op: 10, d: { heartbeat_interval: 45_000 } });
    receive({ op: 0, s: 42, t: 'READY', d: { session_id: 'session', resume_gateway_url: 'wss://gateway.discord.gg' } });
    receive({ op: 1 });
    expect(sent.at(-1)).toEqual({ op: 1, d: 42 }); expect(events).toEqual(['READY']);
    socket.onclose!({ code: 4014 });
    expect(statuses.at(-1)).toContain('Message Content Intent');
    receive({ op: 0, t: 'MESSAGE_CREATE', d: {} }); expect(events).toEqual(['READY']);
  } finally { gateway.stop(); controller.abort(); }
});

test('aborted gateway discovery never opens a socket', async () => {
  const controller = new AbortController();
  let connections = 0;
  const gateway = createDiscordGateway({ token: 'test-only-token', signal: controller.signal,
    gateway: async () => { controller.abort(); return { url: 'wss://gateway.discord.gg' }; },
    socket: () => { connections++; throw new Error('Unexpected connection'); }, status() {}, dispatch() {} });
  await Promise.resolve(); expect(connections).toBe(0); gateway.stop();
});

test('a gateway reconnect resumes its session with the last sequence instead of identifying again', async () => {
  const sent: Array<{ op: number; d: unknown }> = [];
  const sockets: Array<{ readyState: number; onmessage: ((event: { data: string }) => void) | null;
    send(value: string): void; close(): void }> = [];
  const controller = new AbortController();
  const gateway = createDiscordGateway({ token: 'test-only-token', signal: controller.signal,
    gateway: async () => ({ url: 'wss://gateway.discord.gg' }), status() {}, dispatch() {},
    socket: () => {
      const socket = { readyState: 1, onmessage: null as ((event: { data: string }) => void) | null,
        send(value: string) { sent.push(JSON.parse(value)); }, close() {} };
      sockets.push(socket); return socket as unknown as WebSocket;
    } });
  try {
    await Promise.resolve();
    sockets[0]!.onmessage!({ data: JSON.stringify({ op: 0, s: 83, t: 'READY', d: { session_id: 'saved', resume_gateway_url: 'wss://gateway.discord.gg' } }) });
    sockets[0]!.onmessage!({ data: '{"op":7}' });
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect(sockets).toHaveLength(2);
    sockets[1]!.onmessage!({ data: '{"op":10,"d":{"heartbeat_interval":45000}}' });
    expect(sent.find(packet => packet.op === 6)?.d).toEqual({ token: 'test-only-token', session_id: 'saved', seq: 83 });
    expect(sent.some(packet => packet.op === 2)).toBe(false);
  } finally { gateway.stop(); controller.abort(); }
});
