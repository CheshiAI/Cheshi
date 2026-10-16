export const HOST_TOOL_DETAILS_CHANNEL = 'cheshi:host-tool-details';
export interface HostToolDetails { token: string; agentId: string; tool: string; text: string }
export type HostToolDetailsListener = (details: HostToolDetails) => Promise<boolean> | undefined;

export function hostToolDetailsReplyChannel(token: string) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(token)) {
    throw new Error('Invalid host tool details token.');
  }
  return `${HOST_TOOL_DETAILS_CHANNEL}:closed:${token}`;
}

export function parseHostToolDetails(value: unknown): HostToolDetails {
  const data = value as Partial<HostToolDetails> | null;
  if (!data || typeof data.token !== 'string' || typeof data.agentId !== 'string'
    || typeof data.tool !== 'string' || typeof data.text !== 'string') throw new Error('Invalid host tool details.');
  hostToolDetailsReplyChannel(data.token);
  return { token: data.token, agentId: data.agentId, tool: data.tool, text: data.text };
}
