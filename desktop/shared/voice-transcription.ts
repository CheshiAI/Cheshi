export const VOICE_AUDIO_SCHEME = 'cheshi-voice';
export const VOICE_DETAIL_CHANNEL = 'cheshi:voice-recordings:detail';
export interface VoiceLanguage { id: string; name: string; installed: boolean }
export interface VoiceCapabilities { available: boolean; languages: VoiceLanguage[] }
export interface VoiceSegment { start: number; end: number; text: string }
export interface VoiceWaveform { duration: number; peaks: number[] }
export type VoiceSaveResult = 'saved' | 'cancelled' | 'error';
export function voiceWaveform(value: unknown): VoiceWaveform {
  const item = value as VoiceWaveform | null;
  if (!item || !Number.isFinite(item.duration) || item.duration <= 0 || !Array.isArray(item.peaks)
    || !item.peaks.length || item.peaks.length > 2048
    || item.peaks.some(peak => typeof peak !== 'number' || !Number.isFinite(peak) || peak < 0 || peak > 1)) {
    throw new TypeError('Invalid audio waveform.');
  }
  return { duration: item.duration, peaks: [...item.peaks] };
}
export type VoiceTranscriptionStatus = 'preparing' | 'downloading' | 'transcribing' | 'complete' | 'cancelled' | 'error';
export interface VoiceTranscription {
  status: VoiceTranscriptionStatus;
  segments: VoiceSegment[];
  error?: string;
}
export interface VoiceDetailApi {
  openAudio(id: string): Promise<string>;
  releaseAudio(url: string): Promise<void>;
  waveform(url: string): Promise<VoiceWaveform | null>;
  saveAudio(url: string): Promise<VoiceSaveResult>;
  capabilities(): Promise<VoiceCapabilities>;
  transcribe(id: string, locale: string, requestId: string): Promise<void>;
  transcription(requestId: string): Promise<VoiceTranscription>;
  cancelTranscription(requestId: string): Promise<void>;
}
export function voiceCapabilities(value: unknown): VoiceCapabilities {
  const item = value as VoiceCapabilities | null;
  if (!item || typeof item.available !== 'boolean' || !Array.isArray(item.languages) || item.languages.length > 500
    || item.languages.some(language => !language || typeof language.id !== 'string' || language.id.length > 64
      || typeof language.name !== 'string' || language.name.length > 256 || typeof language.installed !== 'boolean')) {
    throw new TypeError('Invalid speech capabilities.');
  }
  return { available: item.available, languages: item.languages.map(({ id, name, installed }) => ({ id, name, installed })) };
}
export function voiceSegment(value: unknown): VoiceSegment {
  const item = value as VoiceSegment | null;
  if (!item || !Number.isFinite(item.start) || !Number.isFinite(item.end) || item.start < 0 || item.end < item.start
    || typeof item.text !== 'string' || item.text.length > 100_000) throw new TypeError('Invalid speech segment.');
  return { start: item.start, end: item.end, text: item.text };
}
export function voiceTranscription(value: unknown): VoiceTranscription {
  const item = value as VoiceTranscription | null;
  if (!item || !['preparing', 'downloading', 'transcribing', 'complete', 'cancelled', 'error'].includes(item.status)
    || !Array.isArray(item.segments) || item.segments.length > 100_000
    || (item.error !== undefined && (typeof item.error !== 'string' || item.error.length > 256))) {
    throw new TypeError('Invalid transcription response.');
  }
  return { status: item.status, segments: item.segments.map(voiceSegment), ...(item.error ? { error: item.error } : {}) };
}
