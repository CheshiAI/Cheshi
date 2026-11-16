import { VOICE_MEDIA_RECOVERY_MS, type VoiceEndReason } from '../../shared/voice-protocol.ts';

interface MediaOptions {
  stream?(): Promise<MediaStream>;
  peer?(): RTCPeerConnection;
  recoveryMs?: number;
}
/** Only media negotiation goes to the phone. Codex credentials never do. */
export class PhoneCall {
  private pc: RTCPeerConnection | null = null;
  private stream: MediaStream | null = null;
  private revision = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private cancelGathering: (() => void) | null = null;
  private answering: Promise<void> | null = null;
  private readonly audio: HTMLAudioElement;
  private readonly state: (text: string) => void;
  private readonly disconnected: (reason: VoiceEndReason) => void;
  private readonly options: MediaOptions;
  constructor(audio: HTMLAudioElement, state: (text: string) => void, disconnected: (reason: VoiceEndReason) => void, options: MediaOptions = {}) {
    this.audio = audio; this.state = state; this.disconnected = disconnected; this.options = options;
  }
  private clearRecovery() { if (this.timer) clearTimeout(this.timer); this.timer = null; }
  private fail(reason: VoiceEndReason) { this.close(); this.disconnected(reason); }
  async offer() {
    this.close(); const revision = this.revision;
    const stream = await (this.options.stream?.() ?? navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false }));
    if (revision !== this.revision) { stream.getTracks().forEach(t => t.stop()); throw new Error('통화가 취소됐습니다.'); }
    this.stream = stream;
    const pc = this.options.peer?.() ?? new RTCPeerConnection(); this.pc = pc;
    stream.getTracks().forEach(t => {
      pc.addTrack(t, stream);
      t.addEventListener('ended', () => { if (pc === this.pc) this.fail('microphone-ended'); }, { once: true });
    });
    pc.createDataChannel('oai-events');
    pc.ontrack = event => { if (pc !== this.pc) return; this.audio.srcObject = event.streams[0] ?? new MediaStream([event.track]); void this.audio.play().catch(() => this.state('오디오 재생을 허용해 주세요.')); };
    pc.onconnectionstatechange = () => {
      if (pc !== this.pc) return;
      console.info('[cheshi-call]', 'media-state', pc.connectionState);
      if (pc.connectionState === 'connected') { this.clearRecovery(); this.state('통화 중'); }
      if (pc.connectionState === 'failed') this.fail('media-failed');
      if (pc.connectionState === 'disconnected' && !this.timer) {
        this.state('음성 연결을 복구하는 중입니다…');
        this.timer = setTimeout(() => { if (pc === this.pc) this.fail('media-timeout'); }, this.options.recoveryMs ?? VOICE_MEDIA_RECOVERY_MS);
      }
    };
    await pc.setLocalDescription(await pc.createOffer());
    if (revision !== this.revision) throw new Error('통화가 취소됐습니다.');
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); pc.removeEventListener('icegatheringstatechange', check); this.cancelGathering = null; };
      const check = () => { if (pc.iceGatheringState === 'complete') { cleanup(); resolve(); } };
      const timer = setTimeout(() => { cleanup(); reject(new Error('음성 연결 준비 시간이 초과됐습니다.')); }, 10000);
      this.cancelGathering = () => { cleanup(); reject(new Error('통화가 취소됐습니다.')); };
      pc.addEventListener('icegatheringstatechange', check); check();
    });
    if (revision !== this.revision || !pc.localDescription) throw new Error('통화가 취소됐습니다.');
    return pc.localDescription.sdp;
  }
  async answer(sdp: string) {
    const pc = this.pc; if (!pc || pc.remoteDescription) return;
    this.answering ??= pc.setRemoteDescription({ type: 'answer', sdp });
    await this.answering;
  }
  mute(value: boolean) { this.stream?.getAudioTracks().forEach(t => { t.enabled = !value; }); }
  close() {
    this.revision++; this.clearRecovery(); this.cancelGathering?.(); this.answering = null;
    const pc = this.pc; this.pc = null; pc?.close();
    this.stream?.getTracks().forEach(t => t.stop()); this.stream = null; this.audio.srcObject = null;
  }
}
