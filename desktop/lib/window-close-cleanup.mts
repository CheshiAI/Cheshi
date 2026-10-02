interface CloseTarget {
  once(event: 'closed', listener: () => void): unknown;
  off(event: 'closed', listener: () => void): unknown;
}
interface CleanupGroup {
  callbacks: Set<() => void>;
  closed: boolean;
  close: () => void;
}
const groups = new WeakMap<CloseTarget, CleanupGroup>();

function runCleanup(callback: () => void): void {
  try { callback(); }
  catch (error) { console.error('[cheshi] Window close cleanup failed:', error); }
}

/** Shares one window listener and keeps a failing service from interrupting shutdown. */
export function onWindowClosed(window: CloseTarget, callback: () => void): () => void {
  let group = groups.get(window);
  if (!group) {
    const created: CleanupGroup = { callbacks: new Set(), closed: false, close: () => {
      created.closed = true;
      for (const cleanup of created.callbacks) {
        created.callbacks.delete(cleanup);
        runCleanup(cleanup);
      }
    } };
    window.once('closed', created.close);
    groups.set(window, created);
    group = created;
  }
  if (group.closed) {
    runCleanup(callback);
    return () => {};
  }
  // Each registration can be removed independently, including duplicate callbacks.
  const cleanup = () => callback();
  group.callbacks.add(cleanup);
  return () => {
    group.callbacks.delete(cleanup);
    if (!group.closed && group.callbacks.size === 0) {
      window.off('closed', group.close);
      if (groups.get(window) === group) groups.delete(window);
    }
  };
}
