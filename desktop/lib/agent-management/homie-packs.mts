import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { parseAgentPackage, type AgentPackage } from '../../shared/agent-package.ts';
import { HOMIE_PACK_BYTES } from '../../shared/homie-pack.ts';

function assertPackFile(isFile: boolean, size: number): void {
  if (!isFile || size > HOMIE_PACK_BYTES * 2) throw new Error('Select a Homie pack file up to 16 MiB.');
}
export async function readHomiePack(filename: string): Promise<AgentPackage> {
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    assertPackFile(info.isFile(), info.size);
    const buffer = Buffer.alloc(HOMIE_PACK_BYTES * 2 + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    assertPackFile(true, length);
    return parseAgentPackage(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))));
  } finally { await file.close(); }
}
export async function writeHomiePack(filename: string, input: AgentPackage): Promise<void> {
  const definition = parseAgentPackage(input);
  const serialized = JSON.stringify(definition, null, 2) + '\n';
  if (Buffer.byteLength(serialized) > HOMIE_PACK_BYTES * 2) throw new Error('Homie pack exceeds 16 MiB.');
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(serialized);
    await file.sync();
  } catch (error) { await file.close(); await unlink(temporary); throw error; }
  await file.close();
  try { await rename(temporary, filename); }
  catch (error) { await unlink(temporary); throw error; }
}
export async function installHomiePack(directory: string, input: AgentPackage): Promise<AgentPackage> {
  const definition = parseAgentPackage(input);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeHomiePack(join(directory, `${definition.id}@${definition.version}.homiepack.json`), definition);
  return definition;
}
export async function installedHomiePacks(directory: string): Promise<AgentPackage[]> {
  let entries: string[];
  try { entries = await readdir(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  return Promise.all(entries.filter(name => name.endsWith('.homiepack.json')).sort().map(name => readHomiePack(join(directory, name))));
}
