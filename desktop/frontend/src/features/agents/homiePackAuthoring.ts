import { parseHomiePackResources, HOMIE_PACK_BYTES, type HomiePackFile } from '../../../../shared/homie-pack';
import type { AgentPackage } from '../../../../shared/agent-package';
import type { SpecialistProfile, ExecutionPermissions } from '../../../../shared/agent-registry';

export function createHomiePack(profile: SpecialistProfile, permissions: ExecutionPermissions): AgentPackage {
  return { schemaVersion: 1, id: `homie.${crypto.randomUUID()}`, version: '1.0.0',
    name: profile.name || 'My Homie', description: `${profile.name || 'My Homie'} specialist pack.`, role: profile.role,
    instructionsFile: 'instructions.md', instructions: profile.instructions,
    model: { model: profile.model, reasoningEffort: profile.reasoningEffort, serviceTier: profile.serviceTier },
    requiredTools: ['codegraph', 'collaboration', 'verification'], requestedPermissions: { ...permissions }, resources: { files: [], programs: [] } };
}

export function createPackSkill(files: HomiePackFile[], name: string, description: string, instructions: string): HomiePackFile {
  if (!name.trim() || !description.trim() || !instructions.trim()) throw new Error('Enter a skill name, description and instructions.');
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64) || 'skill';
  let folder = slug, suffix = 2;
  while (files.some(file => file.path.toLowerCase().startsWith(`skills/${folder}/`))) folder = `${slug}-${suffix++}`;
  return { path: `skills/${folder}/SKILL.md`, content: `---\nname: ${JSON.stringify(name.trim())}\ndescription: ${JSON.stringify(description.trim())}\n---\n\n${instructions}\n` };
}

export interface SelectedPackFile {
  name: string; size: number; webkitRelativePath?: string; arrayBuffer(): Promise<ArrayBuffer>;
}
/** Read only user-selected files; validate the entire batch before publishing it. */
export async function readSelectedPackFiles(selected: SelectedPackFile[], target: 'scripts' | 'resources' | 'skills', existing: HomiePackFile[]) {
  let bytes = existing.reduce((total, file) => total + new TextEncoder().encode(file.content).length, 0);
  for (const file of selected) {
    bytes += file.size;
    if (bytes > HOMIE_PACK_BYTES) throw new Error('Pack text assets exceed 8 MiB.');
  }
  const additions: HomiePackFile[] = [];
  for (const file of selected) {
    const content = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(content)) throw new Error('Choose UTF-8 text files, scripts or Markdown. Binary files are not supported.');
    const relative = file.webkitRelativePath || file.name;
    additions.push({ path: `${target}/${relative}`, content });
  }
  return parseHomiePackResources({ files: [...existing, ...additions], programs: [] }).files;
}
