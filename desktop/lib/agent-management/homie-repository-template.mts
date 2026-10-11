import { readFile } from 'node:fs/promises';
import { parseAgentPackage } from '../../shared/agent-package.ts';
import type { SpecialistAgent } from '../../shared/agent-registry.ts';

export const HOMIE_TEMPLATE_FILES = ['README.md', '.gitignore', 'agent.json', 'instructions.md'] as const;

/** Portable settings only: no account, project assignments, credentials or runtime history. */
export async function homieRepositoryTemplate(agent: SpecialistAgent): Promise<Record<string, string>> {
  const resources = new URL('../../../resources/homie-repository/', import.meta.url);
  const definition = parseAgentPackage({
    ...(agent.package ?? { schemaVersion: 1, id: `homie.${agent.id}`, version: '1.0.0',
      description: `${agent.name} Homie`, requiredTools: ['codegraph', 'collaboration', 'verification'] }),
    name: agent.name, role: agent.role, instructionsFile: 'instructions.md', instructions: agent.instructions,
    model: { model: agent.model, reasoningEffort: agent.reasoningEffort, serviceTier: agent.serviceTier },
    requestedPermissions: agent.package?.requestedPermissions ?? agent.permissions,
  });
  const { instructions, ...manifest } = definition;
  return {
    'README.md': (await readFile(new URL('README.md', resources), 'utf8')).replaceAll('{{HOMIE_NAME}}', agent.name),
    '.gitignore': await readFile(new URL('gitignore', resources), 'utf8'),
    'agent.json': JSON.stringify(manifest, null, 2) + '\n',
    'instructions.md': instructions,
  };
}
