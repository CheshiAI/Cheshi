/** Only media negotiation goes to the phone. Codex credentials never do. */
export class PhoneCall {
  private pc: RTCPeerConnection | null = null;
  private stream: MediaStream | null = null;
  private revision = 0;
  private readonly audio: HTMLAudioElement;
  private readonly state: (text: string) => void;
  private readonly disconnected: () => void;
  constructor(audio: HTMLAudioElement, state: (text: string) => void, disconnected: () => void) {
    this.audio = audio; this.state = state; this.disconnected = disconnected;
  }
  async offer() {
    this.close(); const revision = this.revision;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
    if (revision !== this.revision) { stream.getTracks().forEach(t => t.stop()); throw new Error('통화가 취소됐습니다.'); }
    this.stream = stream;
    const pc = new RTCPeerConnection(); this.pc = pc;
    stream.getTracks().forEach(t => pc.addTrack(t, stream));
    pc.createDataChannel('oai-events');
    pc.ontrack = event => { this.audio.srcObject = event.streams[0] ?? new MediaStream([event.track]); void this.audio.play().catch(() => this.state('오디오 재생을 허용해 주세요.')); };
    pc.onconnectionstatechange = () => {
      if (pc !== this.pc) return;
      if (pc.connectionState === 'connected') this.state('통화 중');
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') { this.close(); this.disconnected(); this.state('음성 연결이 끊겼습니다. 다시 통화해 주세요.'); }
    };
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error('음성 연결 준비 시간이 초과됐습니다.')); }, 10000);
      const check = () => { if (pc.iceGatheringState === 'complete') { cleanup(); resolve(); } };
      const cleanup = () => { clearTimeout(timer); pc.removeEventListener('icegatheringstatechange', check); };
      pc.addEventListener('icegatheringstatechange', check); check();
    });
    if (revision !== this.revision || !pc.localDescription) throw new Error('통화가 취소됐습니다.');
    return pc.localDescription.sdp;
  }
  async answer(sdp: string) { if (this.pc) await this.pc.setRemoteDescription({ type: 'answer', sdp }); }
  mute(value: boolean) { this.stream?.getAudioTracks().forEach(t => { t.enabled = !value; }); }
  close() { this.revision++; this.pc?.close(); this.pc = null; this.stream?.getTracks().forEach(t => t.stop()); this.stream = null; this.audio.srcObject = null; }
}
