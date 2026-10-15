import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { runSpeechCommand } from './voice-speech-process.mts';

export interface PreparedVoiceAudio { path: string; release(): void }
interface Entry {
  users: number;
  controller: AbortController;
  directory?: string;
  promise: Promise<string>;
}
function assertPrepared(value: unknown): void {
  if (!value || typeof value !== 'object' || (value as { prepared?: unknown }).prepared !== true) {
    throw new Error('Audio preparation failed.');
  }
}
/** Shares one private conversion between playback and transcription; removes it after the last user. */
export function createVoiceAudioPreparation(options: { run?: typeof runSpeechCommand; directory?: string } = {}) {
  const entries = new Map<string, Entry>();
  const cleanup = new Set<Promise<void>>();
  let disposed = false;
  const remove = (source: string, entry: Entry) => {
    if (entries.get(source) === entry) entries.delete(source);
    entry.controller.abort();
    const deletion = entry.promise.catch(() => {}).then(async () => {
      if (entry.directory) await rm(entry.directory, { recursive: true, force: true });
    });
    cleanup.add(deletion);
    void deletion.finally(() => cleanup.delete(deletion)).catch(() => {});
  };
  return {
    async prepare(source: string): Promise<PreparedVoiceAudio> {
      if (disposed) throw new Error('Voice workspace closed.');
      if (extname(source).toLowerCase() !== '.qta') return { path: source, release() {} };
      let entry = entries.get(source);
      if (!entry) {
        const created: Entry = { users: 0, controller: new AbortController(), promise: Promise.resolve('') };
        created.promise = (async () => {
          created.directory = await mkdtemp(join(options.directory ?? tmpdir(), 'cheshi-voice-audio-'));
          const output = join(created.directory, 'recording.m4a');
          let prepared = false;
          await (options.run ?? runSpeechCommand)({ action: 'prepareAudio', path: source, output }, value => {
            assertPrepared(value); prepared = true;
          }, created.controller.signal, { timeoutMs: 10 * 60_000 });
          assertPrepared({ prepared });
          return output;
        })();
        entry = created; entries.set(source, entry);
      }
      const current = entry;
      current.users++;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        if (--current.users === 0) remove(source, current);
      };
      try { return { path: await current.promise, release }; }
      catch (error) { release(); throw error; }
    },
    async dispose(): Promise<void> {
      disposed = true;
      for (const [source, entry] of entries) remove(source, entry);
      await Promise.all([...cleanup]);
    },
  };
}
