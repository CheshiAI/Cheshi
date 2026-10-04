export interface AgentExecutionHealth {
  taskId: string; startedAt: string; lastActivityAt: string;
  lastActivity: 'starting' | 'model' | 'tool' | 'stopping';
  checkedAt: string | null; lastResponsiveAt: string | null;
  engineStatus: 'checking' | 'responding' | 'unconfirmed';
}

export function parseAgentExecutionHealth(value: unknown): AgentExecutionHealth | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid execution health.');
  const v = value as Record<string, unknown>;
  const timestamp = (value: unknown): string => {
    if (typeof value !== 'string' || value.length > 100 || !Number.isFinite(Date.parse(value))) throw new TypeError('Invalid health timestamp.');
    return value;
  };
  if (typeof v.taskId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(v.taskId)
    || !['starting', 'model', 'tool', 'stopping'].includes(String(v.lastActivity))
    || !['checking', 'responding', 'unconfirmed'].includes(String(v.engineStatus))) throw new TypeError('Invalid execution health.');
  return { taskId: v.taskId, startedAt: timestamp(v.startedAt), lastActivityAt: timestamp(v.lastActivityAt),
    lastActivity: v.lastActivity as AgentExecutionHealth['lastActivity'],
    engineStatus: v.engineStatus as AgentExecutionHealth['engineStatus'],
    checkedAt: v.checkedAt === null ? null : timestamp(v.checkedAt),
    lastResponsiveAt: v.lastResponsiveAt === null ? null : timestamp(v.lastResponsiveAt) };
}
