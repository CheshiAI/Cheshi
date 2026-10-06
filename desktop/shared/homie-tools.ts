import { publicToolUrl } from '../../experiments/codex-specialists/src/custom-tool-contract.ts';
import { parseAgentRuntimeRequest } from './agent-runtime.ts';
export interface ToolCredentialRequest { action: 'status' | 'save' | 'remove'; origin: string; name: string; value?: string }
export interface ToolTestRequest { agentId: string; engineId: string; tool: string; args: Record<string, unknown> }
function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid tool request.');
  return input as Record<string, unknown>;
}
export function parseToolCredentialRequest(input: unknown): ToolCredentialRequest {
  const data = object(input), url = publicToolUrl(data.origin);
  if (url.origin !== data.origin || typeof data.name !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(data.name)
    || !['status','save','remove'].includes(String(data.action))) throw new Error('Invalid tool credential request.');
  if (data.action === 'save' && (typeof data.value !== 'string' || !data.value.trim() || data.value.length > 16384 || /[\r\n\0]/.test(data.value))) throw new Error('Invalid API key.');
  return { action: data.action as ToolCredentialRequest['action'], origin: url.origin, name: data.name,
    ...(data.action === 'save' ? { value: data.value as string } : {}) };
}
export function parseToolTestRequest(input: unknown): ToolTestRequest {
  const data = object(input), runtime = parseAgentRuntimeRequest({ action: 'status', agentId: data.agentId, engineId: data.engineId });
  if (typeof data.tool !== 'string' || !/^[a-z][a-z0-9_]{0,47}$/.test(data.tool)) throw new Error('Invalid tool name.');
  const args = object(data.args);
  if (JSON.stringify(args).length > 65536) throw new Error('Tool input exceeds 64 KiB.');
  return { agentId: runtime.agentId, engineId: runtime.engineId, tool: data.tool, args };
}
