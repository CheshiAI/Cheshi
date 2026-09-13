import type { ChatSession, normalizeChatEvent } from './model';

export const CHAT_SESSION_CACHE_TTL_MS = 5 * 60 * 1_000;
type SessionLoader = () => Promise<ChatSession[]>;
type ChatEvent = NonNullable<ReturnType<typeof normalizeChatEvent>>;
interface SessionSnapshot {
  sessions: ChatSession[];
  loading: boolean;
  error: string | null;
}

/** Workspace-owned metadata only; conversation contents and permissions stay in each pane. */
export function createChatSessionCache(now: () => number = Date.now) {
  let snapshot: SessionSnapshot = { sessions: [], loading: true, error: null };
  let loadedAt = -Infinity;
  let revision = 0;
  let pending: Promise<void> | null = null;
  const deletedIds = new Set<string>();
  const listeners = new Set<() => void>();
  const publish = (next: SessionSnapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const invalidate = () => { revision += 1; loadedAt = -Infinity; };

  const remove = (threadIds: readonly string[]) => {
    const added = threadIds.filter(id => !deletedIds.has(id));
    if (added.length === 0) return;
    for (const id of added) deletedIds.add(id);
    invalidate();
    publish({ ...snapshot, sessions: snapshot.sessions.filter(session => !deletedIds.has(session.id)) });
  };

  const observe = (event: ChatEvent) => {
    if (event.type === 'sessions-deleted') { remove(event.threadIds); return; }
    if (event.type === 'sessions-changed') { invalidate(); return; }
    if (event.type === 'session-created' && !deletedIds.has(event.session.id)) {
      invalidate();
      publish({ ...snapshot, sessions: [event.session, ...snapshot.sessions.filter(session => session.id !== event.session.id)] });
    }
    if (event.type === 'session-title' && !deletedIds.has(event.threadId)) {
      if (snapshot.sessions.find(session => session.id === event.threadId)?.title === event.title) return;
      invalidate();
      publish({ ...snapshot, sessions: snapshot.sessions.map(session =>
        session.id === event.threadId ? { ...session, title: event.title } : session) });
    }
  };

  const refresh = (load: SessionLoader, force = false): Promise<void> => {
    if (pending) return pending;
    if (!force && now() - loadedAt < CHAT_SESSION_CACHE_TTL_MS) return Promise.resolve();
    const run = async () => {
      // An event received during a request invalidates its result, not the visible list.
      for (;;) {
        const requestRevision = revision;
        try {
          const sessions = await load();
          if (requestRevision !== revision) continue;
          loadedAt = now();
          publish({ sessions: sessions.filter(session => !deletedIds.has(session.id)), loading: false, error: null });
        } catch (error) {
          loadedAt = -Infinity;
          publish({ ...snapshot, loading: false, error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }
    };
    pending = Promise.resolve().then(run).finally(() => { pending = null; });
    return pending;
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    deletedIds: deletedIds as ReadonlySet<string>,
    refresh, observe, remove,
  };
}

export type ChatSessionCache = ReturnType<typeof createChatSessionCache>;
