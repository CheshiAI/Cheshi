export type HostToolRequest = { agentId: string; tool: string } & (
  { action: 'status' | 'allow' | 'revoke' } | { action: 'policy'; autoApprove?: boolean }
);
export interface HostToolStatus { allowed: boolean; executable: string | null; digest: string | null; autoApprove?: boolean }
export function parseHostToolRequest(value: unknown): HostToolRequest {
  const data = value as Partial<HostToolRequest> | null;
  if (!data || typeof data !== 'object' || Object.keys(data).some(k => !['action','agentId','tool','autoApprove'].includes(k))
    || !['status','allow','revoke','policy'].includes(String(data.action)) || typeof data.agentId !== 'string'
    || !/^[a-zA-Z0-9._-]{1,100}$/.test(data.agentId) || typeof data.tool !== 'string'
    || !/^[a-z][a-z0-9_]{0,47}$/.test(data.tool)) throw new Error('Invalid host tool request.');
  if ('autoApprove' in data && (data.action !== 'policy' || typeof data.autoApprove !== 'boolean')) throw new Error('Invalid automatic approval setting.');
  if (data.action === 'policy') return { action: 'policy', agentId: data.agentId, tool: data.tool,
    ...('autoApprove' in data ? { autoApprove: data.autoApprove } : {}) };
  return { action: data.action!, agentId: data.agentId, tool: data.tool };
}
export function parseHostToolStatus(value: unknown): HostToolStatus {
  const data = value as Partial<HostToolStatus> | null;
  if (!data || typeof data.allowed !== 'boolean' || !(data.executable === null || typeof data.executable === 'string')
    || !(data.digest === null || typeof data.digest === 'string')
    || ('autoApprove' in data && typeof data.autoApprove !== 'boolean')) throw new Error('Invalid host tool status.');
  return { allowed: data.allowed, executable: data.executable, digest: data.digest,
    ...('autoApprove' in data ? { autoApprove: data.autoApprove } : {}) };
}
