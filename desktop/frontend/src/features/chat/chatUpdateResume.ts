import type { SplitLayoutNode } from '../../shared/ui/splitPaneModel';
import { splitPaneIds } from '../../shared/ui/splitPaneModel';
import { resumeRecord } from '../shell/updateWorkspaceResume';
import type { ChatWorkspaceState } from './chatWorkspaceModel';

export interface ChatUpdateSnapshot extends ChatWorkspaceState { sessionIds: Record<string, string>; }

function parseLayout(value: unknown, depth = 0): SplitLayoutNode {
  const record = resumeRecord(value);
  if (!record || depth > 32) throw new Error('The saved chat layout is invalid.');
  if (record.type === 'pane' && typeof record.paneId === 'string' && record.paneId.length > 0) {
    return { type: 'pane', paneId: record.paneId };
  }
  if (record.type !== 'split' || typeof record.id !== 'string' || !record.id
    || (record.axis !== 'columns' && record.axis !== 'rows') || typeof record.ratio !== 'number'
    || !Number.isFinite(record.ratio) || record.ratio < 0.1 || record.ratio > 0.9) {
    throw new Error('The saved chat split is invalid.');
  }
  return { type: 'split', id: record.id, axis: record.axis, ratio: record.ratio,
    first: parseLayout(record.first, depth + 1), second: parseLayout(record.second, depth + 1) };
}

export function parseChatUpdateSnapshot(value: unknown): ChatUpdateSnapshot {
  const record = resumeRecord(value);
  const sessions = resumeRecord(record?.sessionIds);
  if (!record || !sessions || typeof record.activePaneId !== 'string') throw new Error('The saved chat workspace is invalid.');
  const layout = parseLayout(record.layout);
  const ids = splitPaneIds(layout);
  if (ids.length > 32 || new Set(ids).size !== ids.length || !ids.includes(record.activePaneId)) {
    throw new Error('The saved chat panes are invalid.');
  }
  const sessionIds: Record<string, string> = {};
  for (const [id, session] of Object.entries(sessions)) {
    if (!ids.includes(id) || typeof session !== 'string' || !session) throw new Error('A saved conversation is invalid.');
    Object.defineProperty(sessionIds, id, { value: session, enumerable: true, configurable: true, writable: true });
  }
  return { layout, activePaneId: record.activePaneId, sessionIds };
}

export async function reopenUpdateConversations(snapshot: ChatUpdateSnapshot,
  controllers: Readonly<Record<string, { openSession(sessionId: string): Promise<boolean> }>>): Promise<void> {
  await Promise.all(Object.entries(snapshot.sessionIds).map(async ([id, sessionId]) => {
    const controller = controllers[id];
    if (!controller || !await controller.openSession(sessionId)) {
      throw new Error(`The saved conversation ${sessionId} could not be reopened.`);
    }
  }));
}
