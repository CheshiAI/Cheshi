import type { SaveSpecialistAgent, SpecialistAgent } from '../shared/agent-registry.ts';
import type { AgentModel } from '../shared/agent-models.ts';

export function specialistInput(): SaveSpecialistAgent {
  return { id: null, revision: null,
    profile: { name: 'Development', role: 'development', instructions: 'Implement approved changes and verify them.',
      accountId: null, model: null, reasoningEffort: null, serviceTier: null, permissions: { fileWrite: false, commandExecution: false } },
    assignment: { assigned: true, instructions: 'Follow this project’s AGENTS.md.' } };
}
export function specialistModels(): AgentModel[] {
  return [{ id: 'fixture', model: 'model-fixture', displayName: 'Fixture model', description: 'Model fixture', isDefault: true,
    defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ effort: 'medium', description: 'Medium' }, { effort: 'high', description: 'High' }],
    serviceTiers: [{ id: 'priority', name: 'Fast', description: 'Fast service' }], defaultServiceTier: null },
  { id: 'small', model: 'small-fixture', displayName: 'Small model', description: 'Small fixture', isDefault: false,
    defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ effort: 'low', description: 'Low' }], serviceTiers: [], defaultServiceTier: null }];
}
export function specialistAgent(revision = 1): SpecialistAgent {
  return { ...specialistInput().profile, id: 'a1234567-1234-1234-1234-123456789abc', revision,
    createdAt: '2026-10-02T10:00:00Z', updatedAt: '2026-10-02T10:00:00Z', assignments: [] };
}
export function registryDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
