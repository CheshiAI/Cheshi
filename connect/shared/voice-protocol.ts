/** Transport validation shared by the client, relay and Mac host. No desktop dependencies. */
export const VOICE_FRAME_LIMIT = 96 * 1024;
export const VOICE_RECONNECT_MS = 30000;
export const VOICE_MEDIA_RECOVERY_MS = 15000;
export const VOICE_END_MESSAGES = {
  hangup: '통화를 종료했습니다.',
  revoked: '이 기기의 연결이 해제되어 통화를 종료했습니다.',
  'account-changed': 'Mac의 계정이 변경되어 통화를 종료했습니다.',
  shutdown: 'Mac의 음성 서비스가 종료됐습니다.',
  'control-timeout': 'Mac과의 연결을 복구하지 못해 통화를 종료했습니다.',
  'control-rejected': '연결 승인이 거부되거나 해제됐습니다. Mac에서 연결을 확인해 주세요.',
  'protocol-error': '연결 메시지 오류로 통화를 종료했습니다.',
  'media-failed': '음성 연결에 실패했습니다. 다시 통화해 주세요.',
  'media-timeout': '음성 연결을 복구하지 못했습니다. 다시 통화해 주세요.',
  'microphone-ended': '마이크 입력이 종료됐습니다. 다시 통화해 주세요.',
  'provider-error': '음성 서비스 오류로 통화가 종료됐습니다.',
  'provider-closed': '음성 서비스에서 통화를 종료했습니다.',
  'startup-failed': '음성 통화를 시작하지 못했습니다. Mac의 로그인과 음성 서비스 상태를 확인해 주세요.',
  'room-unavailable': '연결한 Chats 방을 사용할 수 없어 통화를 종료했습니다.',
  'session-lost': '이전 통화가 종료됐거나 복구할 수 없습니다. 다시 통화해 주세요.',
} as const;
export type VoiceEndReason = keyof typeof VOICE_END_MESSAGES;
export function voiceEndReason(value: unknown): VoiceEndReason {
  return typeof value === 'string' && Object.hasOwn(VOICE_END_MESSAGES, value) ? value as VoiceEndReason : 'protocol-error';
}

export function voiceRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid voice message.');
  return value as Record<string, unknown>;
}
export function voiceText(value: unknown, max = 16000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new Error('Invalid voice text.');
  return value;
}
export function voiceId(value: unknown): string {
  const id = voiceText(value, 80);
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid voice identity.');
  return id;
}
export function parseVoiceFrame(text: string): Record<string, unknown> {
  if (text.length > VOICE_FRAME_LIMIT) throw new Error('Voice message is too large.');
  return voiceRecord(JSON.parse(text));
}
/** HTTP is allowed only on explicit loopback development endpoints. */
export function voiceServerUrl(input: string): URL {
  const url = new URL(input);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password
    || url.search || url.hash || url.pathname !== '/') throw new Error('Use an HTTPS connection service origin.');
  return url;
}
export function voiceSocketUrl(origin: string): string {
  const url = voiceServerUrl(origin); url.pathname = '/connect';
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}
