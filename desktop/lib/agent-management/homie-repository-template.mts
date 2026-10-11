import { readFile } from 'node:fs/promises';
import type { SpecialistAgent } from '../../shared/agent-registry.ts';
import { portableAgent, sourceFiles } from './homie-source-files.mts';

export const HOMIE_TEMPLATE_FILES = ['README.md', '.gitignore', 'agent.json', 'instructions.md'] as const;

/** Portable settings only: no account, project assignments, credentials or runtime history. */
export async function homieRepositoryTemplate(agent: SpecialistAgent): Promise<Record<string, string>> {
  const resources = new URL('../../../resources/homie-repository/', import.meta.url);
  return {
    'README.md': (await readFile(new URL('README.md', resources), 'utf8')).replaceAll('{{HOMIE_NAME}}', agent.name),
    '.gitignore': await readFile(new URL('gitignore', resources), 'utf8'),
    ...sourceFiles(portableAgent(agent)),
  };
}
