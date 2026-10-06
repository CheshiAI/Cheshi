import { readHomiePack } from './homie-packs.mts';
import { constants } from 'node:fs';
import { open, realpath, readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAgentPackage, parseAgentPackageManifest } from '../../shared/agent-package.ts';
import type { AgentPackage } from '../../shared/agent-package.ts';

const MAX_BYTES = 256 * 1024;
function assertPackageFile(isFile: boolean, size: number): void {
  if (!isFile || size > MAX_BYTES) throw new Error('Package files must be regular UTF-8 files of at most 256 KiB.');
}
async function readPackageFile(filename: string, directory: string): Promise<string> {
  const resolved = await realpath(filename);
  if (dirname(resolved) !== directory) throw new Error('Package files must stay inside the selected package directory.');
  const file = await open(resolved, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    assertPackageFile(info.isFile(), info.size);
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    assertPackageFile(true, length);
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
  } finally { await file.close(); }
}
export async function readAgentPackage(filename: string): Promise<AgentPackage> {
  if (filename.endsWith('.homiepack.json')) return readHomiePack(filename);
  if (basename(filename) !== 'agent.json') throw new Error('Select the package agent.json file.');
  const directory = await realpath(dirname(filename));
  const manifest = parseAgentPackageManifest(JSON.parse(await readPackageFile(filename, directory)));
  const instructions = await readPackageFile(join(directory, manifest.instructionsFile), directory);
  return parseAgentPackage({ ...manifest, instructions });
}
export async function officialAgentPackages(): Promise<AgentPackage[]> {
  const directory = fileURLToPath(new URL('../../../resources/agent-packages/', import.meta.url));
  const entries = await readdir(directory, { withFileTypes: true });
  return Promise.all(entries.filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))
    .map(entry => readAgentPackage(join(directory, entry.name, 'agent.json'))));
}
