import { open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { Protocol } from 'electron';
import { VOICE_AUDIO_SCHEME } from '../shared/voice-transcription.ts';

const sessions = new WeakMap<Protocol, Map<string, string>>();
export function audioRange(header: string | null, size: number): { start: number; end: number } | null {
  if (!header) return size > 0 ? { start: 0, end: size - 1 } : null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && start <= end && start < size ? { start, end } : null;
}
export async function voiceAudioResponse(request: Request, files: Map<string, string>): Promise<Response> {
  const filename = files.get(request.url);
  if (!filename) return new Response(null, { status: 404 });
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 });
  try {
    const file = await open(filename, 'r');
    try {
      const { size } = await file.stat();
      const range = audioRange(request.headers.get('range'), size);
      if (!range) { await file.close(); return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } }); }
      const extension = filename.slice(filename.lastIndexOf('.')).toLowerCase();
      const mime: Record<string, string> = { '.wav': 'audio/wav', '.aif': 'audio/aiff', '.aiff': 'audio/aiff', '.caf': 'audio/x-caf' };
      const headers = { 'Content-Type': mime[extension] ?? 'audio/mp4',
        'Accept-Ranges': 'bytes', 'Content-Length': String(range.end - range.start + 1), 'Cache-Control': 'no-store',
        ...(request.headers.has('range') ? { 'Content-Range': `bytes ${range.start}-${range.end}/${size}` } : {}) };
      if (request.method === 'HEAD') { await file.close(); return new Response(null, { status: 200, headers }); }
      const stream = file.createReadStream({ start: range.start, end: range.end, autoClose: true });
      const abort = () => stream.destroy();
      request.signal.addEventListener('abort', abort, { once: true });
      stream.once('close', () => request.signal.removeEventListener('abort', abort));
      if (request.signal.aborted) stream.destroy();
      return new Response(Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>, {
        status: request.headers.has('range') ? 206 : 200, headers,
      });
    } catch (error) { await file.close().catch(() => {}); throw error; }
  } catch { return new Response(null, { status: 404 }); }
}
/** Install before renderer navigation so Chromium's media loader knows this handler. */
export function registerVoiceAudioProtocol(protocol: Protocol): void {
  if (sessions.has(protocol)) return;
  const entries = new Map<string, string>();
  protocol.handle(VOICE_AUDIO_SCHEME, request => voiceAudioResponse(request, entries));
  sessions.set(protocol, entries);
}
export function openVoiceAudio(protocol: Protocol, filename: string): { url: string; release(): void } {
  const entries = sessions.get(protocol);
  if (!entries) throw new Error('Voice audio protocol must be registered before renderer navigation.');
  const url = `${VOICE_AUDIO_SCHEME}://recording/${randomUUID()}`;
  entries.set(url, filename);
  return { url, release: () => { entries.delete(url); } };
}
