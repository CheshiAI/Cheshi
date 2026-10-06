import { parseCustomTools, type CustomTool } from '../../experiments/codex-specialists/src/custom-tool-contract.ts';
import { parseHomiePackResources, type HomiePackResources } from './homie-pack.ts';
import { SPECIALIST_ROLES } from './agent-registry.ts';
import type { ExecutionPermissions, SpecialistProfile, SpecialistRole } from './agent-registry.ts';
import type { AgentModelSelection } from './agent-models.ts';

export const AGENT_PACKAGE_TOOLS = ['codegraph', 'collaboration', 'verification'] as const;
export type AgentPackageTool = typeof AGENT_PACKAGE_TOOLS[number];
export interface AgentPackageManifest {
  tools?: CustomTool[];
  enabledTools?: AgentPackageTool[];
  resources?: HomiePackResources;
  schemaVersion: 1;
  id: string;
  version: string;
  name: string;
  description: string;
  role: SpecialistRole;
  instructionsFile: 'instructions.md';
  model: AgentModelSelection;
  requiredTools: AgentPackageTool[];
  requestedPermissions: ExecutionPermissions;
}
/** A portable, self-contained snapshot. No account, paths, credentials, or sessions. */
export interface AgentPackage extends AgentPackageManifest { instructions: string }

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid agent package.');
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some(key => !keys.includes(key))) throw new TypeError('Unsupported agent package field.');
  return data;
}
function text(value: unknown, limit: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || value.includes('\0')) {
    throw new TypeError('Invalid agent package text.');
  }
  return value;
}
const MANIFEST_KEYS = ['tools', 'schemaVersion', 'id', 'version', 'name', 'description', 'role', 'instructionsFile', 'model', 'requiredTools', 'requestedPermissions', 'resources', 'enabledTools'];
export function parseAgentPackageManifest(value: unknown): AgentPackageManifest {
  const data = object(value, MANIFEST_KEYS);
  if (data.schemaVersion !== 1) throw new TypeError('Unsupported agent package schema version.');
  const id = text(data.id, 100), version = text(data.version, 50);
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(id)) throw new TypeError('Invalid agent package ID.');
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new TypeError('Use a package version such as 1.0.0.');
  if (!SPECIALIST_ROLES.some(role => role === data.role)) throw new TypeError('Invalid agent package role.');
  if (data.instructionsFile !== 'instructions.md') throw new TypeError('The package must contain instructions.md next to agent.json.');
  const model = object(data.model, ['model', 'reasoningEffort', 'serviceTier']);
  const selection = { model: model.model === null ? null : text(model.model, 200),
    reasoningEffort: model.reasoningEffort === null ? null : text(model.reasoningEffort, 100),
    serviceTier: model.serviceTier === null ? null : text(model.serviceTier, 100) };
  if (selection.model === null && (selection.reasoningEffort !== null || selection.serviceTier !== null)) {
    throw new TypeError('Package reasoning and service tier require a model.');
  }
  const permissions = object(data.requestedPermissions, ['fileWrite', 'commandExecution']);
  if ([permissions.fileWrite, permissions.commandExecution].some(flag => flag !== true && flag !== false)) {
    throw new TypeError('Invalid package permissions.');
  }
  if (!Array.isArray(data.requiredTools) || data.requiredTools.length > AGENT_PACKAGE_TOOLS.length
    || data.requiredTools.some(tool => !AGENT_PACKAGE_TOOLS.includes(tool))) throw new TypeError('This package requires unsupported tools.');
  const enabledTools = data.enabledTools;
  if (enabledTools !== undefined && (!Array.isArray(enabledTools) || enabledTools.some(tool => !AGENT_PACKAGE_TOOLS.includes(tool))
    || data.requiredTools.some(tool => !enabledTools.includes(tool)))) throw new TypeError('Required tools must be enabled.');
  return { ...(data.tools === undefined ? {} : { tools: parseCustomTools(data.tools) }), ...(enabledTools === undefined ? {} : { enabledTools: [...new Set(enabledTools as AgentPackageTool[])] }), ...(data.resources === undefined ? {} : { resources: parseHomiePackResources(data.resources) }), schemaVersion: 1, id, version, name: text(data.name, 100).trim(), description: text(data.description, 2000),
    role: data.role as SpecialistRole, instructionsFile: 'instructions.md', model: selection,
    requiredTools: [...new Set(data.requiredTools)] as AgentPackageTool[],
    requestedPermissions: { fileWrite: permissions.fileWrite === true, commandExecution: permissions.commandExecution === true } };
}
export function parseAgentPackage(value: unknown): AgentPackage {
  const data = object(value, [...MANIFEST_KEYS, 'instructions']);
  const { instructions, ...manifest } = data;
  const parsed = parseAgentPackageManifest(manifest);
  for (const tool of parsed.tools ?? []) {
    if (!parsed.resources?.files.some(file => file.path === tool.script)) throw new Error(`Missing script for tool: ${tool.name}`);
    if (tool.runtime === 'python3' && !parsed.resources.programs.some(p => p.split('=')[0] === 'python3')) throw new Error('Python tools require python3 in Programs.');
  }
  return { ...parsed, instructions: text(instructions, 20_000) };
}
export function parseAgentPackages(value: unknown): AgentPackage[] {
  if (!Array.isArray(value) || value.length > 100) throw new TypeError('Invalid agent package list.');
  return value.map(parseAgentPackage);
}
export function applyAgentPackage(profile: SpecialistProfile, value: AgentPackage, existing: boolean, keepInstructions: boolean): SpecialistProfile {
  const definition = parseAgentPackage(value);
  if (profile.package && profile.package.id !== definition.id) throw new Error('Package updates must keep the same package ID.');
  return { ...profile, package: definition,
    ...(existing ? {} : { name: definition.name, role: definition.role, ...definition.model }),
    instructions: keepInstructions ? profile.instructions : definition.instructions };
}
