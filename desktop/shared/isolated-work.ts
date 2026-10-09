import { agentRecord, agentText } from './agent-management.ts';

export interface IsolatedWorkSpec { scope: string[]; check: string }
export const isolatedPhases = ['preparing', 'running', 'checking', 'passed', 'failed', 'stale', 'unknown'] as const;
export interface IsolatedWork extends IsolatedWorkSpec {
  accountId: string;
  phase: typeof isolatedPhases[number];
  baseRef: string | null;
  taskId: string;
  candidateId: string | null;
  workspace: string | null;
  branch: string | null;
  commit: string | null;
  sessionId: string | null;
  output: string;
  diff: string;
  error: string | null;
}
export function workScopePath(value: unknown): string {
  const path = agentText(value, 1000);
  const parts = path.replace(/\/$/, '').split('/');
  if (!path || path.startsWith('/') || /[\\\r\n\0]/.test(path) || parts.some(p => !p || p === '.' || p === '..' || p.toLowerCase() === '.git')) {
    throw new Error('Scope must name repository-relative files or directories.');
  }
  return path;
}
export function parseIsolatedWorkSpec(value: unknown): IsolatedWorkSpec {
  const v = agentRecord(value);
  if (!Array.isArray(v.scope) || !v.scope.length || v.scope.length > 128) throw new Error('Choose the files or directories this task may change.');
  const scope = v.scope.map(workScopePath);
  if (new Set(scope).size !== scope.length) throw new Error('Duplicate scope paths.');
  const check = agentText(v.check, 4000).trim();
  if (!check || check.includes('\0')) throw new Error('Enter a verification command.');
  return { scope, check };
}
export function parseIsolatedWork(value: unknown): IsolatedWork {
  const v = agentRecord(value), spec = parseIsolatedWorkSpec(v);
  if (!isolatedPhases.includes(v.phase as IsolatedWork['phase'])) throw new Error('Invalid isolated task phase.');
  const nullable = (key: string, max = 4096) => v[key] === null ? null : agentText(v[key], max);
  const taskId = agentText(v.taskId, 80);
  if (!/^[a-z0-9_-]+$/.test(taskId)) throw new Error('Invalid platform task ID.');
  const result: IsolatedWork = { ...spec, accountId: agentText(v.accountId, 100), phase: v.phase as IsolatedWork['phase'], taskId,
    baseRef: nullable('baseRef'), candidateId: nullable('candidateId', 80), workspace: nullable('workspace'),
    branch: nullable('branch'), commit: nullable('commit', 64), sessionId: nullable('sessionId', 200),
    output: agentText(v.output, 256_000), diff: agentText(v.diff, 256_000), error: nullable('error', 4000) };
  if (result.baseRef !== null && !/^refs\/(heads|remotes)\/[a-zA-Z0-9_./-]+$/.test(result.baseRef)) throw new Error('Invalid saved base reference.');
  if (result.commit !== null && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(result.commit)) throw new Error('Invalid result commit.');
  if (result.phase === 'passed' && (!result.commit || !result.candidateId || !result.workspace || !result.baseRef)) throw new Error('Missing verification evidence.');
  return result;
}
export function isolatedMessageStatus(phase: IsolatedWork['phase']): string {
  return phase === 'passed' ? 'completed' : phase === 'stale' ? 'failed' : phase === 'preparing' || phase === 'checking' ? 'running' : phase;
}
