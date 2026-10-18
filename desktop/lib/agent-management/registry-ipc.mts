import type { HomiesAccess } from '../homies-activation.mts';
import { parseToolCredentialRequest, parseToolTestRequest, type ToolCredentialRequest, type ToolTestRequest } from '../../shared/homie-tools.ts';
import { parseHostToolRequest, type HostToolRequest, type HostToolStatus } from '../../shared/host-tools.ts';
import { createHash } from 'node:crypto';
import { agentRecord } from '../../shared/agent-management.ts';
import { installHomiePack, installedHomiePacks, writeHomiePack } from './homie-packs.mts';
import { parseAgentPackage } from '../../shared/agent-package.ts';
import { AGENT_RUNTIME_CHANNEL, parseAgentRuntimeRequest } from '../../shared/agent-runtime.ts';
import type { AgentRuntimeRequest, AgentRuntimeState } from '../../shared/agent-runtime.ts';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { AGENT_REGISTRY_CHANNELS, parseSaveSpecialistAgent, parseDeleteSpecialistAgent, type SaveSpecialistAgent } from '../../shared/agent-registry.ts';
import { onWindowClosed } from '../window-close-cleanup.mts';
import type { createAgentRegistry } from './registry.mts';
import { isCodexAccountId } from '../../shared/codex-accounts.ts';
import { assertAgentModelSelection, parseAgentModels, sameAgentModelSelection, resolveAgentModelSelection } from '../../shared/agent-models.ts';
import type { AgentModel } from '../../shared/agent-models.ts';
import { parseInstructionFiles, parseInstructionFilePath } from '../../shared/agent-registry.ts';
import { assertFileManagedInstructions, readInstructionFile } from './instruction-files.mts';
import { deletionReply } from './operations.mts';
import { officialAgentPackages, readAgentPackage } from './packages.mts';
import { HOMIE_SOURCE_CHANNEL, parseHomieSourceRequest, type HomieSourceRequest, type HomieSourceState } from '../../shared/homie-source.ts';

