/** Versioned wire contract shared by the host, worker and renderer. No runtime dependencies. */
export const WORK_MESSAGE_LIMIT = 256_000;
export const collaborationTextLimit = (kind: unknown) => isWorkKind(kind) || kind === 'verification_request' || kind === 'verification_result' ? WORK_MESSAGE_LIMIT : 12_000;
export const WORK_KINDS = ['work_request', 'work_result', 'work_review'] as const;
export type WorkKind = typeof WORK_KINDS[number];
export const isWorkKind = (value: unknown): value is WorkKind => WORK_KINDS.some(kind => kind === value);
/** Bound serialized bytes as well as count when a batch includes file contents. */
export function collaborationBatch<T>(items: T[]): T[] {
  let bytes = 0;
  const batch: T[] = [];
  for (const item of items) {
    const size = new TextEncoder().encode(JSON.stringify(item)).byteLength;
    if (batch.length === 100 || bytes + size > 1_500_000) break;
    bytes += size; batch.push(item);
  }
  return batch;
}
export interface WorkFile { path: string; content: string | null; sha256: string | null }
export interface WorkRequest {
  version: 1; objective: string; criteria: string[]; writePaths: string[]; files: WorkFile[];
  snapshot: string; previousRequestId: string | null;
}
export interface WorkChange extends WorkFile { before: string | null }
export interface WorkResult {
  version: 1; snapshot: string; status: 'submitted' | 'blocked' | 'failed' | 'cancelled'; summary: string; changes: WorkChange[];
}
export interface WorkReview { version: 1; decision: 'accepted' | 'changes_requested'; feedback: string }
export interface WorkDraft { summary: string; digest: string }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid delegated work data.');
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 4000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new Error('Invalid delegated work text.');
  return value;
}
function list<T>(value: unknown, parse: (item: unknown) => T, max = 32): T[] {
  if (!Array.isArray(value) || value.length > max) throw new Error('Invalid delegated work list.');
  return value.map(parse);
}
export function workPath(value: unknown): string {
  const path = text(value, 300);
  if (/[:\\\x00-\x1f\x7f]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) {
    throw new Error('Use an exact project-relative file path without symlinks or Git metadata.');
  }
  return path;
}
function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid work snapshot hash.');
  return value;
}
export function parseWorkDraft(value: unknown): WorkDraft {
  const v = object(value);
  return { summary: text(v.summary), digest: hash(v.digest) };
}
function file(value: unknown): WorkFile {
  const v = object(value);
  if (v.content !== null && (typeof v.content !== 'string' || v.content.length > 128_000 || v.content.includes('\0'))) throw new Error('Only bounded UTF-8 text files are supported.');
  if ((v.content === null) !== (v.sha256 === null)) throw new Error('Invalid absent work file.');
  return { path: workPath(v.path), content: v.content as string | null, sha256: v.sha256 === null ? null : hash(v.sha256) };
}
function version(value: unknown) {
  const v = object(value);
  if (v.version !== 1 || JSON.stringify(value).length > WORK_MESSAGE_LIMIT) throw new Error('Unsupported or oversized delegated work.');
  return v;
}
export function parseWorkRequest(value: unknown): WorkRequest {
  const v = version(value), files = list(v.files, file), writePaths = list(v.writePaths, workPath), criteria = list(v.criteria, item => text(item), 16);
  if (!files.length || !writePaths.length || !criteria.length || new Set(files.map(f => f.path)).size !== files.length
    || new Set(writePaths).size !== writePaths.length || new Set(criteria).size !== criteria.length
    || writePaths.some(path => !files.some(f => f.path === path))) throw new Error('Declare unique snapshot files and writable paths.');
  const paths = files.map(f => f.path.toLowerCase());
  if (new Set(paths).size !== paths.length || paths.some(p => paths.some(other => other !== p && other.startsWith(`${p}/`)))) throw new Error('Overlapping work paths.');
  const previousRequestId = v.previousRequestId === null ? null : text(v.previousRequestId, 80);
  if (previousRequestId !== null && !/^[a-zA-Z0-9_-]+$/.test(previousRequestId)) throw new Error('Invalid previous work request.');
  return { version: 1, objective: text(v.objective), criteria, writePaths, files, snapshot: hash(v.snapshot), previousRequestId };
}
export function parseWorkResult(value: unknown): WorkResult {
  const v = version(value);
  if (!['submitted', 'blocked', 'failed', 'cancelled'].includes(String(v.status))) throw new Error('Invalid work result status.');
  const changes = list(v.changes, raw => { const c = object(raw); return { ...file(c), before: c.before === null ? null : hash(c.before) }; });
  if (new Set(changes.map(c => c.path)).size !== changes.length || (v.status !== 'submitted' && changes.length)) throw new Error('Invalid work changes.');
  return { version: 1, snapshot: hash(v.snapshot), status: v.status as WorkResult['status'], summary: text(v.summary), changes };
}
export function parseWorkReview(value: unknown): WorkReview {
  const v = version(value);
  if (v.decision !== 'accepted' && v.decision !== 'changes_requested') throw new Error('Invalid work review.');
  return { version: 1, decision: v.decision, feedback: text(v.feedback) };
}
export const workSnapshotText = (files: WorkFile[]) => JSON.stringify(files.map(({ path, sha256 }) => ({ path, sha256 })));
export function assertWorkRequest(request: WorkRequest, digest: (text: string) => string): void {
  if (request.files.some(f => f.content !== null && digest(f.content) !== f.sha256)
    || digest(workSnapshotText(request.files)) !== request.snapshot) throw new Error('Work snapshot content changed.');
}
export function assertWorkResult(request: WorkRequest, result: WorkResult, digest: (text: string) => string): void {
  if (result.snapshot !== request.snapshot || result.changes.some(c => !request.writePaths.includes(c.path)
    || request.files.find(f => f.path === c.path)?.sha256 !== c.before || c.sha256 === c.before
    || (c.content !== null && digest(c.content) !== c.sha256))) throw new Error('Work result does not match its authorized snapshot.');
}
export function assertWorkRevision(previous: WorkRequest, result: WorkResult, next: WorkRequest): void {
  if (next.writePaths.some(path => !previous.writePaths.includes(path)) || next.files.some(file => {
    const baseline = result.changes.find(c => c.path === file.path) ?? previous.files.find(f => f.path === file.path);
    return !baseline || baseline.sha256 !== file.sha256 || baseline.content !== file.content;
  })) throw new Error('A work revision must retain the prior proposal and file scope.');
}
export function parseWorkMessage(kind: WorkKind, value: unknown) {
  return kind === 'work_request' ? parseWorkRequest(value) : kind === 'work_result' ? parseWorkResult(value) : parseWorkReview(value);
}
