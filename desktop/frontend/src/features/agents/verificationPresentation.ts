import { parseTaskVerification, parseTaskVerificationRequest, type TaskVerification } from '../../../../shared/agent-task-inspection';

export const verificationVerdictLabels = { pass: 'Passed', fail: 'Failed', inconclusive: 'Inconclusive' } as const;

export function verificationSummary(result: TaskVerification): string {
  return (['pass', 'fail', 'inconclusive'] as const).map(verdict => {
    const count = result.verdicts.filter(item => item.verdict === verdict).length;
    return count ? `${verificationVerdictLabels[verdict]} ${count}` : '';
  }).filter(Boolean).join(' · ') || 'No verdict recorded';
}

/** Quote the public verification summary, never serialized context or receipt payloads. */
export function verificationQuote(kind: 'verification_request' | 'verification_result', text: string): string {
  try {
    if (kind === 'verification_result') return `Verification result · ${verificationSummary(parseTaskVerification(JSON.parse(text)))}`;
    const request = parseTaskVerificationRequest(JSON.parse(text));
    return `Verification requested · ${request.criteria.length} criteria · ${request.criteria[0] ?? 'No criteria recorded'}`.replace(/\s+/g, ' ').slice(0, 240);
  } catch { return 'Verification details are unavailable.'; }
}
