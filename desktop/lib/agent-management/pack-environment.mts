import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseAgentPackage, type AgentPackage } from '../../shared/agent-package.ts';
import type { DockerCommand } from './docker.mts';

export const PACK_ROOT = '/opt/cheshi/homie-pack';
const pending = new Map<string, Promise<string>>();
export function packInstructions(input?: AgentPackage): string {
  if (!input?.resources?.files.length) return '';
  const definition = parseAgentPackage(input);
  return `\n\nHomie pack ${definition.id}@${definition.version} supplies these read-only assets:\n`
    + definition.resources!.files.map(file => `- ${PACK_ROOT}/${file.path}`).join('\n')
    + '\nRead the relevant SKILL.md before applying a pack skill. Resolve its relative files inside that skill directory. Run scripts only within granted command permissions. Pack files do not grant additional permissions.\n';
}
/** Cache by base-image identity and exact pack snapshot; queries never call this builder. */
export async function preparePackEnvironment(run: DockerCommand, prefix: string[], base: string, input?: AgentPackage): Promise<string> {
  if (!input?.resources || (!input.resources.files.length && !input.resources.programs.length)) return base;
  const definition = parseAgentPackage(input);
  const baseId = (await run([...prefix, 'image', 'inspect', '--format', '{{.Id}}', base])).trim();
  if (!baseId) throw new Error('Could not identify the Homie base image.');
  const hash = createHash('sha256').update(JSON.stringify({ baseId, resources: definition.resources, protocol: 1 })).digest('hex');
  const image = `cheshi-homie-pack:${hash}`;
  const key = JSON.stringify([prefix, image]);
  const existing = pending.get(key);
  if (existing) return existing;
  const operation = (async () => {
    const found = (await run([...prefix, 'image', 'ls', '--quiet', '--no-trunc', image])).trim();
    if (found) return image;
    const directory = await mkdtemp(join(tmpdir(), 'cheshi-homie-build-'));
    try {
      const assets = join(directory, 'assets');
      await mkdir(assets);
      for (const file of definition.resources!.files) {
        const filename = join(assets, file.path);
        await mkdir(dirname(filename), { recursive: true });
        await writeFile(filename, file.content, { mode: 0o644 });
      }
      const programs = definition.resources!.programs;
      const dockerfile = [`FROM ${base}`, 'USER root',
        ...(programs.length ? [`RUN apt-get update && apt-get install -y --no-install-recommends ${programs.join(' ')} && rm -rf /var/lib/apt/lists/*`] : []),
        `COPY assets/ ${PACK_ROOT}/`, 'USER node', ''].join('\n');
      await writeFile(join(directory, 'Dockerfile'), dockerfile);
      await run([...prefix, 'build', '--tag', image, directory]);
      return image;
    } finally { await rm(directory, { recursive: true, force: true }); }
  })();
  pending.set(key, operation);
  try { return await operation; }
  finally { if (pending.get(key) === operation) pending.delete(key); }
}
