import { IntegrationApplication } from './integration-application.ts';
import { parseWorkRequest } from './work-contract.ts';
import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentStore, type Task } from './store.ts';
import { WorkFiles, readWorkFile, workDigest } from './work-files.ts';
import { workSnapshotText, type WorkFile, type WorkRequest } from './work-contract.ts';
import { integrationId, integrationRequests, parseIntegration, type IntegrationIssue, type IntegrationSummary } from './integration-contract.ts';
import { planIntegration, type IntegrationPlan } from './integration-plan.ts';
import { record, type JsonRecord } from './protocol.ts';
import { candidateSnapshot, type CandidateSnapshot } from './candidate-verification-contract.ts';
import { assertResult, verificationRequest, verificationResult } from './verification-contract.ts';

interface Manifest { summary: IntegrationSummary; fingerprint: string; baseline: WorkFile[]; candidate: WorkFile[] | null }
function assertManifestSize(serialized: string): void {
  if (Buffer.byteLength(serialized) > 1_500_000) throw new Error('Integration manifest is too large. Select a smaller proposal set.');
}
const candidateSpec = (files: WorkFile[]): WorkRequest => ({ version: 1, objective: 'Isolated integration candidate', criteria: ['Candidate requires independent verification before application'],
  files, writePaths: [files[0]!.path], snapshot: workDigest(workSnapshotText(files)), previousRequestId: null });
function changedFiles(plan: IntegrationPlan) {
  return plan.candidate.flatMap((file, index) => file.sha256 === plan.baseline[index]!.sha256 ? [] : [{ path: file.path, before: plan.baseline[index]!.sha256, sha256: file.sha256 }]);
}

