import type { SaveSpecialistAgent } from '../../shared/agent-registry.ts';
import { sameAgentModelSelection } from '../../shared/agent-models.ts';
import type { HomieRepositoryProjects } from './homie-repository-project.mts';
import type { createAgentRegistry } from './registry.mts';

export function connectHomieRepository(options: {
  repositories: HomieRepositoryProjects; registry: ReturnType<typeof createAgentRegistry>;
  workspaceRoot: string; input: SaveSpecialistAgent; assertAvailable(): void;
}) {
  const { repositories, registry, workspaceRoot, input, assertAvailable } = options;
  if (!input.repository || input.id !== null) throw new Error('Choose an existing repository for a new Homie.');
  return repositories.connectExisting(input.repository, (id, definition) => {
    assertAvailable();
    if (registry.snapshot(workspaceRoot).agents.some(agent => agent.package?.id === definition.id)) {
      throw new Error('This Homie is already registered. Open its settings to assign this project.');
    }
    if (!sameAgentModelSelection(input.profile, definition.model)) {
      throw new Error('Keep the repository model when connecting. Change it in Homie settings afterward.');
    }
    return registry.save({ ...input, profile: { ...input.profile, name: definition.name, role: definition.role,
      instructions: definition.instructions, package: definition, ...definition.model } }, workspaceRoot, id);
  });
}
