import { parseVoiceFrame, VOICE_RECONNECT_MS, type VoiceEndReason } from '../../shared/voice-protocol.ts';

interface Options {
  url: string;
  authenticate(): unknown;
  frame(value: Record<string, unknown>): void | Promise<void>;
  changed(): void;
  interrupted(): void;
  ended(reason: VoiceEndReason): void;
  socket?(url: string): WebSocket;
  retryMs?: number;
  recoveryMs?: number;
}
/** Reauthentication restores transport; only the host can confirm call recovery. */
export class PhoneConnection {
  private readonly options: Options;
  private socket: WebSocket | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private deadline: ReturnType<typeof setTimeout> | null = null;
  private handshake: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private pong = 0;
  active = false;
  approved = false;
  constructor(options: Options) { this.options = options; }
  start() { if (this.active) return; this.active = true; this.open(); }
  recovered() { if (this.deadline) clearTimeout(this.deadline); this.deadline = null; }
  send(payload: unknown) {
    if (!this.approved || this.socket?.readyState !== 1) throw new Error('Mac에 다시 연결하는 중입니다.');
    this.socket.send(JSON.stringify({ type: 'request', payload }));
  }
  private clearTransportTimers() {
    if (this.handshake) clearTimeout(this.handshake);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.handshake = null; this.heartbeat = null;
  }
  private fail(reason: VoiceEndReason) { this.stop(); this.options.ended(reason); }
  private outage() {
    if (!this.active) return;
    this.approved = false; this.options.changed(); this.options.interrupted();
    if (!this.deadline) this.deadline = setTimeout(() => this.fail('control-timeout'), this.options.recoveryMs ?? VOICE_RECONNECT_MS);
    if (!this.retry) this.retry = setTimeout(() => { this.retry = null; this.open(); }, this.options.retryMs ?? 1000);
  }
  private open() {
    if (!this.active || this.socket) return;
    try {
      const ws = (this.options.socket ?? (url => new WebSocket(url)))(this.options.url); this.socket = ws;
      this.options.changed();
      this.handshake = setTimeout(() => this.lost(ws), 10000);
      ws.onopen = () => { if (this.socket === ws) ws.send(JSON.stringify(this.options.authenticate())); };
      let sequence = Promise.resolve();
      ws.onmessage = event => {
        sequence = sequence.then(async () => {
          if (this.socket !== ws) return;
          const frame = parseVoiceFrame(String(event.data));
          if (frame.type === 'challenge') {
            if (this.handshake) clearTimeout(this.handshake);
            this.handshake = setTimeout(() => this.fail('control-rejected'), 120000);
          }
          if (frame.type === 'pong') this.pong = Date.now();
          if (frame.type === 'approved') {
            this.clearTransportTimers(); this.approved = true; this.pong = Date.now();
            this.heartbeat = setInterval(() => {
              if (Date.now() - this.pong > 75000) this.lost(ws);
              else if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping' }));
            }, 15000);
            this.options.changed();
          }
          await this.options.frame(frame);
        }).catch(() => { if (this.socket === ws) this.fail('protocol-error'); });
      };
      ws.onerror = () => { if (this.socket === ws) this.lost(ws); };
      ws.onclose = event => {
        if (this.socket !== ws) return;
        console.info('[cheshi-call]', 'control-close', event.code);
        if (event.code === 1008 || event.code === 1003) this.fail('control-rejected');
        else this.lost(ws);
      };
    } catch { this.socket = null; this.clearTransportTimers(); this.outage(); }
  }
  private lost(ws: WebSocket) {
    if (this.socket !== ws) return;
    this.socket = null; this.clearTransportTimers(); ws.close(); this.outage();
  }
  stop() {
    this.active = false; this.approved = false;
    if (this.retry) clearTimeout(this.retry); this.retry = null;
    this.recovered(); this.clearTransportTimers();
    const ws = this.socket; this.socket = null; ws?.close(); this.options.changed();
  }
}