/** Immutable candidates with separately journaled project application and verification. */
export class WorkerIntegration {
  private readonly store: AgentStore;
  private readonly workspace: string;
  private readonly owner: string;
  private readonly writable: boolean;
  private readonly applicationEnabled: boolean;
  constructor(store: AgentStore, workspace: string, owner: string, writable: boolean, applicationEnabled = false) {
    this.store = store; this.workspace = workspace; this.owner = owner; this.writable = writable; this.applicationEnabled = applicationEnabled;
  }
  private root(create: boolean): string {
    const root = join(realpathSync(this.store.directory), 'integrations');
    if (create && !existsSync(root)) mkdirSync(root, { mode: 0o700 });
    if (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) throw new Error('Invalid integration storage.');
    return root;
  }
  private directory(id: string): string {
    const directory = join(this.root(false), id);
    if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) throw new Error('Invalid integration directory.');
    return directory;
  }
  private read(id: string): Manifest {
    const descriptor = openSync(join(this.directory(id), 'manifest.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(descriptor);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1_500_000) throw new Error('Invalid integration manifest.');
      const data = record(JSON.parse(readFileSync(descriptor, 'utf8')));
      const summary = parseIntegration(data.summary);
      if (summary.id !== id || typeof data.fingerprint !== 'string' || !Array.isArray(data.baseline)
        || !(data.candidate === null || Array.isArray(data.candidate))) throw new Error('Invalid saved integration.');
      // File data is compared with the validated message lineage before it is used as a path or content.
      return { summary, fingerprint: data.fingerprint, baseline: data.baseline as WorkFile[], candidate: data.candidate as WorkFile[] | null };
    } finally { closeSync(descriptor); }
  }
  private plan(task: Task, ids: string[]) {
    return planIntegration(this.store.snapshot().collaboration, this.owner, task.id, task.roomId!, ids);
  }
  private sources(plan: IntegrationPlan, ids: string[]): IntegrationIssue[] {
    return plan.baseline.flatMap<IntegrationIssue>(file => {
      try { return readWorkFile(this.workspace, file.path).sha256 === file.sha256 ? [] : [{ kind: 'source_changed' as const, path: file.path, requestIds: ids }]; }
      catch { return [{ kind: 'source_unavailable' as const, path: file.path, requestIds: ids }]; }
    });
  }
  private issue(summary: IntegrationSummary, status: 'invalid' | 'stale', kind: IntegrationIssue['kind']): IntegrationSummary {
    return { ...summary, status, checkedAt: new Date().toISOString(), issues: [{ kind, path: null, requestIds: summary.requestIds }] };
  }
  snapshot(task: Task): CandidateSnapshot {
    const summary = this.inspect(task);
    if (!summary || summary.status !== 'prepared') throw new Error('Prepare a current, intact integration candidate before verification.');
    const saved = this.read(summary.id);
    if (summary.application?.status === 'applied' && (summary.verification?.status !== 'pass' || summary.verification.requestId !== summary.application.verificationId)) throw new Error('Application lacks its candidate verification receipt.');
    if (summary.application && summary.application.status !== 'applied') throw new Error('Inspect and resolve the interrupted application before verification.');
    return candidateSnapshot({ id: summary.id, hash: summary.candidateHash, requestIds: summary.requestIds, files: saved.candidate,
      ...(summary.application ? { applicationId: summary.application.id } : {}) });
  }
  private withVerification(task: Task, summary: IntegrationSummary, project = false): IntegrationSummary {
    const c = this.store.snapshot().collaboration;
    const request = c.outgoing.filter(m => m.kind === 'verification_request' && m.taskId === task.id && m.roomId === task.roomId)
      .filter(m => { const candidate = verificationRequest(JSON.parse(m.text)).candidate; return candidate?.id === summary.id
        && candidate.applicationId === (project ? summary.application?.id : undefined); }).at(-1);
    if (!request || (project && !summary.application)) return summary;
    const spec = verificationRequest(JSON.parse(request.text)), reply = c.incoming.find(m => m.kind === 'verification_result' && m.questionId === request.id
      && m.from === request.to && m.to === this.owner && m.taskId === task.id && m.roomId === task.roomId);
    let result = null, status: NonNullable<IntegrationSummary['verification']>['status'] = 'pending';
    if (reply) {
      try { result = verificationResult(JSON.parse(reply.text)); assertResult(spec, result);
        status = result.verdicts.some(v => v.verdict === 'fail') ? 'fail' : result.verdicts.every(v => v.verdict === 'pass') ? 'pass' : 'inconclusive';
      } catch { result = null; status = 'inconclusive'; }
    }
    if (summary.status !== 'prepared' || (project && summary.application?.status !== 'applied') || spec.candidate?.hash !== summary.candidateHash
      || JSON.stringify(spec.criteria) !== JSON.stringify(task.goal?.criteria.map(v => v.criterion))) status = 'stale';
    return { ...summary, [project ? 'projectVerification' : 'verification']: { requestId: request.id, agentId: request.to, status, result } };
  }
  /** Recheck immutable bytes and the current source whenever a candidate is inspected. */
  inspect(task: Task, reference = task.integration): IntegrationSummary | null {
    if (!reference) return null;
    return this.withVerification(task, this.withVerification(task, this.inspectFiles(task, reference)), true);
  }
  private inspectFiles(task: Task, reference: IntegrationSummary): IntegrationSummary {
    let saved: Manifest;
    try {
      saved = this.read(reference.id);
      if (saved.summary.taskId !== task.id || saved.summary.roomId !== task.roomId || JSON.stringify(saved.summary.requestIds) !== JSON.stringify(reference.requestIds)) {
        return this.issue(reference, 'invalid', 'candidate_changed');
      }
    } catch { return this.issue(reference, 'invalid', 'candidate_changed'); }
    let plan: IntegrationPlan;
    try { plan = this.plan(task, saved.summary.requestIds); }
    catch { return this.issue(reference, 'stale', 'proposal_changed'); }
    if (plan.fingerprint !== saved.fingerprint) return this.issue(reference, 'stale', 'proposal_changed');
    if (JSON.stringify(plan.baseline) !== JSON.stringify(saved.baseline)) return this.issue(reference, 'invalid', 'candidate_changed');
    const summary = { ...saved.summary, checkedAt: new Date().toISOString() };
    if (summary.status !== 'prepared') return summary; // Failed attempts are evidence, never silently rebuilt.
    if (!saved.candidate || JSON.stringify(plan.candidate) !== JSON.stringify(saved.candidate) || plan.issues.length
      || JSON.stringify(changedFiles(plan)) !== JSON.stringify(summary.files) || workDigest(workSnapshotText(plan.candidate)) !== summary.candidateHash) {
      return this.issue(reference, 'invalid', 'candidate_changed');
    }
    try {
      const files = new WorkFiles(this.directory(summary.id), summary.candidateHash!, candidateSpec(plan.candidate), true);
      if (plan.candidate.some(file => files.read(file.path).sha256 !== file.sha256)) return this.issue(reference, 'invalid', 'candidate_changed');
    } catch { return this.issue(reference, 'invalid', 'candidate_changed'); }
    let application;
    try { application = this.application(saved).inspect(); }
    catch { return this.issue(reference, 'invalid', 'candidate_changed'); }
    if (!application && reference.application) return this.issue(reference, 'invalid', 'candidate_changed');
    if (application) {
      const issues: IntegrationIssue[] = application.status === 'conflict' ? [{ kind: 'source_changed', path: null, requestIds: summary.requestIds }] : [];
      // An unfinished application stays stale even when the files have no external conflict.
      return { ...summary, application, status: application.status === 'applied' ? 'prepared' : 'stale', issues };
    }
    const issues = this.sources(plan, summary.requestIds);
    return { ...summary, status: issues.length ? 'stale' : 'prepared', issues };
  }
  private application(saved: Manifest): IntegrationApplication {
    if (!saved.candidate || !saved.summary.candidateHash) throw new Error('No prepared candidate to apply.');
    return new IntegrationApplication(this.directory(saved.summary.id), this.workspace, this.owner, saved.summary.id, saved.summary.candidateHash, saved.baseline, saved.candidate);
  }
  assertComplete(task: Task, consuming: string[] = []): void {
    const summary = this.inspect(task), c = this.store.snapshot().collaboration;
    if (summary?.application?.status !== 'applied' || summary.projectVerification?.status !== 'pass' || summary.verification?.status !== 'pass' || summary.verification.requestId !== summary.application.verificationId) throw new Error('Candidate is not applied and independently verified in the project.');
    const check = summary.projectVerification;
    if (!c.peers.some(p => p.id === check.agentId && p.role === 'verification') || !c.rooms?.[task.roomId!]?.includes(check.agentId)) throw new Error('Project verifier is no longer an independent room participant.');
    const result = c.incoming.find(m => m.kind === 'verification_result' && m.questionId === check.requestId);
    if (!result || (!c.consumed.includes(result.id) && !consuming.includes(result.id))) throw new Error('Process the project verification result before completing.');
    const requests = c.outgoing.filter(m => m.kind === 'work_request' && m.taskId === task.id);
    if (requests.some(m => !requests.some(next => parseWorkRequest(JSON.parse(next.text)).previousRequestId === m.id) && !summary.requestIds.includes(m.id))) throw new Error('Apply every final accepted proposal before completing.');
  }
  private apply(task: Task, tool: string, input: unknown): JsonRecord {
    const c = this.store.snapshot().collaboration, args = record(input);
    if (!this.applicationEnabled || !this.writable || !c.rooms?.[task.roomId!]?.includes(this.owner)) throw new Error('Application requires the owning writable room participant and an updated worker.');
    if (!task.integration || task.integration.id !== args.candidateId || task.integration.candidateHash !== args.hash) throw new Error('Select the exact current candidate ID and hash.');
    const saved = this.read(task.integration.id);
    // Validate immutable candidate/lineage even when its original has already been partly applied.
    const summary = this.inspect(task)!;
    if (summary.status === 'invalid' || summary.issues.some(i => i.kind === 'proposal_changed')) throw new Error('Candidate contents or lineage changed.');
    const application = this.application(saved);
    let receipt = application.inspect();
    if (tool === 'recover_integration') receipt = application.recover();
    else if (!receipt) {
      if (summary.status !== 'prepared' || summary.verification?.status !== 'pass') throw new Error('Apply only a current candidate with passed independent verification.');
      const verifier = summary.verification.agentId;
      if (!c.peers.some(p => p.id === verifier && p.role === 'verification') || !c.rooms?.[task.roomId!]?.includes(verifier)) throw new Error('Candidate verifier is no longer available.');
      receipt = application.apply(summary.verification.requestId);
    }
    const checked = this.inspect(task)!;
    this.store.update(task.id, { integration: checked });
    return { integration: checked, application: receipt, appliedToProject: receipt.status === 'applied', independentlyVerified: checked.projectVerification?.status === 'pass' };
  }
  call(task: Task, tool: string, input: unknown): JsonRecord {
    if (!task.goal || !task.roomId || task.delegation || task.consultation || task.verification) throw new Error('Integration belongs to the owning room goal.');
    if (tool === 'apply_integration' || tool === 'recover_integration') return this.apply(task, tool, input);
    if (tool === 'integration_status') {
      const summary = this.inspect(task);
      if (summary) this.store.update(task.id, { integration: summary });
      return { integration: summary, appliedToProject: summary?.application?.status === 'applied', independentlyVerified: summary?.projectVerification?.status === 'pass' };
    }
    if (tool !== 'prepare_integration') throw new Error('Unknown integration tool.');
    const previousApplication = task.integration && this.inspect(task)?.application;
    if (previousApplication && !['applied', 'aborted'].includes(previousApplication.status)) throw new Error('Keep the current application record; resolve it before preparing another candidate.');
    const c = this.store.snapshot().collaboration;
    if (!this.writable || !c.rooms?.[task.roomId]?.includes(this.owner)) throw new Error('Integration requires the owning writable room participant.');
    const args = record(input), requestId = integrationId(args.requestId), ids = integrationRequests(args.requestIds);
    const id = workDigest(`integration/${this.owner}/${task.id}/${requestId}`);
    const root = this.root(true), directory = join(root, id);
    if (existsSync(directory) || lstatExists(directory)) {
      const saved = this.read(id);
      if (saved.summary.taskId !== task.id || saved.summary.roomId !== task.roomId || JSON.stringify(saved.summary.requestIds) !== JSON.stringify(ids)) throw new Error('Integration request identity conflict.');
      const summary = this.inspect(task, saved.summary)!;
      this.store.update(task.id, { integration: summary });
      return { integration: summary, appliedToProject: false, independentlyVerified: summary.verification?.status === 'pass' };
    }
    const plan = this.plan(task, ids), issues = [...plan.issues, ...this.sources(plan, ids)];
    const timestamp = new Date().toISOString();
    const summary: IntegrationSummary = parseIntegration({ version: 1, id, taskId: task.id, roomId: task.roomId, requestIds: ids,
      status: plan.issues.length ? 'conflict' : issues.length ? 'stale' : 'prepared', candidateHash: issues.length ? null : workDigest(workSnapshotText(plan.candidate)),
      files: issues.length ? [] : changedFiles(plan), issues, createdAt: timestamp, checkedAt: timestamp });
    const temporary = join(root, `${id}-${randomUUID()}`);
    mkdirSync(temporary, { mode: 0o700 });
    try {
      if (summary.status === 'prepared') new WorkFiles(temporary, summary.candidateHash!, candidateSpec(plan.candidate));
      const manifest: Manifest = { summary, fingerprint: plan.fingerprint, baseline: plan.baseline, candidate: summary.status === 'prepared' ? plan.candidate : null };
      const serialized = JSON.stringify(manifest);
      assertManifestSize(serialized);
      writeFileSync(join(temporary, 'manifest.json'), serialized, { flag: 'wx', mode: 0o600, flush: true });
      renameSync(temporary, directory); // Publish complete attempts; a retry after a lost acknowledgement reads this directory.
    } finally { if (existsSync(temporary)) rmSync(temporary, { recursive: true }); }
    const checked = this.inspect(task, summary)!;
    this.store.update(task.id, { integration: checked });
    return { integration: checked, appliedToProject: false, independentlyVerified: false };
  }
}
function lstatExists(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

export const integrationTools = [
  { type: 'function', name: 'prepare_integration', description: 'Check selected final accepted proposals against their original source and build an isolated candidate. No line merge, source writes, verification or application. Reuse requestId only for identical retries. Use a new id after resolving conflicts.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['requestId', 'requestIds'], properties: {
      requestId: { type: 'string' }, requestIds: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'string' } },
    } } },
  { type: 'function', name: 'integration_status', description: 'Recheck the latest isolated candidate, source hashes and proposal lineage. Prepared alone does not mean verified, applied or complete. Verification results are tied to this candidate and source snapshot.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} } },
];
export const integrationInstructions = `
After reviewing final delegated proposals, use prepare_integration with their request IDs to create an isolated integration candidate.
The worker recovers cumulative revision changes and compares the original baseline with current project files, including read-only context.
Different files and identical edits combine. Different edits to the same file, incompatible paths or changed source stop preparation. No line-based merge is attempted.
Use integration_status to recheck saved candidates. A changed source or damaged candidate is not ready. Repeating the same request does not rebuild it.
Report conflicts with affected paths and request IDs. Ask for clarification or delegate a fresh scoped proposal as appropriate; do not overwrite the original project to resolve a conflict.
`;
export const candidateVerificationInstructions = `
Use request_verification with an independent invited verifier who did not author any selected proposal and unchanged goal criteria. When this goal has an integration candidate, the worker sends the ENTIRE latest prepared candidate, including absent files; paths must list every candidate file. Include needed tests and dependencies in the delegated scope before preparing it.
Inspect integration_status for pending, pass, fail, inconclusive or stale verification. Failures require a fresh proposal/candidate and verification round. Missing dependencies or command permission require inconclusive, never a fabricated pass.
A passed candidate alone is not applied. Without the application tools, report blocked when application is the only remaining action. Never claim the original project changed without an application receipt.
`;

export const applicationTools = ['apply_integration', 'recover_integration'].map(name => ({ type: 'function', name,
  description: name === 'apply_integration' ? 'Apply the exact independently verified candidate within the approved file-write scope. Rechecks source, records each mutation and never replays an interrupted attempt.' : 'Inspect the saved application against actual files. Never writes or rolls back project files. Partial or conflicting applications stay blocked for user review.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['candidateId', 'hash'], properties: { candidateId: { type: 'string' }, hash: { type: 'string' } } },
}));
export const applicationInstructions = `
After candidate verification passes, use apply_integration with its exact ID and hash only within the user's approved scope and existing Write files permission.
Use recover_integration after an interrupted application. Recovery checks actual files without retrying or undoing changes. Partial or conflicting applications require user review; never repair them with shell commands or direct edits.
An applied receipt still requires a NEW request_verification round. It verifies the actual project, including deleted files, and must retain the original criteria and full candidate scope. Use a new requestId.
Only complete after processing a passed project verification result and checking all original completion conditions. Report failed or inconclusive verification without claiming completion.
`;
