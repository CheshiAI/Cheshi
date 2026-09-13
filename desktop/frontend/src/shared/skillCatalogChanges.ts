let revision = 0;
const workflowThreads = new Set<string>();

export const skillCatalogRevision = () => revision;
export function invalidateSkillCatalog() { revision++; }
export function trackSkillCatalogWorkflow(threadId: string) {
  workflowThreads.add(threadId);
  invalidateSkillCatalog();
}
export function completeSkillCatalogWorkflowTurn(threadId: string) {
  if (workflowThreads.has(threadId)) invalidateSkillCatalog();
}
