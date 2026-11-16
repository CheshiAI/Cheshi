import { constants } from 'node:fs';
import { open, realpath, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseAgentPackage, type AgentPackage } from '../../shared/agent-package.ts';
import { HOMIE_PACK_BYTES } from '../../shared/homie-pack.ts';
import type { SpecialistAgent } from '../../shared/agent-registry.ts';

const roots = ['skills', 'scripts', 'resources'];
function assertFile(regular: boolean, size: number, name: string): void {
  const limit = name === 'agent.json' || name === 'instructions.md' ? 256 * 1024 : HOMIE_PACK_BYTES;
  if (!regular || size > limit) throw new Error(`${name}: expected a regular UTF-8 file of at most ${limit === HOMIE_PACK_BYTES ? '8 MiB' : '256 KiB'}.`);
}
function decodeSourceFile(bytes: Uint8Array, name: string): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch (cause) { throw new Error(`${name}: expected valid UTF-8 text.`, { cause }); }
}
export async function readSourceFile(root: string, name: string): Promise<string> {
  if (path.isAbsolute(name) || /[\\\0]/.test(name) || name.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('Invalid Homie file path.');
  const filename = path.join(root, name), resolved = await realpath(filename);
  if (resolved !== filename || !resolved.startsWith(root + path.sep)) throw new Error(`${name}: files must stay inside the repository without symbolic links.`);
  const file = await open(filename, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const info = await file.stat(); assertFile(info.isFile(), info.size, name);
    const buffer = Buffer.alloc(HOMIE_PACK_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    assertFile(true, length, name);
    const result = decodeSourceFile(buffer.subarray(0, length), name);
    if (result.includes('\0')) throw new Error(`${name}: binary data is not supported.`);
    return result;
  } finally { await file.close(); }
}
export function portableAgent(agent: SpecialistAgent): AgentPackage {
  return parseAgentPackage({ ...(agent.package ?? { schemaVersion: 1, id: `homie.${agent.id}`, version: '1.0.0',
    description: `${agent.name} Homie`, requiredTools: ['codegraph', 'collaboration', 'verification'] }),
    name: agent.name, role: agent.role, instructionsFile: 'instructions.md', instructions: agent.instructions,
    model: { model: agent.model, reasoningEffort: agent.reasoningEffort, serviceTier: agent.serviceTier },
    requestedPermissions: agent.package?.requestedPermissions ?? agent.permissions });
}
export function sourceFiles(pack: AgentPackage): Record<string, string> {
  const { instructions, resources, ...manifest } = parseAgentPackage(pack);
  return { 'agent.json': JSON.stringify({ ...manifest, resources: { files: (resources?.files ?? []).map(f => f.path), programs: resources?.programs ?? [] } }, null, 2) + '\n',
    'instructions.md': instructions, ...Object.fromEntries((resources?.files ?? []).map(f => [f.path, f.content])) };
}
export function sourceDigest(pack: AgentPackage): string {
  // Normalize optional resources and key ordering across legacy and file manifests.
  const { resources, ...parsed } = parseAgentPackage(pack);
  const files = [...(resources?.files ?? [])].sort((a, b) => a.path.localeCompare(b.path));
  return createHash('sha256').update(JSON.stringify({ ...parsed, resources: { files, programs: resources?.programs ?? [] } })).digest('hex');
}
function parseManifest(text: string) {
  try { return JSON.parse(text); }
  catch (error) { throw new Error(`agent.json: ${error instanceof Error ? error.message : 'Invalid JSON.'}`); }
}
export async function readHomieSource(directory: string): Promise<{ pack: AgentPackage; hash: string; legacy: boolean }> {
  const root = await realpath(directory);
  const manifest = parseManifest(await readSourceFile(root, 'agent.json'));
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('agent.json: expected an object.');
  if (manifest.resources !== undefined && (!manifest.resources || typeof manifest.resources !== 'object' || Array.isArray(manifest.resources)
    || Object.keys(manifest.resources).some(key => key !== 'files' && key !== 'programs'))) throw new Error('agent.json: invalid resources.');
  const instructions = await readSourceFile(root, 'instructions.md');
  const assets: { path: string; content: string }[] = [];
  let bytes = 0, count = 0;
  async function walk(relative: string): Promise<void> {
    const filename = path.join(root, relative);
    let info;
    try { info = await lstat(filename); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${relative}: expected a directory without symbolic links.`);
    for (const entry of await readdir(filename, { withFileTypes: true })) {
      const name = `${relative}/${entry.name}`;
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) throw new Error(`${name}: hidden entries and symbolic links are not allowed.`);
      // Python may generate caches during local use; they are not portable source assets.
      if (entry.isDirectory() && entry.name === '__pycache__'
        || entry.isFile() && /\.(?:pyc|pyo)$/.test(entry.name)) continue;
      if (++count > 2048) throw new Error('Homie assets exceed 2048 entries.');
      if (entry.isDirectory()) await walk(name);
      else {
        const content = await readSourceFile(root, name);
        bytes += Buffer.byteLength(content);
        if (bytes > HOMIE_PACK_BYTES) throw new Error('Homie assets exceed 8 MiB.');
        assets.push({ path: name, content });
      }
    }
  }
  for (const name of roots) await walk(name);
  const entries = manifest.resources?.files ?? [];
  if (!Array.isArray(entries)) throw new Error('agent.json: resources.files must be an array.');
  const legacy = entries.some((entry: unknown) => typeof entry !== 'string');
  if (legacy) {
    for (const file of entries) {
      if (!file || typeof file !== 'object' || typeof file.path !== 'string' || typeof file.content !== 'string') throw new Error('agent.json: invalid legacy resources.files entry.');
      const actual = assets.find(a => a.path === file.path);
      if (actual && actual.content !== file.content) throw new Error(`${file.path}: embedded content conflicts with the file.`);
      if (!actual) assets.push(file);
    }
  } else {
    for (const name of entries) if (!assets.some(file => file.path === name)) throw new Error(`${String(name)}: declared asset is missing.`);
  }
  const pack = parseAgentPackage({ ...manifest, instructions, ...(manifest.resources !== undefined || assets.length
    ? { resources: { files: assets, programs: manifest.resources?.programs ?? [] } } : {}) });
  return { pack, hash: sourceDigest(pack), legacy };
}
