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

export function registerAgentRegistryIpc(options: {
  window: BrowserWindow; workspaceRoot: string; ipc: Pick<IpcMain, 'handle' | 'removeHandler'>;
  registry: Pick<ReturnType<typeof createAgentRegistry>, 'snapshot' | 'subscribe' | 'save'>;
  remove?: (request: import('../../shared/agent-registry.ts').DeleteSpecialistAgent) => Promise<import('../../shared/agent-registry.ts').AgentRegistrySnapshot>;
  runtime?: (request: AgentRuntimeRequest) => Promise<AgentRuntimeState>;
  models?: (accountId: string) => Promise<AgentModel[]>;
  selectInstructionFiles?: () => Promise<string[]>;
  openInstructionFile?: (path: string) => Promise<void>;
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
  const models = async (accountId: unknown) => {
    if (!isCodexAccountId(accountId)) throw new TypeError('Invalid agent account.');
    if (!options.models) throw new Error('Agent model catalog is unavailable.');
    return parseAgentModels(await options.models(accountId));
  };
  try {
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
