import { candidateReference, candidateSnapshot, sameCandidate, type CandidateReference, type CandidateSnapshot } from './candidate-verification-contract.ts';
import { record, textValue } from './protocol.ts';

export type Artifact = { path: string; sha256: string | null };
export type VerificationRequest = { goal: string; criteria: string[]; artifacts: Artifact[]; candidate?: CandidateSnapshot };
export type Evidence = { id: string; kind: 'file' | 'command'; detail: string; output: string; exitCode: number | null; successful?: boolean };
export type Verdict = { criterion: string; verdict: 'pass' | 'fail' | 'inconclusive'; reason: string; evidenceIds: string[] };
export type VerificationResult = { verdicts: Verdict[]; evidence: Evidence[]; candidate?: CandidateReference };
export function boundedText(value: unknown, limit = 1000): string {
  const text = textValue(value, 'verification text');
  if (!text.trim() || text.length > limit) throw new Error('Invalid verification text.');
  return text;
}
export function list<T>(value: unknown, parse: (item: unknown) => T, maximum = 16): T[] {
  if (!Array.isArray(value) || !value.length || value.length > maximum) throw new Error('Invalid verification list.');
  return value.map(parse);
}
export function artifactPath(value: unknown): string {
  const path = boundedText(value, 300);
  if (path.startsWith('/') || path.includes('\\') || path.includes('\0')
    || path.split('/').some(part => !part || part === '.' || part === '..' || part === '.git')) throw new Error('Use a project-relative artifact path.');
  return path;
}
export function verificationRequest(value: unknown): VerificationRequest {
  const v = record(value);
  const candidate = v.candidate === undefined ? undefined : candidateSnapshot(v.candidate);
  const criteria = list(v.criteria, item => boundedText(item));
  const artifacts = list(v.artifacts, item => {
    const a = record(item), sha256 = a.sha256 === null && candidate ? null : boundedText(a.sha256, 64);
    if (sha256 !== null && !/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Invalid artifact hash.');
    return { path: artifactPath(a.path), sha256 };
  }, candidate ? 32 : 16);
  if (candidate && JSON.stringify(artifacts) !== JSON.stringify(candidate.files.map(({ path, sha256 }) => ({ path, sha256 })))) throw new Error('Verify every candidate file, including deleted files.');
  if (new Set(criteria).size !== criteria.length || new Set(artifacts.map(a => a.path)).size !== artifacts.length) throw new Error('Duplicate verification target.');
  return { goal: boundedText(v.goal, 20_000), criteria, artifacts, ...(candidate ? { candidate } : {}) };
}
export function evidence(value: unknown): Evidence {
  const v = record(value);
  if (v.kind !== 'file' && v.kind !== 'command') throw new Error('Invalid evidence kind.');
  if (v.exitCode !== null && !Number.isSafeInteger(v.exitCode)) throw new Error('Invalid check exit code.');
  if (v.successful !== undefined && v.successful !== true && v.successful !== false) throw new Error('Invalid check success flag.');
  if (typeof v.output !== 'string' || v.output.length > 1000) throw new Error('Invalid evidence output.');
  return { id: boundedText(v.id, 200), kind: v.kind, detail: boundedText(v.detail, 1000), output: v.output, exitCode: v.exitCode as number | null,
    ...(typeof v.successful === 'boolean' ? { successful: v.successful } : {}) };
}
export function verdict(value: unknown): Verdict {
  const v = record(value);
  if (!['pass', 'fail', 'inconclusive'].includes(String(v.verdict))) throw new Error('Invalid verification verdict.');
  return { criterion: boundedText(v.criterion), verdict: v.verdict as Verdict['verdict'], reason: boundedText(v.reason),
    evidenceIds: Array.isArray(v.evidenceIds) && !v.evidenceIds.length ? [] : list(v.evidenceIds, id => boundedText(id, 200), 32) };
}
export function verificationResult(value: unknown): VerificationResult {
  const v = record(value);
  return { ...(v.candidate === undefined ? {} : { candidate: candidateReference(v.candidate) }), verdicts: list(v.verdicts, verdict), evidence: Array.isArray(v.evidence) && !v.evidence.length ? [] : list(v.evidence, evidence, 64) };
}
export function assertResult(request: VerificationRequest, result: VerificationResult): void {
  if (!sameCandidate(request.candidate, result.candidate)) throw new Error('Verification result belongs to another candidate.');
  if (JSON.stringify(request.criteria) !== JSON.stringify(result.verdicts.map(v => v.criterion))) throw new Error('Verify every original criterion in order.');
  if (new Set(result.evidence.map(e => e.id)).size !== result.evidence.length) throw new Error('Duplicate evidence identity.');
  for (const v of result.verdicts) {
    const selected = v.evidenceIds.map(id => result.evidence.find(e => e.id === id));
    if (selected.some(e => !e)) throw new Error('Unknown evidence receipt.');
    if (v.verdict === 'pass' && (!selected.some(e => e?.kind === 'file') || !selected.some(e => e?.kind === 'command' && e.exitCode === 0 && e.successful === true)
      || selected.some(e => e?.kind === 'command' && (e.exitCode !== 0 || e.successful !== true)))) throw new Error('Pass requires observed file and successful command receipts; failed checks cannot support a pass.');
  }
  if (result.verdicts.every(v => v.verdict === 'pass') && request.artifacts.some(a => !result.evidence.some(e => e.kind === 'file' && e.detail === a.path && e.output === (a.sha256 ?? 'absent')))) {
    throw new Error('Read every artifact before passing verification.');
  }
}
