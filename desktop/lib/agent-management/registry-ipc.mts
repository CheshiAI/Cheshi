import { parseToolCredentialRequest, parseToolTestRequest, type ToolCredentialRequest, type ToolTestRequest } from '../../shared/homie-tools.ts';
import { createHash } from 'node:crypto';
import { agentRecord } from '../../shared/agent-management.ts';
import { installHomiePack, installedHomiePacks, writeHomiePack } from './homie-packs.mts';
import { parseAgentPackage } from '../../shared/agent-package.ts';
import { AGENT_RUNTIME_CHANNEL, parseAgentRuntimeRequest } from '../../shared/agent-runtime.ts';
import type { AgentRuntimeRequest, AgentRuntimeState } from '../../shared/agent-runtime.ts';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { AGENT_REGISTRY_CHANNELS, parseSaveSpecialistAgent, parseDeleteSpecialistAgent } from '../../shared/agent-registry.ts';
import { onWindowClosed } from '../window-close-cleanup.mts';
import type { createAgentRegistry } from './registry.mts';
import { isCodexAccountId } from '../../shared/codex-accounts.ts';
import { assertAgentModelSelection, parseAgentModels } from '../../shared/agent-models.ts';
import type { AgentModel } from '../../shared/agent-models.ts';
import { parseInstructionFiles, parseInstructionFilePath } from '../../shared/agent-registry.ts';
import { readInstructionFile } from './instruction-files.mts';
import { deletionReply } from './operations.mts';
import { officialAgentPackages, readAgentPackage } from './packages.mts';

