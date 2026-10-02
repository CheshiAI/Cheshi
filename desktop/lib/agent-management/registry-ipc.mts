import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { AGENT_REGISTRY_CHANNELS, parseSaveSpecialistAgent } from '../../shared/agent-registry.ts';
import { onWindowClosed } from '../window-close-cleanup.mts';
import type { createAgentRegistry } from './registry.mts';
import { isCodexAccountId } from '../../shared/codex-accounts.ts';
import { assertAgentModelSelection, parseAgentModels } from '../../shared/agent-models.ts';
import type { AgentModel } from '../../shared/agent-models.ts';

export function registerAgentRegistryIpc(options: {
  window: BrowserWindow; workspaceRoot: string; ipc: Pick<IpcMain, 'handle' | 'removeHandler'>;
  registry: ReturnType<typeof createAgentRegistry>;
  models?: (accountId: string) => Promise<AgentModel[]>;
}) {
  const owner = options.window.webContents, channels: string[] = [];
  let disposed = false;
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
