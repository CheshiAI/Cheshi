import { readWorkFile } from './work-files.ts';
import { candidateReference } from './candidate-verification-contract.ts';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { record, type JsonRecord } from './protocol.ts';
import { AgentStore, type Task } from './store.ts';
import type { RecoveryReceipt } from './recovery.ts';
import { WORK_MESSAGE_LIMIT } from './work-contract.ts';
import { verificationCandidateFiles } from './verification-candidate-files.ts';
import { artifactPath, assertResult, list, verdict, verificationRequest, verificationResult,
  type Artifact, type Evidence, type VerificationRequest, type VerificationResult } from './verification-contract.ts';

function readArtifact(workspace: string, path: string): Buffer {
  const root = realpathSync(workspace), parts = artifactPath(path).split('/');
  let target = root;
  for (const part of parts) {
    target = join(target, part);
    if (lstatSync(target).isSymbolicLink()) throw new Error('Symlink artifacts are not supported.');
  }
  if (!lstatSync(target).isFile()) throw new Error('Use regular artifact files.');
  const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 65_536 || realpathSync(target) !== target) throw new Error('Use regular artifacts up to 64 KiB inside the project.');
    // Worker containers are Linux: validate the opened descriptor too, not only its lexical path.
    if (process.platform === 'linux' && realpathSync(`/proc/self/fd/${fd}`) !== target) throw new Error('Artifact path changed during open.');
    const bytes = readFileSync(fd);
    if (bytes.length > 65_536) throw new Error('Artifact grew beyond the size limit.');
    return bytes;
  } finally { closeSync(fd); }
}
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export function snapshotArtifacts(workspace: string, paths: unknown): Artifact[] {
  return list(paths, value => {
    const path = artifactPath(value);
    return { path, sha256: hash(readArtifact(workspace, path)) };
  });
}
export function assertSnapshot(workspace: string, artifacts: Artifact[]): void {
  if (JSON.stringify(snapshotArtifacts(workspace, artifacts.map(a => a.path))) !== JSON.stringify(artifacts)) {
    throw new Error('Verification artifacts changed. Request a new verification round.');
  }
}
export class WorkerVerification {
  private readonly store: AgentStore;
  private readonly workspace: string;
  private readonly checks = new Set<string>();
  constructor(store: AgentStore, workspace: string) { this.store = store; this.workspace = workspace; }
  request(task: Task): VerificationRequest {
    const message = this.store.snapshot().collaboration.incoming.find(m => m.kind === 'verification_request' && m.id === task.verification);
    if (!message || message.roomId !== task.roomId) throw new Error('No verification request belongs to this task.');
    return verificationRequest(JSON.parse(message.text));
  }
  recoveryWorkspace(task: Task): string {
    const candidate = this.request(task).candidate;
    return candidate && !candidate.applicationId ? join(realpathSync(this.store.directory), 'verification-candidates', task.verification!) : this.workspace;
  }
  workspaceFor(task: Task, existing = true): string {
    const candidate = this.request(task).candidate;
    if (candidate?.applicationId) {
      if (candidate.files.some(file => readWorkFile(this.workspace, file.path).sha256 !== file.sha256)) throw new Error('Applied project changed. Request a new verification round.');
      return this.workspace;
    }
    return candidate ? verificationCandidateFiles(this.store.directory, task.verification!, candidate, existing).directory : this.workspace;
  }
  private assertCurrent(task: Task): void {
    const request = this.request(task);
    if (request.candidate) this.workspaceFor(task);
    else assertSnapshot(this.workspace, request.artifacts);
  }
  private save(task: Task, receipt: Evidence): void {
    const receipts = this.store.task(task.id)?.verificationEvidence ?? [];
    const previous = receipts.find(e => e.id === receipt.id);
    if (previous) {
      if (JSON.stringify(previous) !== JSON.stringify(receipt)) throw new Error('Evidence identity conflict.');
      return;
    }
    if (receipts.length >= (this.request(task).candidate ? 64 : 32)) throw new Error('Verification evidence limit reached.');
    this.store.update(task.id, { verificationEvidence: [...receipts, receipt] });
  }
  /** Receipts originate from native app-server events, never from tool arguments. */
  observe(task: Task, method: string, item: JsonRecord): void {
    if (!task.verification || item.type !== 'commandExecution' || typeof item.id !== 'string') return;
    const key = `${task.id}/${item.id}`;
    if (method === 'item/started') {
      try { this.assertCurrent(task); this.checks.add(key); }
      catch { this.checks.delete(key); }
      return;
    }
    if (!this.checks.delete(key)) return;
    try { this.assertCurrent(task); }
    catch { return; }
    if (typeof item.command !== 'string' || !item.command.trim()) return;
    this.save(task, { id: item.id, kind: 'command', detail: item.command.slice(0, 1000),
      output: typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput.slice(0, 1000) : '',
      exitCode: Number.isSafeInteger(item.exitCode) ? Number(item.exitCode) : null,
      successful: item.status === 'completed' && item.exitCode === 0 });
  }
  call(task: Task, tool: string, value: unknown): JsonRecord {
    const request = this.request(task), args = record(value);
    if (tool === 'verification_status') return { request, evidence: task.verificationEvidence ?? [] };
    if (task.verificationDraft) throw new Error('End the turn after submitting verification.');
    if (tool === 'verification_read') {
      const path = artifactPath(args.path);
      if (!request.artifacts.some(a => a.path === path)) throw new Error('Read only the requested artifacts through this tool.');
      this.assertCurrent(task);
      const file = request.candidate ? request.candidate.applicationId ? readWorkFile(this.workspace, path) : verificationCandidateFiles(this.store.directory, task.verification!, request.candidate).read(path) : null;
      const bytes = file ? null : readArtifact(this.workspace, path), sha256 = file ? file.sha256 : hash(bytes!);
      if (request.artifacts.find(a => a.path === path)?.sha256 !== sha256) throw new Error('Artifact changed during read.');
      const receipt: Evidence = { id: `file-${sha256 ?? 'absent'}-${request.artifacts.findIndex(a => a.path === path)}`, kind: 'file', detail: path, output: sha256 ?? 'absent', exitCode: null };
      this.save(task, receipt);
      return { receipt, content: file ? file.content : bytes!.toString('utf8') };
    }
    if (tool !== 'submit_verification') throw new Error('Unsupported verification tool.');
    const result = { ...(request.candidate ? { candidate: candidateReference(request.candidate) } : {}), verdicts: list(args.verdicts, verdict), evidence: task.verificationEvidence ?? [] };
    assertResult(request, result);
    if (JSON.stringify(result).length > (request.candidate ? WORK_MESSAGE_LIMIT : 12_000)) throw new Error('Verification result exceeds the message limit. Use fewer receipts in a new verification round.');
    if (result.verdicts.some(v => v.verdict === 'pass')) this.assertCurrent(task);
    this.store.update(task.id, { verificationDraft: result });
    return { status: 'recorded', guidance: 'End this turn. The result is published only after successful completion and a final artifact check.' };
  }
  finish(task: Task): VerificationResult {
    const request = this.request(task);
    if (task.verificationDraft) {
      const result = verificationResult(task.verificationDraft);
      try {
        assertResult(request, result);
        if (result.verdicts.some(v => v.verdict === 'pass')) this.assertCurrent(task);
        return result;
      } catch { /* A stale snapshot must wake the owner for re-verification, never pass. */ }
    }
    return this.inconclusive(request);
  }
  recover(task: Task, receipt: RecoveryReceipt): VerificationResult {
    const request = this.request(task);
    if (receipt.status === 'completed' && task.verificationDraft) {
      try {
        const result = verificationResult(task.verificationDraft);
        assertResult(request, result);
        assertRecordedEvidence(task, result);
        this.assertCurrent(task);
        return result;
      } catch { /* A terminal turn alone cannot establish a verification verdict. */ }
    }
    return this.inconclusive(request);
  }
  private inconclusive(request: VerificationRequest): VerificationResult {
    return { ...(request.candidate ? { candidate: candidateReference(request.candidate) } : {}), verdicts: request.criteria.map(criterion => ({ criterion, verdict: 'inconclusive',
      reason: 'No confirmed verification result for the current artifact snapshot. Request a new verification round.', evidenceIds: [] })), evidence: [] };
  }
}

function assertRecordedEvidence(task: Task, result: VerificationResult): void {
  if (JSON.stringify(result.evidence) !== JSON.stringify(task.verificationEvidence ?? [])) {
    throw new Error('Verification draft does not match recorded evidence.');
  }
}
