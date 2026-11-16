import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { voiceEndReason, type VoiceEndReason } from '../../../connect/shared/voice-protocol.ts';
type Reason = VoiceEndReason | 'host-disconnected' | 'phone-disconnected';

export type VoiceDiagnosticEvent = 'control-open' | 'control-close' | 'control-error' | 'heartbeat-timeout'
  | 'call-start' | 'call-suspended' | 'call-resumed' | 'call-ended';
/** Bounded local metadata only. Never pass frames, URLs, credentials or speech here. */
export class VoiceDiagnostics {
  private readonly file: string;
  private entries: { at: string; event: VoiceDiagnosticEvent; code?: number; reason?: Reason }[] = [];
  constructor(directory: string) {
    this.file = path.join(directory, 'voice-diagnostics.json');
    try {
      const entries: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (Array.isArray(entries)) this.entries = entries.slice(-99).flatMap((entry: unknown) => {
        if (!entry || typeof entry !== 'object') return [];
        const value = entry as Record<string, unknown>;
        const events: VoiceDiagnosticEvent[] = ['control-open', 'control-close', 'control-error', 'heartbeat-timeout', 'call-start', 'call-suspended', 'call-resumed', 'call-ended'];
        if (!events.includes(value.event as VoiceDiagnosticEvent) || typeof value.at !== 'string' || !Number.isFinite(Date.parse(value.at))) return [];
        const reason = value.reason === 'host-disconnected' || value.reason === 'phone-disconnected' ? value.reason : voiceEndReason(value.reason);
        return [{ at: new Date(value.at).toISOString(), event: value.event as VoiceDiagnosticEvent,
          ...(typeof value.code === 'number' && Number.isInteger(value.code) ? { code: value.code } : {}),
          ...(value.reason === undefined ? {} : { reason }) }];
      });
    } catch { /* Diagnostics must not block calling. */ }
  }
  record(event: VoiceDiagnosticEvent, details: { code?: number; reason?: Reason } = {}) {
    this.entries.push({ at: new Date().toISOString(), event, ...details });
    this.entries = this.entries.slice(-100);
    try {
      mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      writeFileSync(this.file, JSON.stringify(this.entries), { mode: 0o600 });
    } catch { /* The connection must work even when diagnostics cannot be saved. */ }
  }
}