export function registerAgentRegistryIpc(options: {
  access?: HomiesAccess;
  source?(input: HomieSourceRequest): Promise<HomieSourceState>;
  saveSettings?(input: SaveSpecialistAgent, assertAvailable: () => void): Promise<ReturnType<ReturnType<typeof createAgentRegistry>['save']>>;
  window: BrowserWindow; workspaceRoot: string; ipc: Pick<IpcMain, 'handle' | 'removeHandler'>;
  registry: Pick<ReturnType<typeof createAgentRegistry>, 'snapshot' | 'subscribe' | 'save'>;
  remove?: (request: import('../../shared/agent-registry.ts').DeleteSpecialistAgent) => Promise<import('../../shared/agent-registry.ts').AgentRegistrySnapshot>;
  runtime?: (request: AgentRuntimeRequest) => Promise<AgentRuntimeState>;
  models?: (accountId: string) => Promise<AgentModel[]>;
  selectInstructionFiles?: () => Promise<string[]>;
  openInstructionFile?: (path: string) => Promise<void>;
  packsDirectory?: string;
  prepareCreation?(agent: import('../../shared/agent-registry.ts').SpecialistAgent): Promise<void>;
  toolCredential?(input: ToolCredentialRequest): Promise<boolean>;
  testTool?(input: ToolTestRequest): Promise<unknown>;
  hostTool?(input: HostToolRequest): Promise<HostToolStatus>;
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
    options.ipc.handle(channel, (event, value) => { assertOwner(event); return options.access && channel !== AGENT_REGISTRY_CHANNELS.list && channel !== AGENT_REGISTRY_CHANNELS.models
      ? options.access.run(() => action(value)) : action(value); });
    channels.push(channel);
  };
  handle(AGENT_REGISTRY_CHANNELS.toolCredential, value => {
    if (!options.toolCredential) throw new Error('Tool credentials are unavailable.');
    return options.toolCredential(parseToolCredentialRequest(value));
  });
  handle(AGENT_REGISTRY_CHANNELS.hostTool, value => {
    if (!options.hostTool) throw new Error('Host tools are unavailable.');
    return options.hostTool(parseHostToolRequest(value));
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
    if (options.source) handle(HOMIE_SOURCE_CHANNEL, value => options.source!(parseHomieSourceRequest(value)));
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
    if (options.runtime) handle(AGENT_RUNTIME_CHANNEL, async value => {
      const request = parseAgentRuntimeRequest(value);
      if (request.action === 'start' && options.prepareCreation) {
        const agent = options.registry.snapshot(options.workspaceRoot).agents.find(item => item.id === request.agentId);
        if (!agent) throw new Error('This Homie is no longer available.');
        await options.prepareCreation(agent);
        if (disposed || owner.isDestroyed()) throw new Error('Agent configuration window is closed.');
        owner.send(AGENT_REGISTRY_CHANNELS.repositoryReady);
      }
      return options.runtime!(request);
    });
    handle(AGENT_REGISTRY_CHANNELS.list, () => options.registry.snapshot(options.workspaceRoot));
    handle(AGENT_REGISTRY_CHANNELS.models, models);
    handle(AGENT_REGISTRY_CHANNELS.save, async value => {
      const input = parseSaveSpecialistAgent(value);
      assertFileManagedInstructions(input.profile, input.assignment);
      const existing = input.id ? options.registry.snapshot(options.workspaceRoot).agents.find(a => a.id === input.id) : undefined;
      if (existing) assertFileManagedInstructions(existing, existing.assignments.find(a => a.workspaceRoot === options.workspaceRoot));
      if (input.id && options.source) {
        const saved = options.registry.snapshot(options.workspaceRoot).agents.find(a => a.id === input.id);
        if (!saved) throw new Error('Homie is no longer registered.');
        // Only model controls may update portable fields through the file-backed save path.
        input.profile = { ...saved, displayName: input.profile.displayName ?? saved.displayName, accountId: input.profile.accountId, avatar: input.profile.avatar,
          permissions: input.profile.permissions, model: input.profile.model, reasoningEffort: input.profile.reasoningEffort, serviceTier: input.profile.serviceTier };
      }
      const catalog = input.profile.accountId === null ? [] : await models(input.profile.accountId);
      if (input.profile.accountId !== null) {
        const selection = resolveAgentModelSelection(input.profile, catalog);
        input.profile = { ...input.profile, ...selection,
          ...(input.profile.package ? { package: { ...input.profile.package, model: selection } } : {}) };
      }
      assertAgentModelSelection(input.profile, catalog);
      if (input.profile.accountId !== null && (input.profile.model === null || input.profile.reasoningEffort === null)) {
        throw new Error('Choose an available model and effort before saving.');
      }
      if (existing && options.source && !options.saveSettings && !sameAgentModelSelection(existing, input.profile)) {
        throw new Error('Restart Cheshi to edit Homie model settings.');
      }
      const assertAvailable = () => { if (disposed || owner.isDestroyed()) throw new Error('Agent configuration window is closed.'); };
      assertAvailable();
      const result = input.id && options.source && options.saveSettings
        ? await options.saveSettings(input, assertAvailable) : options.registry.save(input, options.workspaceRoot);
      if (input.id === null && options.prepareCreation) {
        const agent = result.snapshot.agents.find(item => item.id === result.agentId)!;
        try { await options.prepareCreation(agent); }
        catch (error) {
          return { ...result, repositoryError: (error instanceof Error ? error.message : 'Could not prepare the Homie repository.').slice(0, 2000) };
        }
        if (disposed || owner.isDestroyed()) throw new Error('Agent configuration window is closed.');
        owner.send(AGENT_REGISTRY_CHANNELS.repositoryReady);
      }
      return result;
    });
    unsubscribeClosed = onWindowClosed(options.window, dispose);
  } catch (error) { dispose(); throw error; }
  return { dispose };
}
