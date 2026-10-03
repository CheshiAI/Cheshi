import { workPath } from './work-contract.ts';
import { verificationResult, type VerificationResult } from './verification-contract.ts';

export const INTEGRATION_STATES = ['prepared', 'conflict', 'stale', 'invalid'] as const;
export const INTEGRATION_ISSUES = ['source_changed', 'source_unavailable', 'proposal_conflict', 'scope_conflict', 'proposal_changed', 'candidate_changed'] as const;
export interface IntegrationIssue {
  kind: typeof INTEGRATION_ISSUES[number]; path: string | null; requestIds: string[];
}
export interface IntegrationFile { path: string; before: string | null; sha256: string | null }
/** Metadata only: candidate contents stay in the owner's volume, outside activity/IPC payloads. */
export interface IntegrationSummary {
  verification?: { requestId: string; agentId: string; status: 'pending' | 'pass' | 'fail' | 'inconclusive' | 'stale'; result: VerificationResult | null };
  version: 1; id: string; taskId: string; roomId: string; requestIds: string[];
  status: typeof INTEGRATION_STATES[number]; candidateHash: string | null;
  files: IntegrationFile[]; issues: IntegrationIssue[]; createdAt: string; checkedAt: string;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid integration data.');
  return value as Record<string, unknown>;
}
export function integrationHash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid integration hash.');
  return value;
}
export function integrationId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value)) throw new Error('Invalid integration identity.');
  return value;
}
function list<T>(value: unknown, parse: (v: unknown) => T, max: number): T[] {
  if (!Array.isArray(value) || value.length > max) throw new Error('Invalid integration list.');
  return value.map(parse);
}
export function integrationRequests(value: unknown): string[] {
  const ids = list(value, integrationHash, 32);
  if (!ids.length || new Set(ids).size !== ids.length) throw new Error('Select 1–32 unique accepted proposals.');
  return ids.sort();
}
function timestamp(value: unknown): string {
  if (typeof value !== 'string' || value.length > 40 || !Number.isFinite(Date.parse(value))) throw new Error('Invalid integration timestamp.');
  return value;
}
export function parseIntegration(value: unknown): IntegrationSummary {
  const v = object(value);
  if (v.version !== 1 || !INTEGRATION_STATES.some(s => s === v.status)) throw new Error('Invalid integration status.');
  const requestIds = integrationRequests(v.requestIds);
  const files = list(v.files, raw => {
    const f = object(raw);
    const result = { path: workPath(f.path), before: f.before === null ? null : integrationHash(f.before), sha256: f.sha256 === null ? null : integrationHash(f.sha256) };
    if (result.before === result.sha256) throw new Error('Integration file has no change.');
    return result;
  }, 32);
  if (new Set(files.map(f => f.path)).size !== files.length) throw new Error('Duplicate integration file.');
  const issues = list(v.issues, raw => {
    const i = object(raw);
    if (!INTEGRATION_ISSUES.some(kind => kind === i.kind)) throw new Error('Invalid integration issue.');
    const ids = integrationRequests(i.requestIds);
    if (ids.some(id => !requestIds.includes(id))) throw new Error('Integration issue belongs to another proposal.');
    return { kind: i.kind as IntegrationIssue['kind'], path: i.path === null ? null : workPath(i.path), requestIds: ids };
  }, 128);
  const candidateHash = v.candidateHash === null ? null : integrationHash(v.candidateHash);
  if ((v.status === 'prepared' && (!candidateHash || issues.length)) || (v.status !== 'prepared' && !issues.length)) throw new Error('Inconsistent integration state.');
  const verification = v.verification === undefined ? undefined : (() => {
    const check = object(v.verification);
    if (!['pending', 'pass', 'fail', 'inconclusive', 'stale'].includes(String(check.status))) throw new Error('Invalid candidate verification state.');
    const result = check.result === null ? null : verificationResult(check.result);
    if (check.status === 'pass' && (v.status !== 'prepared' || !result?.candidate || result.candidate.id !== v.id
      || result.candidate.hash !== candidateHash || result.verdicts.some(item => item.verdict !== 'pass'))) throw new Error('Invalid candidate verification pass.');
    return { requestId: integrationHash(check.requestId), agentId: integrationId(check.agentId), status: check.status as NonNullable<IntegrationSummary['verification']>['status'], result };
  })();
  return { ...(verification ? { verification } : {}), version: 1, id: integrationHash(v.id), taskId: integrationId(v.taskId), roomId: integrationId(v.roomId), requestIds,
    status: v.status as IntegrationSummary['status'], candidateHash, files, issues, createdAt: timestamp(v.createdAt), checkedAt: timestamp(v.checkedAt) };
}
