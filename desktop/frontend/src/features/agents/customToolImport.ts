import { parseAgentPackage, type AgentPackage } from '../../../../shared/agent-package';
import { HOMIE_PACK_BYTES, parseHomiePackResources } from '../../../../shared/homie-pack';
import { parseCustomTools } from '../../../../../experiments/codex-specialists/src/custom-tool-contract';
export type HomieCustomTool = NonNullable<AgentPackage['tools']>[number];
/** A standalone tool bundle or a folder containing tool.json and relative script files. */
export async function importHomieTool(files: File[], pack: AgentPackage): Promise<Pick<AgentPackage, 'tools' | 'resources'>> {
  if (!files.length || files.reduce((sum, file) => sum + file.size, 0) > HOMIE_PACK_BYTES) throw new Error('Choose a tool smaller than 8 MiB.');
  const folder = Boolean(files[0]!.webkitRelativePath);
  const root = folder ? files[0]!.webkitRelativePath.split('/')[0] + '/' : '';
  const paths = files.map(file => ({ file, path: folder ? file.webkitRelativePath.slice(root.length) : file.name }));
  if (folder && files.some(file => !file.webkitRelativePath.startsWith(root))) throw new Error('Choose one tool folder.');
  const manifest = folder ? paths.find(file => file.path === 'tool.json') : files.length === 1 ? paths[0] : undefined;
  if (!manifest) throw new Error('The tool folder needs tool.json at its root.');
  const value: unknown = JSON.parse(await manifest.file.text());
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid tool manifest.');
  const data = value as Record<string, unknown>;
  const keys = folder ? ['schemaVersion', 'tool', 'programs'] : ['schemaVersion', 'tool', 'resources'];
  if (data.schemaVersion !== 1 || Object.keys(data).some(key => !keys.includes(key))) throw new Error('Unsupported tool manifest.');
  const [tool] = parseCustomTools([data.tool]);
  const resources = parseHomiePackResources(folder ? { programs: data.programs ?? [], files: await Promise.all(paths.filter(file => file !== manifest).map(async ({ file, path }) => ({ path, content: await file.text() }))) } : data.resources);
  const merged = parseAgentPackage({ ...pack, tools: [...pack.tools ?? [], tool], resources: {
    programs: [...pack.resources?.programs ?? [], ...resources.programs], files: [...pack.resources?.files ?? [], ...resources.files],
  } });
  return { tools: merged.tools, resources: merged.resources };
}
