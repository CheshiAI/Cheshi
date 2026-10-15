import { voiceCapabilities, voiceSegment, type VoiceCapabilities, type VoiceTranscription } from '../shared/voice-transcription.ts';
import { runSpeechCommand } from './voice-speech-process.mts';
import type { PreparedVoiceAudio } from './voice-audio-preparation.mts';

function validRequestId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw new TypeError('Invalid transcription ID.');
}
function validLocale(locale: unknown): asserts locale is string {
  if (typeof locale !== 'string' || !/^[a-zA-Z]{2,3}(?:[-_][a-zA-Z0-9]{2,8}){0,3}$/.test(locale)) {
    throw new TypeError('Invalid speech language.');
  }
}
interface Job { id: string; controller: AbortController; state: VoiceTranscription }
export function createVoiceDetailService(options: {
  resolveAudio(id: string): Promise<string>;
  prepareAudio?(source: string): Promise<PreparedVoiceAudio>;
  run?: typeof runSpeechCommand;
  platform?: string;
}) {
  const run = options.run ?? runSpeechCommand;
  const jobs = new Map<number, Job>();
  const capabilities = new Map<number, { controller: AbortController; promise: Promise<VoiceCapabilities> }>();
  const cancel = (owner: number, id?: string) => {
    const job = jobs.get(owner);
    if (!job || (id !== undefined && job.id !== id)) return;
    job.controller.abort();
    job.state = { status: 'cancelled', segments: [] };
  };
  return {
    async capabilities(owner: number): Promise<VoiceCapabilities> {
      if ((options.platform ?? process.platform) !== 'darwin') return { available: false, languages: [] };
      const pending = capabilities.get(owner);
      if (pending) return pending.promise;
      const controller = new AbortController();
      const promise = (async () => {
        let result: VoiceCapabilities | undefined;
        try {
          await run({ action: 'capabilities' }, value => { result = voiceCapabilities(value); }, controller.signal, { timeoutMs: 60_000 });
          return result ?? { available: false, languages: [] };
        } catch (error) {
          if (controller.signal.aborted) return { available: false, languages: [] };
          throw error;
        } finally { if (capabilities.get(owner)?.controller === controller) capabilities.delete(owner); }
      })();
      capabilities.set(owner, { controller, promise });
      return promise;
    },
    start(owner: number, id: string, locale: string, requestId: string): void {
      validRequestId(requestId); validLocale(locale);
      cancel(owner);
      const job: Job = { id: requestId, controller: new AbortController(), state: { status: 'preparing', segments: [] } };
      jobs.set(owner, job);
      const work = async () => {
        const filename = await options.resolveAudio(id);
        if (job.controller.signal.aborted) return;
        const audio = options.prepareAudio ? await options.prepareAudio(filename) : { path: filename, release() {} };
        try {
          if (job.controller.signal.aborted) return;
          await run({ action: 'transcribe', path: audio.path, locale }, value => {
            if (job.controller.signal.aborted) return;
            const message = value as Record<string, unknown> | null;
            if (!message) throw new Error('invalid-response');
            if (message.segment) { job.state.segments.push(voiceSegment(message.segment)); return; }
            if (!['preparing', 'downloading', 'transcribing', 'complete', 'error'].includes(String(message.status))) {
              throw new Error('invalid-response');
            }
            job.state.status = message.status as VoiceTranscription['status'];
            if (message.status === 'error') job.state.error = typeof message.error === 'string' ? message.error.slice(0, 256) : 'transcription-failed';
          }, job.controller.signal);
          if (!['complete', 'error'].includes(job.state.status) && !job.controller.signal.aborted) {
            job.state = { status: 'error', segments: [], error: 'transcription-failed' };
          }
        } finally { audio.release(); }
      };
      void work().catch(() => {
        if (!job.controller.signal.aborted) job.state = { status: 'error', segments: [], error: 'transcription-failed' };
      });
    },
    snapshot(owner: number, id: string): VoiceTranscription {
      validRequestId(id);
      const job = jobs.get(owner);
      return job?.id === id ? structuredClone(job.state) : { status: 'cancelled', segments: [] };
    },
    cancel(owner: number, id: string): void { validRequestId(id); cancel(owner, id); },
    release(owner: number): void { cancel(owner); jobs.delete(owner); capabilities.get(owner)?.controller.abort(); capabilities.delete(owner); },
    dispose(): void {
      for (const owner of new Set([...jobs.keys(), ...capabilities.keys()])) this.release(owner);
    },
  };
}
