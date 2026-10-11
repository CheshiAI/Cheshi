import type { AgentPackage } from '../../../../shared/agent-package';
import type { SpecialistProfile } from '../../../../shared/agent-registry';

export interface HomieEditorDraft {
  profile: SpecialistProfile;
  permissions: SpecialistProfile['permissions'];
  revision: number | null;
  assigned: boolean;
  localPack: AgentPackage;
  section: string;
  localSettingsBaseline?: string;
}

export function localSettingsKey(draft: Pick<HomieEditorDraft, 'profile' | 'permissions' | 'assigned'>): string {
  const { profile, permissions, assigned } = draft;
  return JSON.stringify([profile.displayName ?? null, profile.accountId, profile.avatar ?? null,
    profile.model, profile.reasoningEffort, profile.serviceTier,
    profile.permissions.fileWrite, profile.permissions.commandExecution, assigned,
    permissions.fileWrite, permissions.commandExecution]);
}
