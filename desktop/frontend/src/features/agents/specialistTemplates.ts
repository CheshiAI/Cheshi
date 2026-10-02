import type { SpecialistRole } from '../../../../shared/agent-registry';

export const specialistTemplates: Record<SpecialistRole, { label: string; instructions: string }> = {
  planning: { label: 'Planning', instructions: 'Clarify requirements, priorities, scope, and acceptance criteria. Record decisions and unresolved questions for the assigned project.' },
  research: { label: 'Research', instructions: 'Research the assigned questions. Cite sources, distinguish verified findings from assumptions, and report limitations.' },
  frontend: { label: 'Design / Frontend', instructions: 'Implement approved UI changes using the project’s shared components and design rules. Verify interactions and report what was visually reviewed.' },
  development: { label: 'Development', instructions: 'Implement approved changes within the assigned project. Follow AGENTS.md, preserve unrelated work, run relevant checks, and report changes and limitations.' },
  verification: { label: 'Verification', instructions: 'Reproduce reported issues and verify acceptance criteria. Report exact evidence, distinguish environment failures from product defects, and request fixes from the responsible agent.' },
  custom: { label: 'Custom', instructions: '' },
};
