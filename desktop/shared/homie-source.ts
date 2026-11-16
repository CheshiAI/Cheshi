export const HOMIE_SOURCE_CHANNEL = 'cheshi:agent-registry:source';
export type HomieSourceAction = 'status' | 'open' | 'use-files';
export interface HomieSourceRequest { agentId: string; action: HomieSourceAction; engineId?: string }
export interface HomieSourceState {
  directory: string | null;
  phase: 'missing' | 'conflict' | 'invalid' | 'pending' | 'applied';
  message: string;
  hash: string | null;
}
export function parseHomieSourceRequest(value: unknown): HomieSourceRequest {
  const v = value as Partial<HomieSourceRequest> | null;
  if (!v || typeof v.agentId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v.agentId)
    || !['status', 'open', 'use-files'].includes(v.action ?? '')) throw new Error('Invalid Homie source request.');
  if (v.engineId !== undefined && (typeof v.engineId !== 'string' || !/^docker:[a-zA-Z0-9_.-]+$/.test(v.engineId))) throw new Error('Invalid Docker engine.');
  return { agentId: v.agentId, action: v.action!, ...(v.engineId ? { engineId: v.engineId } : {}) };
}
export function parseHomieSourceState(value: unknown): HomieSourceState {
  const v = value as Partial<HomieSourceState> | null;
  if (!v || (v.directory !== null && typeof v.directory !== 'string') || typeof v.message !== 'string'
    || !['missing', 'conflict', 'invalid', 'pending', 'applied'].includes(v.phase ?? '')
    || (v.hash !== null && (typeof v.hash !== 'string' || !/^[a-f0-9]{64}$/.test(v.hash)))) throw new Error('Invalid Homie source state.');
  return { directory: v.directory!, phase: v.phase!, message: v.message, hash: v.hash! };
}
