import type { CodexAccountProfiles } from './codex-account-profiles.mts';
import type { CodexAccountsSnapshot } from '../shared/codex-accounts.ts';

type Profiles = Pick<CodexAccountProfiles, 'list' | 'onDidChange' | 'release'>;

/** App-owned reference: closing a workspace must not stop menu-bar usage updates. */
export function createAccountUsageBackground(options: {
  acquire(): Profiles;
  update(snapshot: CodexAccountsSnapshot): void;
  onError(error: unknown): void;
  intervalMs?: number;
}) {
  let profiles: Profiles | undefined;
  let unsubscribe: (() => void) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let refreshing = false;
  let disposed = false;
  let closing: Promise<void> | undefined;
  const update = (snapshot: CodexAccountsSnapshot) => {
    if (!disposed) options.update(snapshot);
  };
  const refresh = async () => {
    if (disposed || refreshing || !profiles) return;
    refreshing = true;
    try { update(await profiles.list()); }
    catch (error) { if (!disposed) options.onError(error); }
    finally { refreshing = false; }
  };
  return {
    start() {
      if (disposed || profiles) return;
      try { profiles = options.acquire(); }
      catch (error) { options.onError(error); return; }
      unsubscribe = profiles.onDidChange(update);
      timer = setInterval(() => { void refresh(); }, options.intervalMs ?? 60_000);
      timer.unref();
      void refresh();
    },
    async dispose() {
      if (closing) return await closing;
      disposed = true;
      if (timer) clearInterval(timer);
      unsubscribe?.();
      closing = profiles?.release() ?? Promise.resolve();
      await closing;
    },
  };
}
