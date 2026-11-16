import { parseHomieRepositoryDestination, parseHomieRepositoryLocationRequest, parseHomieRepositoryDirectory, type HomieRepositoryPreview, type HomieRepositoryLocationRequest } from '../../shared/homie-repository-connection.ts';
import type { HomiesAccess } from '../homies-activation.mts';
import { parseToolCredentialRequest, parseToolTestRequest, type ToolCredentialRequest, type ToolTestRequest } from '../../shared/homie-tools.ts';
import { parseHostToolRequest, type HostToolRequest, type HostToolStatus } from '../../shared/host-tools.ts';
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
import { HOMIE_SOURCE_CHANNEL, parseHomieSourceRequest, type HomieSourceRequest, type HomieSourceState } from '../../shared/homie-source.ts';

export function registerAgentRegistryIpc(options: {
  access?: HomiesAccess;
  previewRepository?(repository: string, directory?: string): Promise<HomieRepositoryPreview>;
  repositoryLocation?(input: HomieRepositoryLocationRequest): Promise<string | null>;
  connectRepository?(input: SaveSpecialistAgent, assertAvailable: () => void): Promise<ReturnType<ReturnType<typeof createAgentRegistry>['save']>>;
  source?(input: HomieSourceRequest): Promise<HomieSourceState>;
  saveSettings?(input: SaveSpecialistAgent, assertAvailable: () => void): Promise<ReturnType<ReturnType<typeof createAgentRegistry>['save']>>;
  window: BrowserWindow; workspaceRoot: string; ipc: Pick<IpcMain, 'handle' | 'removeHandler'>;
  registry: Pick<ReturnType<typeof createAgentRegistry>, 'snapshot' | 'subscribe' | 'save'>;
  remove?: (request: import('../../shared/agent-registry.ts').DeleteSpecialistAgent) => Promise<import('../../shared/agent-registry.ts').AgentRegistrySnapshot>;
  runtime?: (request: AgentRuntimeRequest) => Promise<AgentRuntimeState>;
  models?: (accountId: string) => Promise<AgentModel[]>;
  selectInstructionFiles?: () => Promise<string[]>;
  openInstructionFile?: (path: string) => Promise<void>;
  prepareCreation?(agent: import('../../shared/agent-registry.ts').SpecialistAgent): Promise<void>;
  toolCredential?(input: ToolCredentialRequest): Promise<boolean>;
  testTool?(input: ToolTestRequest): Promise<unknown>;
  hostTool?(input: HostToolRequest): Promise<HostToolStatus>;
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
  try {
    if (options.source) handle(HOMIE_SOURCE_CHANNEL, value => options.source!(parseHomieSourceRequest(value)));
    if (options.repositoryLocation) handle(AGENT_REGISTRY_CHANNELS.repositoryLocation, async value => {
      const result = await options.repositoryLocation!(parseHomieRepositoryLocationRequest(value));
      if (disposed || owner.isDestroyed()) throw new Error('Agent configuration window is closed.');
      return result === null ? null : parseHomieRepositoryDirectory(result);
    });
    if (options.previewRepository) handle(AGENT_REGISTRY_CHANNELS.previewRepository, async value => {
      const input = parseHomieRepositoryDestination(value);
      const result = await options.previewRepository!(input.repository, input.directory);
      if (disposed || owner.isDestroyed()) throw new Error('Agent configuration window is closed.');
      return result;
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
      if (input.profile.accountId !== null && !input.repository) {
        const selection = resolveAgentModelSelection(input.profile, catalog);
        input.profile = { ...input.profile, ...selection,
          ...(input.profile.package ? { package: { ...input.profile.package, model: selection } } : {}) };
      }
      if (!input.repository || input.profile.accountId !== null) assertAgentModelSelection(input.profile, catalog);
      if (input.profile.accountId !== null && (input.profile.model === null || input.profile.reasoningEffort === null)) {
        throw new Error('Choose an available model and effort before saving.');
      }
      if (existing && options.source && !options.saveSettings && !sameAgentModelSelection(existing, input.profile)) {
        throw new Error('Restart Cheshi to edit Homie model settings.');
      }
      const assertAvailable = () => { if (disposed || owner.isDestroyed()) throw new Error('Agent configuration window is closed.'); };
      assertAvailable();
      if (input.repository && !options.connectRepository) throw new Error('Repository connection is unavailable. Restart Cheshi.');
      const result = input.repository ? await options.connectRepository!(input, assertAvailable) : input.id && options.source && options.saveSettings
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
