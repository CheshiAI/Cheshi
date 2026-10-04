/** Transport validation shared by the client, relay and Mac host. No desktop dependencies. */
export const VOICE_FRAME_LIMIT = 96 * 1024;

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
