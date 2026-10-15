import { VOICE_DETAIL_CHANNEL, VOICE_AUDIO_SCHEME, voiceCapabilities, voiceTranscription, voiceWaveform } from '../shared/voice-transcription.ts';
import type { IpcRenderer } from 'electron';
import { VOICE_RECORDINGS_CHANNEL, VOICE_RECORDINGS_SETTINGS_CHANNEL, voiceRecordingsSnapshot, type VoiceRecordingsApi } from '../shared/voice-recordings.ts';

export function createVoiceRecordingsApi(ipc: Pick<IpcRenderer, 'invoke'>): VoiceRecordingsApi {
  return {
    detail: {
      openAudio: async id => {
        const url: unknown = await ipc.invoke(VOICE_DETAIL_CHANNEL, 'openAudio', id);
        if (url && typeof url === 'object' && 'error' in url) throw new Error('Audio unavailable or cancelled.');
        if (typeof url !== 'string' || !new RegExp(`^${VOICE_AUDIO_SCHEME}://recording/[a-f0-9-]{36}$`).test(url)) throw new TypeError('Invalid audio URL.');
        return url;
      },
      releaseAudio: async url => { await ipc.invoke(VOICE_DETAIL_CHANNEL, 'releaseAudio', url); },
      waveform: async url => {
        const value: unknown = await ipc.invoke(VOICE_DETAIL_CHANNEL, 'waveform', url);
        return value === null ? null : voiceWaveform(value);
      },
      saveAudio: async url => {
        const value: unknown = await ipc.invoke(VOICE_DETAIL_CHANNEL, 'saveAudio', url);
        if (value !== 'saved' && value !== 'cancelled' && value !== 'error') throw new TypeError('Invalid audio save result.');
        return value;
      },
      capabilities: async () => voiceCapabilities(await ipc.invoke(VOICE_DETAIL_CHANNEL, 'capabilities')),
      transcribe: async (id, locale, requestId) => { await ipc.invoke(VOICE_DETAIL_CHANNEL, 'transcribe', id, locale, requestId); },
      transcription: async requestId => voiceTranscription(await ipc.invoke(VOICE_DETAIL_CHANNEL, 'transcription', requestId)),
      cancelTranscription: async requestId => { await ipc.invoke(VOICE_DETAIL_CHANNEL, 'cancelTranscription', requestId); },
    },
    list: async () => voiceRecordingsSnapshot(await ipc.invoke(VOICE_RECORDINGS_CHANNEL)),
    openFullDiskAccessSettings: async () => (await ipc.invoke(VOICE_RECORDINGS_SETTINGS_CHANNEL)) === true,
  };
}
