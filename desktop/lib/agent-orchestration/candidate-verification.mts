import { createHash } from 'node:crypto';
import { assertCandidate } from '../../../experiments/codex-specialists/src/candidate-verification-contract.ts';
import { assertResult, verificationRequest, verificationResult } from '../../../experiments/codex-specialists/src/verification-contract.ts';
import { planIntegration } from '../../../experiments/codex-specialists/src/integration-plan.ts';
import type { Message } from './mailbox.mts';

// Preserve legacy non-candidate messages while validating the new snapshot-bearing boundary.
function hasCandidate(text: string): boolean {
  try { return JSON.parse(text)?.candidate !== undefined; } catch { return false; }
}
export function validateCandidateRequest(item: Message, history: Message[]): void {
  if (!hasCandidate(item.text)) return;
  const request = verificationRequest(JSON.parse(item.text)), candidate = request.candidate!;
  if (!item.roomId || item.from === item.to) throw new Error('Candidate verification requires an independent room participant.');
  assertCandidate(candidate, value => createHash('sha256').update(value).digest('hex'));
  const outgoing = history.filter(m => m.from === item.from), incoming = history.filter(m => m.to === item.from);
  if (outgoing.some(m => m.kind === 'work_request' && candidate.requestIds.includes(m.id) && m.to === item.to)) throw new Error('Candidate authors cannot independently verify their own work.');
  const plan = planIntegration({ peers: [], outgoing, incoming, acknowledged: [], consumed: [] }, item.from, item.taskId, item.roomId, candidate.requestIds);
  if (plan.issues.length || JSON.stringify(plan.candidate) !== JSON.stringify(candidate.files)) throw new Error('Candidate does not match accepted proposals.');
}
export function validateCandidateResult(request: Message, result: Message): void {
  if (!hasCandidate(request.text) && !hasCandidate(result.text)) return;
  assertResult(verificationRequest(JSON.parse(request.text)), verificationResult(JSON.parse(result.text)));
}
