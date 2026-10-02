import { agentBoolean, agentNullableText, agentRecord, agentText, parseAgentEngineId, parseAgentId } from './agent-management.ts';

export const AGENT_TERMINAL_CHANNELS = {
  open: 'cheshi:agents:terminal:open', update: 'cheshi:agents:terminal:update',
  close: 'cheshi:agents:terminal:close', changed: 'cheshi:agents:terminal:changed',
} as const;
export interface AgentTerminalSession { id: string; engineId: string; agentId: string; ended: boolean; error: string | null }
export interface AgentTerminalBounds { id: string; x: number; y: number; width: number; height: number; visible: boolean; dark: boolean }
export interface AgentTerminalApi {
  open(engineId: string, agentId: string): Promise<AgentTerminalSession>;
  update(bounds: AgentTerminalBounds): Promise<void>;
  close(id: string): Promise<void>;
  onChanged(listener: (session: AgentTerminalSession) => void): () => void;
}
export function parseAgentTerminalSession(value: unknown): AgentTerminalSession {
  const v = agentRecord(value);
  return { id: agentText(v.id, 100), engineId: parseAgentEngineId(v.engineId), agentId: parseAgentId(v.agentId),
    ended: agentBoolean(v.ended), error: agentNullableText(v.error) };
}
export function parseAgentTerminalBounds(value: unknown): AgentTerminalBounds {
  const v = agentRecord(value);
  const coordinate = (name: string) => {
    const n = v[name];
    if (typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > 100_000) throw new TypeError('Invalid terminal bounds.');
    return n;
  };
  const width = coordinate('width'), height = coordinate('height');
  if (width < 0 || height < 0) throw new TypeError('Invalid terminal size.');
  return { id: agentText(v.id, 100), x: coordinate('x'), y: coordinate('y'), width, height,
    visible: agentBoolean(v.visible), dark: agentBoolean(v.dark) };
}
