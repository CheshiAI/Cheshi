import { parseWorkRequest, assertWorkRequest, type WorkFile, type WorkRequest, WORK_MESSAGE_LIMIT } from './work-contract.ts';

export interface CandidateReference { id: string; hash: string; applicationId?: string }
export interface CandidateSnapshot extends CandidateReference { requestIds: string[]; files: WorkFile[] }
function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid candidate identity or hash.');
  return value;
}
export function candidateReference(value: unknown): CandidateReference {
  if (!value || typeof value !== 'object') throw new Error('Invalid candidate reference.');
  const v = value as Record<string, unknown>;
  return { id: hash(v.id), hash: hash(v.hash), ...(v.applicationId === undefined ? {} : { applicationId: hash(v.applicationId) }) };
}
export function candidateSpec(candidate: Pick<CandidateSnapshot, 'files' | 'hash'>): WorkRequest {
  return parseWorkRequest({ version: 1, objective: 'Verify isolated integration candidate', criteria: ['Independently verify the candidate'],
    files: candidate.files, snapshot: candidate.hash, writePaths: [candidate.files[0]?.path], previousRequestId: null });
}
export function candidateSnapshot(value: unknown): CandidateSnapshot {
  const ref = candidateReference(value), v = value as Record<string, unknown>;
  if (!Array.isArray(v.requestIds) || !v.requestIds.length || v.requestIds.length > 32) throw new Error('Invalid candidate proposals.');
  const requestIds = v.requestIds.map(hash).sort();
  if (new Set(requestIds).size !== requestIds.length || !Array.isArray(v.files) || JSON.stringify(value).length > WORK_MESSAGE_LIMIT) throw new Error('Invalid candidate snapshot.');
  const files = candidateSpec({ files: v.files as WorkFile[], hash: ref.hash }).files;
  return { ...ref, requestIds, files };
}
export function assertCandidate(candidate: CandidateSnapshot, digest: (value: string) => string): void {
  assertWorkRequest(candidateSpec(candidate), digest);
  if (candidate.files.some(file => file.content !== null && new TextEncoder().encode(file.content).byteLength > 128_000)) throw new Error('Candidate file exceeds 128 KB.');
}
export function sameCandidate(a: CandidateReference | undefined, b: CandidateReference | undefined): boolean {
  return a === undefined ? b === undefined : b !== undefined && a.id === b.id && a.hash === b.hash && a.applicationId === b.applicationId;
}
