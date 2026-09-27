import { discordRecord } from '../shared/discord.ts';

export function createDiscordGateway(options: {
  token: string; signal: AbortSignal; dispatch(type: string, data: Record<string, unknown>): void;
  status(text: string, connected: boolean): void;
  gateway(): Promise<{ url: string; session_start_limit?: { remaining: number; reset_after: number; max_concurrency: number } }>;
  socket?: (url: string) => WebSocket;
}) {
  let socket: WebSocket | undefined, heartbeat: ReturnType<typeof setTimeout> | undefined, retry: ReturnType<typeof setTimeout> | undefined;
  let handshake: ReturnType<typeof setTimeout> | undefined;
  let ack = true, sequence: number | null = null, session = '', resumeUrl = '', failures = 0, stopped = false;
  let generation = 0;
  const send = (op: number, d: unknown) => { if (socket?.readyState === 1) socket.send(JSON.stringify({ op, d })); };
  const clear = () => { clearTimeout(heartbeat); clearTimeout(retry); clearTimeout(handshake); generation++; const old = socket; socket = undefined; old?.close(); };
  const reconnect = (milliseconds = Math.min(60_000, 1500 * 2 ** Math.min(failures++, 5)) + Math.random() * 1000) => {
    clear(); if (stopped || options.signal.aborted) return;
    options.status('Reconnecting to Discord…', false);
    retry = setTimeout(() => { void connect(); }, milliseconds); retry.unref?.();
  };
  const beat = (interval: number) => {
    if (!ack) { reconnect(); return; }
    ack = false; send(1, sequence);
    heartbeat = setTimeout(() => beat(interval), interval); heartbeat.unref?.();
  };
  const connect = async () => {
    const current = ++generation;
    try {
      const info = await options.gateway();
      if (stopped || options.signal.aborted || current !== generation) return;
      if (!session && info.session_start_limit?.remaining === 0) { reconnect(Math.max(5000, info.session_start_limit.reset_after)); return; }
      const url = new URL(session ? resumeUrl : info.url);
      if (url.protocol !== 'wss:' || !url.hostname.endsWith('.discord.gg')) throw new Error('Invalid Discord gateway.');
      url.searchParams.set('v', '10'); url.searchParams.set('encoding', 'json');
      socket = (options.socket ?? (address => new WebSocket(address)))(url.toString());
      handshake = setTimeout(() => reconnect(), 25_000); handshake.unref?.();
      socket.onmessage = event => {
        if (current !== generation || stopped) return;
        try {
          const packet = discordRecord(JSON.parse(String(event.data)));
          if (typeof packet.s === 'number') sequence = packet.s;
          if (packet.op === 10) {
            const interval = Number(discordRecord(packet.d).heartbeat_interval);
            if (!Number.isFinite(interval) || interval < 1000) throw new Error('Invalid heartbeat.');
            ack = true; heartbeat = setTimeout(() => beat(interval), interval * Math.random()); heartbeat.unref?.();
            if (session) send(6, { token: options.token, session_id: session, seq: sequence });
            else {
              // Independent Macs sharing a personal bot may identify concurrently. Jitter and
              // backoff handle Discord's per-bucket identify limit without a hosted coordinator.
              retry = setTimeout(() => send(2, { token: options.token, intents: 1 | 512 | 32768,
                properties: { os: 'darwin', browser: 'Cheshi', device: 'Cheshi' } }), 5000 + Math.random() * 5000);
            }
          } else if (packet.op === 11) ack = true;
          else if (packet.op === 1) send(1, sequence);
          else if (packet.op === 7) reconnect(1000);
          else if (packet.op === 9) { if (packet.d !== true) { session = ''; sequence = null; } reconnect(5000 + Math.random() * 5000); }
          else if (packet.op === 0) {
            const data = discordRecord(packet.d);
            if (packet.t === 'READY') { session = String(data.session_id); resumeUrl = String(data.resume_gateway_url); }
            if (packet.t === 'READY' || packet.t === 'RESUMED') { clearTimeout(handshake); failures = 0; options.status('Connected', true); }
            options.dispatch(String(packet.t), data);
          }
        } catch { reconnect(); }
      };
      socket.onerror = () => { if (current === generation) reconnect(); };
      socket.onclose = event => {
        if (current !== generation) return;
        if ([4004, 4010, 4011, 4012, 4013, 4014].includes(event.code)) {
          stopped = true; clear(); options.status('Discord rejected the connection. Check the bot token and Message Content Intent.', false); return;
        }
        if ([4007, 4009].includes(event.code)) { session = ''; sequence = null; }
        reconnect();
      };
    } catch { if (current === generation) reconnect(); }
  };
  const stop = () => { stopped = true; clear(); options.signal.removeEventListener('abort', stop); };
  options.signal.addEventListener('abort', stop, { once: true });
  void connect();
  return { stop };
}