export function registerAgentRegistryIpc(options: {
  window: BrowserWindow; workspaceRoot: string; ipc: Pick<IpcMain, 'handle' | 'removeHandler'>;
  registry: Pick<ReturnType<typeof createAgentRegistry>, 'snapshot' | 'subscribe' | 'save'>;
  remove?: (request: import('../../shared/agent-registry.ts').DeleteSpecialistAgent) => Promise<import('../../shared/agent-registry.ts').AgentRegistrySnapshot>;
  runtime?: (request: AgentRuntimeRequest) => Promise<AgentRuntimeState>;
  models?: (accountId: string) => Promise<AgentModel[]>;
  selectInstructionFiles?: () => Promise<string[]>;
  openInstructionFile?: (path: string) => Promise<void>;
  packsDirectory?: string;
  toolCredential?(input: ToolCredentialRequest): Promise<boolean>;
  testTool?(input: ToolTestRequest): Promise<unknown>;
  exportPackagePath?: (name: string) => Promise<string | null>;
  selectPackage?: () => Promise<string | null>;
}) {
  const owner = options.window.webContents, channels: string[] = [];
  let disposed = false;
  const selectedPaths = new Set<string>();
  const assertOwner = (event: IpcMainInvokeEvent) => {
    if (disposed || owner.isDestroyed() || event.sender !== owner || event.senderFrame !== owner.mainFrame) {
      throw new Error('Agent configuration is only available to its workspace window.');
    }
  };
  let unsubscribeClosed = () => {};
  const unsubscribe = options.registry.subscribe(() => {
    if (!disposed && !owner.isDestroyed()) owner.send(AGENT_REGISTRY_CHANNELS.changed, options.registry.snapshot(options.workspaceRoot));
  });
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    unsubscribeClosed(); unsubscribe();
    selectedPaths.clear();
    for (const channel of channels) options.ipc.removeHandler(channel);
  };
  const handle = (channel: string, action: (value: unknown) => unknown) => {
    options.ipc.handle(channel, (event, value) => { assertOwner(event); return action(value); });
    channels.push(channel);
  };
  handle(AGENT_REGISTRY_CHANNELS.toolCredential, value => {
    if (!options.toolCredential) throw new Error('Tool credentials are unavailable.');
    return options.toolCredential(parseToolCredentialRequest(value));
  });
  handle(AGENT_REGISTRY_CHANNELS.testTool, value => {
    if (!options.testTool) throw new Error('Tool execution is unavailable.');
    return options.testTool(parseToolTestRequest(value));
  });
  const models = async (accountId: unknown) => {
    if (!isCodexAccountId(accountId)) throw new TypeError('Invalid agent account.');
    if (!options.models) throw new Error('Agent model catalog is unavailable.');
    return parseAgentModels(await options.models(accountId));
  };
  const portablePack = async (value: unknown) => {
    const input = agentRecord(value), definition = parseAgentPackage(input.definition);
    const paths = parseInstructionFiles(input.instructionFiles ?? []);
    const common = new Set(options.registry.snapshot(options.workspaceRoot).agents.flatMap(agent => agent.instructionFiles ?? []));
    for (const path of paths) {
      if (!common.has(path) && !selectedPaths.has(path)) throw new Error('Select or link common instruction files before exporting them.');
    }
    const files = [...(definition.resources?.files ?? [])];
    const links: string[] = [];
    for (const path of paths) {
      const { content } = await readInstructionFile(path);
      const name = `resources/instructions/${createHash('sha256').update(content).digest('hex')}.md`;
      const index = files.findIndex(file => file.path === name);
      if (index >= 0) files[index] = { path: name, content }; else files.push({ path: name, content });
      links.push(`/opt/cheshi/homie-pack/${name}`);
    }
    if (disposed || owner.isDestroyed()) throw new Error('Agent configuration window is closed.');
    return paths.length ? parseAgentPackage({ ...definition,
      instructions: definition.instructions + '\n\nRead these common instruction files before work:\n' + [...new Set(links)].join('\n'),
      resources: { files, programs: definition.resources?.programs ?? [] } }) : definition;
  };
  try {
    handle(AGENT_REGISTRY_CHANNELS.packages, async () => {
      const packages = await officialAgentPackages();
      if (disposed || owner.isDestroyed()) throw new Error('Agent configuration window is closed.');
      const installed = options.packsDirectory ? await installedHomiePacks(options.packsDirectory) : [];
      return [...new Map([...packages, ...installed].map(pack => [`${pack.id}@${pack.version}`, pack])).values()];
    });
    if (options.packsDirectory) handle(AGENT_REGISTRY_CHANNELS.installPackage, async value => {
      const definition = await portablePack(value);
      return installHomiePack(options.packsDirectory!, definition);
    });
    if (options.exportPackagePath) handle(AGENT_REGISTRY_CHANNELS.exportPackage, async value => {
      const definition = await portablePack(value);
      const filename = await options.exportPackagePath!(`${definition.id}-${definition.version}.homiepack.json`);
      if (disposed || owner.isDestroyed()) throw new Error('Agent configuration window is closed.');
      if (filename === null) return false;
      await writeHomiePack(filename, definition);
      return true;
    });
    if (options.selectPackage) handle(AGENT_REGISTRY_CHANNELS.importPackage, async () => {
      const filename = await options.selectPackage!();
      if (disposed || owner.isDestroyed()) throw new Error('Agent configuration window is closed.');
      const definition = filename === null ? null : await readAgentPackage(filename);
      if (disposed || owner.isDestroyed()) throw new Error('Agent configuration window is closed.');
      return definition;
    });
    if (options.selectInstructionFiles) handle(AGENT_REGISTRY_CHANNELS.selectInstructionFiles, async () => {
      const paths = parseInstructionFiles(await options.selectInstructionFiles!());
      if (disposed || owner.isDestroyed()) throw new Error('Agent configuration window is closed.');
      for (const path of paths) selectedPaths.add(path);
      return paths;
    });
    if (options.openInstructionFile) handle(AGENT_REGISTRY_CHANNELS.openInstructionFile, async value => {
      const path = parseInstructionFilePath(value);
      const linked = options.registry.snapshot(options.workspaceRoot).agents.some(agent =>
        agent.instructionFiles?.includes(path) || agent.assignments.some(assignment =>
          assignment.workspaceRoot === options.workspaceRoot && assignment.instructionFiles?.includes(path)));
      if (!linked && !selectedPaths.has(path)) throw new Error('Select or link this instruction file before opening it.');
      await readInstructionFile(path);
      if (disposed || owner.isDestroyed()) throw new Error('Agent configuration window is closed.');
      await options.openInstructionFile!(path);
    });
    if (options.remove) handle(AGENT_REGISTRY_CHANNELS.remove, value => {
      const input = parseDeleteSpecialistAgent(value);
      return deletionReply(() => options.remove!(input));
    });
    if (options.runtime) handle(AGENT_RUNTIME_CHANNEL, value => options.runtime!(parseAgentRuntimeRequest(value)));
    handle(AGENT_REGISTRY_CHANNELS.list, () => options.registry.snapshot(options.workspaceRoot));
    handle(AGENT_REGISTRY_CHANNELS.models, models);
    handle(AGENT_REGISTRY_CHANNELS.save, async value => {
      const input = parseSaveSpecialistAgent(value);
      const catalog = input.profile.model === null ? [] : await models(input.profile.accountId);
      assertAgentModelSelection(input.profile, catalog);
      if (disposed || owner.isDestroyed()) throw new Error('Agent configuration window is closed.');
      return options.registry.save(input, options.workspaceRoot);
    });
    unsubscribeClosed = onWindowClosed(options.window, dispose);
  } catch (error) { dispose(); throw error; }
  return { dispose };
}
