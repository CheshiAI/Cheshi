import type {
  TerminalPaneLayout,
  TerminalPaneState,
  TerminalRuntimeState,
  TerminalSessionState,
} from '../../cheshiDesktop';

const MAX_LAYOUT_DEPTH = 64;
const MIN_SPLIT_RATIO = 0.1;
const MAX_SPLIT_RATIO = 0.9;

export const EMPTY_TERMINAL_STATE: TerminalRuntimeState = {
  available: false,
  error: null,
  cwd: null,
  sessions: [],
  activeSessionId: null,
  activePaneId: null,
};

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nullableString(value: unknown): string | null | undefined {
  return value === null || typeof value === 'string' ? value : undefined;
}

function normalizePane(value: unknown): TerminalPaneState | null {
  const record = recordValue(value);
  if (
    !record
    || typeof record.id !== 'string'
    || !record.id
    || typeof record.title !== 'string'
    || (record.running !== true && record.running !== false)
  ) return null;
  return { id: record.id, title: record.title, running: record.running };
}

function normalizeLayout(
  value: unknown,
  paneIds: ReadonlySet<string>,
  depth = 0,
): TerminalPaneLayout | null {
  if (depth > MAX_LAYOUT_DEPTH) return null;
  const record = recordValue(value);
  if (!record) return null;
  if (record.type === 'pane') {
    return typeof record.paneId === 'string' && paneIds.has(record.paneId)
      ? { type: 'pane', paneId: record.paneId }
      : null;
  }
  if (
    record.type !== 'split'
    || typeof record.id !== 'string'
    || !record.id
    || (record.axis !== 'columns' && record.axis !== 'rows')
    || typeof record.ratio !== 'number'
    || !Number.isFinite(record.ratio)
    || record.ratio < MIN_SPLIT_RATIO
    || record.ratio > MAX_SPLIT_RATIO
  ) return null;
  const first = normalizeLayout(record.first, paneIds, depth + 1);
  const second = normalizeLayout(record.second, paneIds, depth + 1);
  return first && second
    ? {
        type: 'split',
        id: record.id,
        axis: record.axis,
        ratio: record.ratio,
        first,
        second,
      }
    : null;
}

function normalizeSession(value: unknown): TerminalSessionState | null {
  const record = recordValue(value);
  if (
    !record
    || typeof record.id !== 'string'
    || !record.id
    || typeof record.title !== 'string'
    || !Array.isArray(record.panes)
  ) return null;
  const panes = record.panes.map(normalizePane);
  if (panes.some((pane) => pane === null)) return null;
  const normalizedPanes = panes as TerminalPaneState[];
  const paneIds = new Set(normalizedPanes.map((pane) => pane.id));
  if (paneIds.size !== normalizedPanes.length) return null;
  const layout = normalizeLayout(record.layout, paneIds);
  if (!layout) return null;
  return { id: record.id, title: record.title, panes: normalizedPanes, layout };
}

export function normalizeTerminalState(value: unknown): TerminalRuntimeState | null {
  const record = recordValue(value);
  if (
    !record
    || (record.available !== true && record.available !== false)
    || !Array.isArray(record.sessions)
  ) return null;
  const error = nullableString(record.error);
  const cwd = nullableString(record.cwd);
  const activeSessionId = nullableString(record.activeSessionId);
  const activePaneId = nullableString(record.activePaneId);
  if (error === undefined || cwd === undefined || activeSessionId === undefined || activePaneId === undefined) {
    return null;
  }
  const sessions = record.sessions.map(normalizeSession);
  if (sessions.some((session) => session === null)) return null;
  const normalizedSessions = sessions as TerminalSessionState[];
  const sessionIds = new Set(normalizedSessions.map((session) => session.id));
  if (sessionIds.size !== normalizedSessions.length) return null;
  const activeSession = activeSessionId === null
    ? null
    : normalizedSessions.find((session) => session.id === activeSessionId);
  if (activeSessionId !== null && !activeSession) return null;
  if ((activeSession === null) !== (activePaneId === null)) return null;
  if (activePaneId !== null && !activeSession?.panes.some((pane) => pane.id === activePaneId)) return null;
  return {
    available: record.available,
    error,
    cwd,
    sessions: normalizedSessions,
    activeSessionId,
    activePaneId,
  };
}
