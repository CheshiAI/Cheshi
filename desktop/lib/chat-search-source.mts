import { isAbsolute, resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import { recordValue } from './codex-service-utils.mts';
import { compileChatHistoryThread } from './chat-history-compiler.mts';
import { CHAT_HISTORY_INDEX_VERSION, type ChatHistoryIndexRecord } from './chat-history-index-store.mts';

export interface SearchSource {
  list(): Promise<{ sessions: unknown[] }>;
  read(threadId: string, profileId?: string): Promise<unknown>;
}
export interface SearchSession {
  id: string; profileId?: string; title: string; updatedAt: number; sourceKey: string; revision: string; active: boolean; historyPath?: string;
}

export function searchSessions(value: unknown): SearchSession[] {
  const response = recordValue(value);
  if (!response || !Array.isArray(response.sessions)) throw new Error('The session search catalog is unavailable.');
  const sessions = new Map<string, SearchSession>();
  for (const value of response.sessions) {
    const session = recordValue(value);
    if (!session || typeof session.id !== 'string' || !session.id || typeof session.title !== 'string'
      || typeof session.updatedAt !== 'number' || !Number.isFinite(session.updatedAt)
      || (session.profileId !== undefined && (typeof session.profileId !== 'string' || !session.profileId))) {
      throw new Error('The session search catalog contains an invalid session.');
    }
    const sourceKey = JSON.stringify([session.profileId ?? '', session.id]);
    sessions.set(sourceKey, { id: session.id, profileId: session.profileId as string | undefined,
      title: session.title, updatedAt: session.updatedAt, sourceKey,
      revision: JSON.stringify([session.updatedAt, session.title, session.preview, session.status]),
      active: session.status === 'active' || session.status === 'inProgress',
      ...(typeof session.historyPath === 'string' && isAbsolute(session.historyPath) ? { historyPath: session.historyPath } : {}),
    });
  }
  return [...sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.sourceKey.localeCompare(b.sourceKey));
}

export async function historyFingerprint(session: SearchSession): Promise<string | null> {
  if (!session.historyPath) return null;
  const info = await stat(session.historyPath, { bigint: true });
  return JSON.stringify([session.historyPath, String(info.dev), String(info.ino), String(info.size), String(info.mtimeNs), String(info.ctimeNs)]);
}

export function compileSearchRecord(raw: unknown, cwd: string, session: SearchSession, now: number): ChatHistoryIndexRecord {
  const response = recordValue(raw);
  const thread = recordValue(response?.thread) ?? response;
  if (!thread || typeof thread.cwd !== 'string' || !isAbsolute(thread.cwd) || resolve(thread.cwd) !== cwd
    || thread.parentThreadId != null || thread.ephemeral === true) {
    throw new Error('Only saved parent conversations in the current workspace can be indexed.');
  }
  const record: ChatHistoryIndexRecord = { version: CHAT_HISTORY_INDEX_VERSION, cwd, sourceKey: session.sourceKey,
    revision: session.revision, checkedAt: now, title: session.title, updatedAt: session.updatedAt,
    thread: compileChatHistoryThread(raw, cwd) };
  if (record.thread.threadId !== session.id) throw new Error('The session search history changed during indexing. Retry the search.');
  return record;
}
