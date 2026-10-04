import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseChatsRequest, type ChatsRequest } from '../../shared/agent-chats.ts';
import { voiceId, voiceRecord, voiceText } from '../../../connect/shared/voice-protocol.ts';
import type { VoiceDevice } from '../../shared/agent-voice.ts';

export const digest = (text: string) => createHash('sha256').update(text).digest('hex');
export const secret = () => randomBytes(32).toString('hex');
export const matches = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export interface Device extends VoiceDevice { hash: string; account: string; threadId: string | null }
type Send = Extract<ChatsRequest, { action: 'send' }>;
interface State { token: string; devices: Device[]; pending: { deviceId: string; account: string; request: Send }[] }

/** Written before dispatch; replay uses Chats' durable request identity. */
export class VoiceStorage {
  private readonly file: string;
  state: State;
  constructor(directory: string) {
    this.file = path.join(directory, 'voice.json');
    if (!existsSync(this.file)) { this.state = { token: secret(), devices: [], pending: [] }; this.save(); return; }
    const raw = voiceRecord(JSON.parse(readFileSync(this.file, 'utf8')));
    if (!Array.isArray(raw.devices) || raw.devices.length > 32 || !Array.isArray(raw.pending) || raw.pending.length > 128) throw new Error('Invalid saved voice state.');
    this.state = { token: voiceText(raw.token, 128), devices: raw.devices.map(value => {
      const d = voiceRecord(value);
      return { id: voiceId(d.id), name: voiceText(d.name, 80), roomId: voiceId(d.roomId), roomName: voiceText(d.roomName, 100),
        hash: voiceText(d.hash, 128), account: voiceText(d.account, 128), threadId: d.threadId === null ? null : voiceId(d.threadId) };
    }), pending: raw.pending.map(value => {
      const p = voiceRecord(value), request = parseChatsRequest(p.request);
      if (request.action !== 'send' || request.automatic !== true) throw new Error('Invalid saved voice delivery.');
      return { deviceId: voiceId(p.deviceId), account: voiceText(p.account, 128), request };
    }) };
  }
  save() {
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(this.state), { mode: 0o600, flush: true });
    renameSync(temp, this.file);
  }
  enqueue(device: Device, request: Send) {
    if (this.state.pending.length >= 128) throw new Error('Resolve pending voice deliveries before sending more.');
    this.state.pending.push({ deviceId: device.id, account: device.account, request }); this.save();
  }
  acknowledged(device: Device, id: string, threadId: string) {
    device.threadId = threadId;
    this.state.pending = this.state.pending.filter(p => p.request.id !== id); this.save();
  }
}
