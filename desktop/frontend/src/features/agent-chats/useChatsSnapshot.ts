import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { AgentChatsApi, ChatsRequest, ChatsSnapshot, ChatsUpdate } from '../../../../shared/agent-chats';

export type ChatsLoadPhase = 'loading' | 'ready' | 'error';
interface State {
  snapshot: ChatsSnapshot;
  phase: ChatsLoadPhase;
  loaded: boolean;
  refreshing: boolean;
  error: string | null;
}

/** Keep acknowledged data visible while refreshing; never interpret a failed read as an empty room list. */
export function createChatsSnapshotStore(api?: AgentChatsApi) {
  let state: State = { snapshot: { rooms: [], messages: [] }, phase: api ? 'loading' : 'error', loaded: false,
    refreshing: false, error: api ? null : 'Restart the desktop app to load Chats.' };
  let pending: Promise<void> | null = null, revision = 0, mutations = 0, needsSync = false;
  const listeners = new Set<() => void>();
  const publish = (changes: Partial<State>) => { state = { ...state, ...changes }; listeners.forEach(listener => listener()); };
  const accept = (snapshot: ChatsSnapshot) => {
    const cursor = state.snapshot.cursor;
    if (cursor && snapshot.cursor?.epoch === cursor.epoch && snapshot.cursor.sequence < cursor.sequence) return;
    const retain = <T extends { id: string }>(previous: T[], next: T[]) => {
      const old = new Map(previous.map(item => [item.id, item]));
      const items = next.map(item => { const before = old.get(item.id); return before && JSON.stringify(before) === JSON.stringify(item) ? before : item; });
      return items.length === previous.length && items.every((item, index) => item === previous[index]) ? previous : items;
    };
    snapshot = { ...snapshot, rooms: retain(state.snapshot.rooms, snapshot.rooms), messages: retain(state.snapshot.messages, snapshot.messages) };
    publish({ snapshot, phase: 'ready', loaded: true, error: null });
  };
  const refresh = (force = true): Promise<void> => {
    if (pending) return pending;
    if (!api || mutations || (!force && state.loaded)) return Promise.resolve();
    const started = revision; needsSync = false;
    publish({ refreshing: true, ...(!state.loaded ? { phase: 'loading' as const, error: null } : {}) });
    pending = Promise.resolve().then(() => api.request({ action: 'list' })).then(data => {
      if (started === revision) accept(data);
    }, error => {
      if (started === revision) publish({ phase: 'error', error: error instanceof Error ? error.message : 'Could not load Chats.' });
    }).finally(() => {
      pending = null; publish({ refreshing: false });
      // A mutation invalidates the in-flight list, even if that list arrives last.
      if ((started !== revision || needsSync) && !mutations) void refresh();
    });
    return pending;
  };
  const request = async (input: ChatsRequest): Promise<ChatsSnapshot> => {
    if (!api) throw new Error('Restart the desktop app to load Chats.');
    mutations++; revision++;
    try {
      const data = await api.request(input);
      revision++; accept(data); return data;
    } finally {
      mutations--;
      if (!mutations && (!state.loaded || needsSync)) void refresh();
    }
  };
  const receive = (update: ChatsUpdate) => {
    const cursor = state.snapshot.cursor;
    if (cursor?.epoch === update.cursor.epoch && update.cursor.sequence <= cursor.sequence) return;
    revision++;
    if (!state.loaded || !cursor || cursor.epoch !== update.cursor.epoch || update.cursor.sequence !== cursor.sequence + 1) { needsSync = true; void refresh(); return; }
    const apply = <T extends { id: string }>(items: T[], changed: T[], removed: string[]) => {
      if (!changed.length && !removed.length) return items;
      const deleted = new Set(removed), replacements = new Map(changed.map(item => [item.id, item]));
      const next = items.filter(item => !deleted.has(item.id)).map(item => { const replacement = replacements.get(item.id); replacements.delete(item.id); return replacement ?? item; });
      return [...next, ...replacements.values()];
    };
    accept({ cursor: update.cursor, rooms: apply(state.snapshot.rooms, update.rooms, update.removedRoomIds),
      messages: apply(state.snapshot.messages, update.messages, update.removedMessageIds) });
  };
  return { getSnapshot: () => state, refresh, request, receive,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
}

export function useChatsSnapshot(api: AgentChatsApi | undefined, active: boolean) {
  const store = useMemo(() => createChatsSnapshotStore(api), [api]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  // Like Session, start the first read even while the sidebar tab is offscreen.
  useEffect(() => {
    // Subscribe first so changes during the initial read cannot be lost.
    const unsubscribe = api?.onDidChange?.(store.receive);
    void store.refresh(false);
    return unsubscribe;
  }, [api, store]);
  useEffect(() => {
    if (!active) return;
    const refreshVisible = () => { if (document.visibilityState === 'visible') void store.refresh(); };
    void store.refresh(false);
    window.addEventListener('focus', refreshVisible);
    document.addEventListener('visibilitychange', refreshVisible);
    return () => {
      window.removeEventListener('focus', refreshVisible);
      document.removeEventListener('visibilitychange', refreshVisible);
    };
  }, [active, store]);
  return { ...state, refresh: store.refresh, request: store.request };
}
