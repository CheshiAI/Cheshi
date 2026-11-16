import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Binding } from '../agent-orchestration/mailbox.mts';
import { digest, type FlashSource } from './sources.mts';
import { parseFlashSession, type FlashSession } from '../../../experiments/codex-specialists/src/flash-history.ts';

export const dockerMemoryOwner = (binding: Binding) => digest(['docker-memory-v1', binding.workspace, binding.engineId, binding.agentId, binding.accountId]);
export const dockerSessionId = (owner: string, thread: string) => `docker_${owner}_${digest(thread)}`;
interface Archive { binding?: Binding; version: 1; owner: string; streams: Record<string, FlashSession[]> }

/** Visible conversation originals, never credentials or provider/tool internals. */
export class DockerMemoryArchive {
  private readonly directory: string;
  private readonly pending = new Map<string, Promise<unknown>>();
  constructor(directory: string) { this.directory = directory; }
  private file(owner: string) { if (!/^[a-f0-9]{64}$/.test(owner)) throw new Error('Invalid memory owner.'); return join(this.directory, `${owner}.json`); }
  async read(owner: string): Promise<Archive> {
    let text: string;
    try { text = await readFile(this.file(owner), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, owner, streams: {} }; throw error; }
    const value = JSON.parse(text) as Archive;
    if (value.version !== 1 || value.owner !== owner || !value.streams || typeof value.streams !== 'object' || Array.isArray(value.streams)) throw new Error('Invalid Docker memory archive.');
    if (value.binding && dockerMemoryOwner(value.binding) !== owner) throw new Error('Invalid archived identity.');
    return { version: 1, owner, binding: value.binding, streams: Object.fromEntries(Object.entries(value.streams).map(([key, sessions]) => {
      if (!Array.isArray(sessions)) throw new Error('Invalid Docker memory sessions.');
      return [key, sessions.map(parseFlashSession)];
    })) };
  }
  async replace(binding: Binding, stream: string, sessions: FlashSession[], valid: () => boolean): Promise<void> {
    const owner = dockerMemoryOwner(binding);
    const operation = (this.pending.get(owner) ?? Promise.resolve()).catch(() => {}).then(async () => {
      if (!valid()) throw new Error('Docker memory assignment changed.');
      const current = await this.read(owner);
      const next: Archive = { ...current, binding, streams: { ...current.streams, [stream]: sessions.map(parseFlashSession) } };
      if (new Set(sessions.map(s => s.threadId)).size !== sessions.length) throw new Error('Duplicate Docker memory thread.');
      const text = JSON.stringify(next);
      if (text === JSON.stringify(current)) return;
      if (Buffer.byteLength(text) > 64 * 1024 * 1024) throw new Error('Docker memory archive is full. Originals were not truncated.');
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const filename = this.file(owner), temporary = `${filename}.${randomUUID()}.tmp`;
      if (!valid()) throw new Error('Docker memory assignment changed.');
      await writeFile(temporary, text, { mode: 0o600, flush: true });
      await rename(temporary, filename);
    });
    this.pending.set(owner, operation);
    try { await operation; } finally { if (this.pending.get(owner) === operation) this.pending.delete(owner); }
  }
  async sources(owner: string): Promise<{ revision: string; sources: FlashSource[] }> {
    const archive = await this.read(owner), sessions = new Map<string, FlashSession>();
    for (const session of Object.values(archive.streams).flat()) {
      const previous = sessions.get(session.threadId);
      if (previous && JSON.stringify(previous) !== JSON.stringify(session)) throw new Error('Conflicting Docker memory originals.');
      sessions.set(session.threadId, session);
    }
    const sources = [...sessions.values()].sort((a, b) => a.threadId.localeCompare(b.threadId)).flatMap(session => session.entries.map((entry, index) => {
      const document = { ...entry, threadId: dockerSessionId(owner, session.threadId), title: session.title, entry: index, ordinal: 0 };
      return { source_id: digest([owner, document.threadId, entry.turnId, entry.itemId]), revision: digest(document), document };
    }));
    return { revision: digest(archive), sources };
  }
  async original(owner: string, threadId: string, itemId: string): Promise<string> {
    const { sources } = await this.sources(owner);
    const source = sources.find(s => s.document.threadId === threadId && s.document.itemId === itemId);
    if (!source) throw new Error('Docker memory original is unavailable.');
    return source.document.text;
  }
}
