import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { HomieRepositoryProjects } from '../desktop/lib/agent-management/homie-repository-project.mts';
import { parseSpecialistAgents } from '../desktop/shared/agent-registry.ts';

const { values } = parseArgs({ options: {
  agent: { type: 'string' }, 'state-directory': { type: 'string' }, 'projects-directory': { type: 'string' },
  owner: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
}, strict: true, allowPositionals: false });
if (values.help) {
  process.stdout.write('Usage: bun run scripts/ensure-homie-repository.mts --state-directory /absolute/repository-mappings [--owner github-account-or-organization] [--agent /absolute/saved-homie.json] [--projects-directory /absolute/projects]\nOwner choices are stored locally for the signed-in GitHub account. The default is that account.\n');
} else {
  try {
    if (!values['state-directory'] || (!values.agent && !values.owner)) throw new Error('Provide --state-directory and --agent or --owner.');
    const service = new HomieRepositoryProjects({ stateDirectory: values['state-directory'], projectsDirectory: values['projects-directory'] });
    if (values.owner) await service.setOwner(values.owner);
    if (values.agent) {
      const agent = parseSpecialistAgents([JSON.parse(await readFile(values.agent, 'utf8'))])[0]!;
      process.stdout.write(JSON.stringify(await service.ensure(agent)) + '\n');
    } else process.stdout.write('Saved the repository owner for your GitHub account on this device.\n');
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : 'Homie repository setup failed.') + '\n');
    process.exitCode = 1;
  }
}
