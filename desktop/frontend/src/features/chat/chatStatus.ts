import type { ChatStatusDetails } from '../../../../shared/chat-status';
import type { CodexCredits } from '../../../../shared/codex-accounts';
import { normalizeCodexAccountUsage } from '../account/model';

const text = (value: unknown) => typeof value === 'string' && value.length > 0 ? value : null;
export function normalizeChatStatusDetails(value: unknown): ChatStatusDetails | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return {
    version: text(record.version), server: text(record.server) ?? 'Not reported',
    provider: text(record.provider), directory: text(record.directory) ?? 'Not reported',
    permissionProfile: text(record.permissionProfile) ?? 'Not reported',
    approvalPolicy: text(record.approvalPolicy), approvalsReviewer: text(record.approvalsReviewer),
    instructionFiles: Array.isArray(record.instructionFiles) && record.instructionFiles.every(file => typeof file === 'string')
      ? record.instructionFiles : null,
    instructionNote: text(record.instructionNote) ?? 'Loaded instruction files are not reported.',
    account: text(record.account), plan: text(record.plan), usage: normalizeCodexAccountUsage(record.usage),
    warnings: Array.isArray(record.warnings) ? record.warnings.filter((entry): entry is string => typeof entry === 'string') : [],
  };
}

export function statusCredits(credits: CodexCredits | undefined): string {
  if (!credits) return 'Not reported';
  if (credits.unlimited) return 'Unlimited';
  if (credits.balance !== null) {
    // Show whole credits without rounding up or losing precision on large balances.
    const balance = credits.balance.replace(/\.\d+$/, '');
    return `${balance} credits`;
  }
  return credits.hasCredits ? 'Available; balance not reported' : 'No credits available';
}
export function statusPlan(plan: string | null | undefined): string {
  if (!plan) return 'Plan not reported';
  // Match Codex 0.163.0's status subscription labels, including the API's legacy plan names.
  const labels: Record<string, string> = {
    pro: 'Pro 200', prolite: 'Pro 100', promax: 'Pro 500', team: 'Business',
    self_serve_business_prolite: 'Business Premium', self_serve_business_usage_based: 'Business',
    business: 'Enterprise', enterprise_cbp_automation: 'Enterprise (Automation)',
    enterprise_cbp_usage_based: 'Enterprise',
  };
  if (labels[plan]) return labels[plan];
  return plan.replace(/_/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());
}
