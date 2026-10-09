import { assertVerificationSource } from '../../../experiments/codex-specialists/src/verification-source-files.ts';
import { createHash } from 'node:crypto';
import { assertCandidate } from '../../../experiments/codex-specialists/src/candidate-verification-contract.ts';
import { assertResult, verificationRequest, verificationResult } from '../../../experiments/codex-specialists/src/verification-contract.ts';
import { planIntegration } from '../../../experiments/codex-specialists/src/integration-plan.ts';
import type { Message } from './mailbox.mts';

// Preserve legacy non-candidate messages while validating the new snapshot-bearing boundary.
function hasSnapshot(text: string): boolean {
  try { const value = JSON.parse(text); return value?.candidate !== undefined || value?.source !== undefined; } catch { return false; }
}
export function validateCandidateRequest(item: Message, history: Message[]): void {
  if (!hasSnapshot(item.text)) return;
  const request = verificationRequest(JSON.parse(item.text)), candidate = request.candidate;
  if (item.from === item.to) throw new Error('Snapshot verification requires an independent participant.');
  if (request.source) { assertVerificationSource(request.source); return; }
  if (!candidate) return;
  if (!item.roomId) throw new Error('Candidate verification requires an independent room participant.');
  assertCandidate(candidate, value => createHash('sha256').update(value).digest('hex'));
  const outgoing = history.filter(m => m.from === item.from), incoming = history.filter(m => m.to === item.from);
  if (outgoing.some(m => m.kind === 'work_request' && candidate.requestIds.includes(m.id) && m.to === item.to)) throw new Error('Candidate authors cannot independently verify their own work.');
  const plan = planIntegration({ peers: [], outgoing, incoming, acknowledged: [], consumed: [] }, item.from, item.taskId, item.roomId, candidate.requestIds);
  if (plan.issues.length || JSON.stringify(plan.candidate) !== JSON.stringify(candidate.files)) throw new Error('Candidate does not match accepted proposals.');
  if (candidate.applicationId) {
    const digest = (text: string) => createHash('sha256').update(text).digest('hex');
    if (candidate.applicationId !== digest(`application/${item.from}/${candidate.id}/${candidate.hash}`)) throw new Error('Invalid project application identity.');
    const prior = outgoing.filter(m => m.kind === 'verification_request' && m.taskId === item.taskId && m.roomId === item.roomId).filter(m => {
      const spec = verificationRequest(JSON.parse(m.text));
      return spec.candidate?.id === candidate.id && spec.candidate.hash === candidate.hash && !spec.candidate.applicationId
        && JSON.stringify(spec.criteria) === JSON.stringify(request.criteria);
    }).at(-1);
    const reply = prior && incoming.find(m => m.kind === 'verification_result' && m.questionId === prior.id && m.from === prior.to);
    if (!prior || !reply) throw new Error('Project verification requires a prior candidate verification pass.');
    const result = verificationResult(JSON.parse(reply.text));
    assertResult(verificationRequest(JSON.parse(prior.text)), result);
    if (result.verdicts.some(v => v.verdict !== 'pass')) throw new Error('Candidate verification did not pass.');
  }
}
export function validateCandidateResult(request: Message, result: Message): void {
  if (!hasSnapshot(request.text) && !hasSnapshot(result.text)) return;
  assertResult(verificationRequest(JSON.parse(request.text)), verificationResult(JSON.parse(result.text)));
}
