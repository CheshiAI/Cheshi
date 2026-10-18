import type { HostToolReason, HostToolStatus } from '../../../../shared/host-tools';

const reasons: Record<HostToolReason, string> = {
  'no-grant': 'Local approval is required for this Homie, project and account on this computer.',
  'package-changed': 'The Homie package has changed since approval.',
  'runtime-changed': 'The tool now requires a different runtime.',
  'executable-missing': 'The saved executable is missing or cannot be accessed.',
  'executable-changed': 'The saved executable has changed since approval.',
  'policy-changed': 'The automatic approval used for this version is no longer active.',
  'dependencies-unavailable': 'The managed dependencies are missing or have changed.',
  'status-changed': 'The tool or its approval changed while checking. Review its current settings.',
};

export function hostToolPresentation(status: HostToolStatus | null, saved: boolean) {
  if (!saved) return { title: 'Save required', description: 'Save the tool before reviewing local access.', action: 'Review host access…', details: false };
  if (!status) return { title: 'Checking access…', description: 'Checking the saved local approval.', action: 'Review host access…', details: false };
  const reason = status.reason ? reasons[status.reason] : reasons['no-grant'];
  const state = status.state ?? (status.allowed ? 'approved' : 'approval-required');
  switch (state) {
    case 'approved': return { title: 'Approved', description: 'Approval is saved for this project and account. You do not need to approve each use.', action: 'View approval details', details: true };
    case 'automatic-renewal': return { title: 'Automatic renewal pending', description: `${reason} Approval will renew automatically on the next use.`, action: 'View approval details', details: true };
    case 'review-required': return { title: 'Review required', description: reason, action: 'Review changes…', details: false };
    case 'preparation-required': return { title: 'Preparation required', description: `${reason} Your approval record is still saved.`, action: 'Prepare runtime…', details: false };
    default: return { title: 'Approval required', description: reason, action: status.autoApprove ? 'Configure host access…' : 'Review host access…', details: false };
  }
}
