import { voiceId, voiceRecord, voiceText } from '../../connect/shared/voice-protocol.ts';

/** Desktop IPC contract for managing phone approvals and call status. */
export const VOICE_CHANNEL = 'cheshi:agent-voice';
export interface VoiceDevice { id: string; name: string; roomId: string; roomName: string }
export interface VoiceSnapshot {
  configured: boolean; connected: boolean; error: string | null; calling: boolean;
  link: string | null; expiresAt: number | null;
  pending: { id: string; name: string; code: string } | null;
  devices: VoiceDevice[];
}
export type VoiceRequest = { action: 'status' | 'stop' }
  | { action: 'pair'; roomId: string }
  | { action: 'approve' | 'reject'; id: string }
  | { action: 'revoke'; id: string };
export interface AgentVoiceApi { request(input: VoiceRequest): Promise<VoiceSnapshot> }
export function parseVoiceSnapshot(value: unknown): VoiceSnapshot {
  const v = voiceRecord(value), p = v.pending === null ? null : voiceRecord(v.pending);
  if (typeof v.configured !== 'boolean' || typeof v.connected !== 'boolean' || typeof v.calling !== 'boolean'
    || !Array.isArray(v.devices) || v.devices.length > 32 || (v.expiresAt !== null && !Number.isFinite(v.expiresAt))) throw new Error('Invalid voice status.');
  return { configured: v.configured, connected: v.connected, calling: v.calling,
    error: v.error === null ? null : voiceText(v.error), link: v.link === null ? null : voiceText(v.link), expiresAt: v.expiresAt as number | null,
    pending: p ? { id: voiceId(p.id), name: voiceText(p.name, 80), code: voiceText(p.code, 6) } : null,
    devices: v.devices.map(raw => { const d = voiceRecord(raw); return { id: voiceId(d.id), name: voiceText(d.name, 80), roomId: voiceId(d.roomId), roomName: voiceText(d.roomName, 100) }; }) };
}
export function parseVoiceRequest(value: unknown): VoiceRequest {
  const v = voiceRecord(value);
  if (v.action === 'status' || v.action === 'stop') return { action: v.action };
  if (v.action === 'pair') return { action: v.action, roomId: voiceId(v.roomId) };
  if (v.action === 'approve' || v.action === 'reject' || v.action === 'revoke') return { action: v.action, id: voiceId(v.id) };
  throw new Error('Unknown voice action.');
}
