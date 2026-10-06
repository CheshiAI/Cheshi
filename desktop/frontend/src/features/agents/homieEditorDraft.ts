import type { AgentPackage } from '../../../../shared/agent-package';
import type { SpecialistProfile } from '../../../../shared/agent-registry';

export interface HomieEditorDraft {
  profile: SpecialistProfile;
  permissions: SpecialistProfile['permissions'];
  revision: number | null;
  assigned: boolean;
  instructions: string;
  instructionFiles: string[];
  localPack: AgentPackage;
  section: string;
}

export function duplicateHomieDraft(draft: HomieEditorDraft): HomieEditorDraft {
  const copy = structuredClone(draft);
  copy.profile.name = `${copy.profile.name.slice(0, 93)} (copy)`;
  copy.revision = null;
  copy.section = 'basic';
  return copy;
}
