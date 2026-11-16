import { readHomiePack } from './homie-packs.mts';
import { readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentPackage } from '../../shared/agent-package.ts';
import { readHomieSource } from './homie-source-files.mts';

export async function readAgentPackage(filename: string): Promise<AgentPackage> {
  if (filename.endsWith('.homiepack.json')) return readHomiePack(filename);
  if (basename(filename) !== 'agent.json') throw new Error('Select the package agent.json file.');
  return (await readHomieSource(dirname(filename))).pack;
}
export async function officialAgentPackages(): Promise<AgentPackage[]> {
  const directory = fileURLToPath(new URL('../../../resources/agent-packages/', import.meta.url));
  const entries = await readdir(directory, { withFileTypes: true });
  return Promise.all(entries.filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))
    .map(entry => readAgentPackage(join(directory, entry.name, 'agent.json'))));
}
