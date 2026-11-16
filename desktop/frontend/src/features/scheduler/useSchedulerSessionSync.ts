import { useEffect } from 'react';
import type { SchedulerApi } from '../../../../shared/scheduler';
import { cheshiDesktop } from '../../cheshiDesktop';
import type { ChatSessionCache } from '../chat/chatSessionCache';
import { normalizeSessionsResponse, type ChatSession } from '../chat/model';
import { useScheduler } from './useScheduler';

async function loadSessions(): Promise<ChatSession[]> {
  if (!cheshiDesktop?.listCodexChatSessions) throw new Error('The Codex chat API is unavailable.');
  return normalizeSessionsResponse(await cheshiDesktop.listCodexChatSessions());
}

/** Background tasks share the workspace session cache, including while Calendar is visible. */
export function useSchedulerSessionSync(cache: ChatSessionCache, api?: SchedulerApi, load = loadSessions) {
  const { state } = useScheduler(api);
  const revision = JSON.stringify(state.runs.filter(run => run.threadId).map(run =>
    [run.id, run.threadId, run.status, run.finishedAt]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
  useEffect(() => {
    if (revision === '[]') return;
    // Invalidate an in-flight list too, so completion cannot publish an older snapshot.
    cache.observe({ type: 'sessions-changed' });
    void cache.refresh(load, true);
  }, [cache, revision, load]);
}
