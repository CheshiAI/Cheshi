import { randomUUID } from 'node:crypto';
import type { ChatsSnapshot, ChatsUpdate } from '../../shared/agent-chats.ts';

/** Workspace-scoped projections. Only changed records cross IPC after the first snapshot. */
export class ChatsChanges {
  private readonly epoch = randomUUID();
  private readonly cache = new Map<string, ChatsSnapshot>();
  private readonly listeners = new Map<string, Set<(update: ChatsUpdate) => void>>();
  private readonly read: (workspace: string) => ChatsSnapshot;
  constructor(read: (workspace: string) => ChatsSnapshot) { this.read = read; }
  subscribe(workspace: string, listener: (update: ChatsUpdate) => void) {
    const listeners = this.listeners.get(workspace) ?? new Set();
    listeners.add(listener); this.listeners.set(workspace, listeners);
    return () => { listeners.delete(listener); if (!listeners.size) this.listeners.delete(workspace); };
  }
  snapshot(workspace: string): ChatsSnapshot {
    const current = this.read(workspace), previous = this.cache.get(workspace);
    const diff = <T extends { id: string }>(before: T[], after: T[]) => {
      const old = new Map(before.map(item => [item.id, JSON.stringify(item)]));
      const ids = new Set(after.map(item => item.id));
      return { changed: after.filter(item => old.get(item.id) !== JSON.stringify(item)), removed: before.filter(item => !ids.has(item.id)).map(item => item.id) };
    };
    const rooms = diff(previous?.rooms ?? [], current.rooms), messages = diff(previous?.messages ?? [], current.messages);
    if (previous && !rooms.changed.length && !rooms.removed.length && !messages.changed.length && !messages.removed.length) return previous;
    const cursor = { epoch: this.epoch, sequence: previous ? previous.cursor!.sequence + 1 : 0 };
    const snapshot = { ...current, cursor }; this.cache.set(workspace, snapshot);
    if (previous) for (const listener of this.listeners.get(workspace) ?? []) listener({ cursor, rooms: rooms.changed, messages: messages.changed,
      removedRoomIds: rooms.removed, removedMessageIds: messages.removed });
    return snapshot;
  }
  publish() { for (const workspace of this.listeners.keys()) this.snapshot(workspace); }
  dispose() { this.listeners.clear(); this.cache.clear(); }
}
