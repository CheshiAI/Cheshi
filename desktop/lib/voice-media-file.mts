import { copyFile, mkdtemp, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { voiceWaveform, type VoiceWaveform, type VoiceSaveResult } from '../shared/voice-transcription.ts';
import { runSpeechCommand } from './voice-speech-process.mts';

export async function readVoiceWaveform(filename: string, signal: AbortSignal): Promise<VoiceWaveform | null> {
  let result: VoiceWaveform | null = null;
  try {
    await runSpeechCommand({ action: 'waveform', path: filename }, value => { result = voiceWaveform(value); },
      signal, { timeoutMs: 10 * 60_000 });
    return signal.aborted ? null : result;
  } catch { return null; }
}

/** Copy to a private sibling first, preserving the selected file if copying fails. */
export async function saveVoiceAudio(filename: string, original: string,
  choosePath: (suggestedName: string) => Promise<string | null>, cancelled: () => boolean): Promise<VoiceSaveResult> {
  let temporary: string | undefined;
  try {
    const extension = path.extname(filename);
    const destination = await choosePath(`${path.basename(original, path.extname(original))}${extension}`);
    if (!destination || cancelled()) return 'cancelled';
    const target = await realpath(destination).catch(() => path.resolve(destination));
    const protectedFiles = await Promise.all([realpath(original), realpath(filename)]);
    if (protectedFiles.includes(target)) return 'error';
    temporary = await mkdtemp(path.join(path.dirname(destination), '.cheshi-voice-export-'));
    const copy = path.join(temporary, `audio${extension}`);
    await copyFile(filename, copy);
    if (cancelled()) return 'cancelled';
    await rename(copy, destination);
    return 'saved';
  } catch { return 'error'; }
  finally { if (temporary) await rm(temporary, { recursive: true, force: true }); }
}
