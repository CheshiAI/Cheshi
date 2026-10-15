import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';
import { VOICE_DETAIL_CHANNEL, type VoiceWaveform } from '../shared/voice-transcription.ts';
import { assertRecordingId } from './voice-recording-file.mts';
import { openVoiceAudio } from './voice-audio.mts';
import { createVoiceDetailService } from './voice-detail-service.mts';
import { createVoiceAudioPreparation } from './voice-audio-preparation.mts';
import { readVoiceWaveform, saveVoiceAudio } from './voice-media-file.mts';

interface AudioLease {
  url: string;
  source: string;
  controller: AbortController;
  waveform?: Promise<VoiceWaveform | null>;
  release(): void;
}
interface AudioOwner { audio?: AudioLease; generation: number; saving: boolean; cleanup(): void }

export function registerVoiceDetailIpc(options: {
  ipcMain: Pick<IpcMain, 'handle'>;
  assertSender(event: IpcMainInvokeEvent): void;
  resolveAudio(id: string): Promise<string>;
  chooseSavePath?(event: IpcMainInvokeEvent, suggestedName: string): Promise<string | null>;
}) {
  const preparation = createVoiceAudioPreparation();
  const service = createVoiceDetailService({ ...options, prepareAudio: source => preparation.prepare(source) });
  const owners = new Map<WebContents, AudioOwner>();
  let disposed = false;
  options.ipcMain.handle(VOICE_DETAIL_CHANNEL, async (event, action: unknown, ...args: unknown[]) => {
    options.assertSender(event);
    if (disposed) throw new Error('Voice workspace closed.');
    const sender = event.sender;
    let owner = owners.get(sender);
    if (!owner) {
      const entry: AudioOwner = { generation: 0, saving: false, cleanup: () => {
        entry.generation++; entry.audio?.release(); entry.audio = undefined;
        service.release(sender.id);
      } };
      owner = entry;
      owners.set(sender, entry);
      sender.on('render-process-gone', entry.cleanup);
      sender.on('did-start-loading', entry.cleanup);
      sender.once('destroyed', () => { entry.cleanup(); owners.delete(sender); });
    }
    if (action === 'openAudio') {
      assertRecordingId(args[0]);
      const generation = ++owner.generation;
      owner.audio?.release(); owner.audio = undefined;
      let prepared;
      let source: string;
      try { source = await options.resolveAudio(args[0]); prepared = await preparation.prepare(source); }
      catch { return { error: 'audio-unavailable' }; }
      if (disposed || sender.isDestroyed() || generation !== owner.generation) {
        prepared.release(); return { error: 'cancelled' };
      }
      try {
        const audio = openVoiceAudio(sender.session.protocol, prepared.path);
        const controller = new AbortController();
        owner.audio = { url: audio.url, source, controller,
          release: () => { controller.abort(); audio.release(); prepared.release(); } };
      } catch { prepared.release(); return { error: 'audio-unavailable' }; }
      return owner.audio.url;
    }
    if (action === 'releaseAudio') {
      if (args[0] === owner.audio?.url) { owner.audio?.release(); owner.audio = undefined; }
      return;
    }
    if (action === 'waveform' || action === 'saveAudio') {
      const audio = owner.audio;
      if (!audio || args[0] !== audio.url) return action === 'waveform' ? null : 'cancelled';
      if (action === 'waveform') {
        audio.waveform ??= (async () => {
          const prepared = await preparation.prepare(audio.source);
          try { return await readVoiceWaveform(prepared.path, audio.controller.signal); }
          finally { prepared.release(); }
        })().catch(() => null);
        return audio.waveform;
      }
      const choosePath = options.chooseSavePath;
      if (!choosePath || owner.saving) return 'cancelled';
      owner.saving = true;
      try {
        const prepared = await preparation.prepare(audio.source);
        try {
          return await saveVoiceAudio(prepared.path, audio.source, name => choosePath(event, name),
            () => disposed || sender.isDestroyed() || audio.controller.signal.aborted);
        } finally { prepared.release(); }
      } catch { return 'error'; }
      finally { owner.saving = false; }
    }
    if (action === 'capabilities') return service.capabilities(sender.id);
    if (action === 'transcribe') {
      assertRecordingId(args[0]);
      service.start(sender.id, args[0], args[1] as string, args[2] as string); return;
    }
    if (action === 'transcription') return service.snapshot(sender.id, args[0] as string);
    if (action === 'cancelTranscription') { service.cancel(sender.id, args[0] as string); return; }
    throw new TypeError('Invalid Voice action.');
  });
  return { dispose() {
    disposed = true;
    for (const [sender, owner] of owners) {
      owner.cleanup();
      sender.off('render-process-gone', owner.cleanup); sender.off('did-start-loading', owner.cleanup);
    }
    owners.clear(); service.dispose();
    return preparation.dispose();
  } };
}
