import { type CollaborationMessage, type CollaborationState } from './collaboration-contract.ts';
import { assertWorkRequest, assertWorkResult, assertWorkRevision, parseWorkRequest, parseWorkResult, parseWorkReview, type WorkFile } from './work-contract.ts';
import { workDigest } from './work-files.ts';
import type { IntegrationIssue } from './integration-contract.ts';

export interface IntegrationPlan {
  fingerprint: string; baseline: WorkFile[]; candidate: WorkFile[]; issues: IntegrationIssue[];
}
/** Recover the original baseline, not the immediately preceding revision's already edited copy. */
export function planIntegration(c: CollaborationState, owner: string, taskId: string, roomId: string, ids: string[]): IntegrationPlan {
  const requests = c.outgoing.filter(m => m.kind === 'work_request' && m.from === owner && m.taskId === taskId && m.roomId === roomId);
  const baseline = new Map<string, WorkFile>(), targets = new Map<string, WorkFile>(), origins = new Map<string, Set<string>>();
  const issues: IntegrationIssue[] = [], receipts: CollaborationMessage[][] = [];
  const issue = (kind: IntegrationIssue['kind'], path: string, selected: string[]) => {
    const existing = issues.find(i => i.kind === kind && i.path === path);
    if (existing) existing.requestIds = [...new Set([...existing.requestIds, ...selected])].sort();
    else issues.push({ kind, path, requestIds: [...new Set(selected)].sort() });
  };
  const messagesFor = (id: string) => {
    const request = requests.find(m => m.id === id);
    const result = c.incoming.find(m => m.kind === 'work_result' && m.questionId === id);
    const review = c.outgoing.find(m => m.kind === 'work_review' && m.questionId === id);
    if (!request || request.questionId !== id || !result || !review || result.to !== owner || result.from !== request.to || review.from !== owner || review.to !== request.to
      || [result, review].some(m => m.taskId !== taskId || m.roomId !== roomId)) throw new Error('Integration requires a complete proposal and review from this room goal.');
    const spec = parseWorkRequest(JSON.parse(request.text)), proposal = parseWorkResult(JSON.parse(result.text)), decision = parseWorkReview(JSON.parse(review.text));
    assertWorkRequest(spec, workDigest); assertWorkResult(spec, proposal, workDigest);
    return { request, result, review, spec, proposal, decision };
  };
  for (const id of ids) {
    const latest = messagesFor(id), chain = [latest], seen = new Set([id]);
    if (latest.decision.decision !== 'accepted' || latest.proposal.status !== 'submitted') throw new Error('Only accepted, submitted proposals can be integrated.');
    if (requests.some(m => parseWorkRequest(JSON.parse(m.text)).previousRequestId === id)) throw new Error('Select the final proposal in a revision chain.');
    let current = latest;
    while (current.spec.previousRequestId) {
      const previousId = current.spec.previousRequestId;
      if (seen.has(previousId)) throw new Error('Cyclic work revision lineage.');
      seen.add(previousId);
      const previous = messagesFor(previousId);
      if (previous.request.to !== latest.request.to || previous.decision.decision !== 'changes_requested') throw new Error('Invalid work revision lineage.');
      assertWorkRevision(previous.spec, previous.proposal, current.spec);
      chain.push(previous); current = previous;
    }
    receipts.push(chain.flatMap(v => [v.request, v.result, v.review]));
    for (const file of latest.spec.files) {
      const original = current.spec.files.find(f => f.path === file.path);
      if (!original) throw new Error('Revision lost its original file scope.');
      const output = latest.proposal.changes.find(f => f.path === file.path) ?? file;
      const final: WorkFile = { path: output.path, content: output.content, sha256: output.sha256 };
      if (final.sha256 !== original.sha256 && !current.spec.writePaths.includes(file.path)) throw new Error('Revision changed read-only context.');
      const priorIds = [...(origins.get(file.path) ?? [])];
      origins.set(file.path, new Set([...priorIds, id]));
      const existing = baseline.get(file.path);
      if (existing && existing.sha256 !== original.sha256) issue('scope_conflict', file.path, [...priorIds, id]);
      else baseline.set(file.path, original);
      if (final.sha256 !== original.sha256) {
        const target = targets.get(file.path);
        if (target && target.sha256 !== final.sha256) issue('proposal_conflict', file.path, [...priorIds, id]);
        else targets.set(file.path, final);
      }
    }
  }
  const files = [...baseline.values()].sort((a, b) => a.path.localeCompare(b.path));
  if (files.length > 32) throw new Error('Integration supports at most 32 snapshot files. Select a smaller proposal set.');
  for (let a = 0; a < files.length; a++) for (let b = a + 1; b < files.length; b++) {
    const first = files[a]!, second = files[b]!, x = first.path.toLowerCase(), y = second.path.toLowerCase();
    if (x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)) {
      issue('scope_conflict', first.path, [...origins.get(first.path)!, ...origins.get(second.path)!]);
    }
  }
  return { fingerprint: workDigest(JSON.stringify(receipts)), baseline: files, candidate: files.map(f => targets.get(f.path) ?? f), issues };
}
