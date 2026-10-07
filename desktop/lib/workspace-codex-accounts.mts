import path from 'node:path';
import type { CodeGraphSynchronization } from './codegraph-synchronization.mts';
import { product } from '../../config/product.mts';
import { CodexAccountClients, type AccountClient } from './codex-account-clients.mts';
import { getCodexAccountProfiles } from './codex-account-profiles.mts';
import { registerCodexAccountsIpc } from './codex-accounts-ipc.mts';
import type { CodexChatContexts } from './codex-chat-contexts.mts';
import type { CodexChatService } from './codex-chat-service.mts';
import type { CodexChatSessionDeletion } from './codex-chat-session-deletion.mts';
import type { CodexChatRelays } from './codex-chat-relay.mts';
import type { CodexAccountService } from './codex-account-service.mts';
import { CodexConversationCatalog } from './codex-conversation-catalog.mts';
import { chooseCodexAccount } from './codex-account-availability.mts';
import type { CodexConversationAccess } from './codex-chat-account-continuity.mts';
import type { CodexChatClient } from './codex-chat-types.mts';
import { CodexConversationAgents } from './codex-conversation-agents.mts';
import { createWorkspaceCodeGraphMcp } from './workspace-codegraph-mcp.mts';
import type { WorkspaceAccountSelection } from './settings-service.mts';
import { createWorkspaceAccountStartup } from './workspace-account-startup.mts';

export function createWorkspaceCodexAccounts(options: {
  cwd: string; userDataDirectory: string; home: string; openExternal(url: string): Promise<unknown>;
  accountSelection?: WorkspaceAccountSelection;
  getProjectDocMaxBytes?(): number;
  codeGraph: { cli: { executable: string; args: string[] }; dataRoot: string; synchronization?: CodeGraphSynchronization };
}) {
  const defaultHome = process.env.CODEX_HOME?.trim() || path.join(options.home, '.codex');
  const codeGraphMcp = createWorkspaceCodeGraphMcp({
    cli: options.codeGraph.cli, dataRoot: options.codeGraph.dataRoot, workspaceRoot: options.cwd,
    synchronization: options.codeGraph.synchronization ? () => options.codeGraph.synchronization!.connection(options.cwd) : undefined,
  });
  const clients = new CodexAccountClients({ CODEX_HOME: defaultHome }, codeGraphMcp, options.getProjectDocMaxBytes);
  const profiles = getCodexAccountProfiles({
    directory: path.join(options.userDataDirectory, 'codex-accounts'),
    defaultHome, cwd: options.home, openExternal: options.openExternal,
  });
  let selection: ReturnType<typeof registerCodexAccountsIpc> | undefined;
  let startup: ReturnType<typeof createWorkspaceAccountStartup> | undefined;
  let loaded = new WeakMap<CodexChatClient, Set<string>>();
  const request = (id: string, method: string, params?: unknown) => profiles.historyRequest(id, method, params);
  const catalog = new CodexConversationCatalog({
    directory: path.join(options.userDataDirectory, 'codex-conversations'), cwd: options.cwd,
    profiles: () => profiles.historyHomes(), request,
  });
  const conversations: CodexConversationAccess = {
    agents: new CodexConversationAgents({ cwd: options.cwd, owner: id => catalog.owner(id), request,
      activeProfileId: () => selection?.activeId ?? 'default' }),
    list: () => catalog.list(),
    resolve: (id, client) => catalog.resolve(id, selection?.activeId ?? 'default', client, threadId => {
      const ids = loaded.get(client) ?? new Set<string>();
      ids.add(threadId);
      loaded.set(client, ids);
    }),
    takeLoaded: (id, client) => loaded.get(client)?.delete(id) === true,
    assertWritable: id => catalog.assertWritable(id),
    read: (id, method, params) => catalog.read(id, method, params),
    locations: id => catalog.locations(id), request,
    deletionProgress: id => catalog.deletionProgress(id),
    confirmDeletion: (id, deletion) => catalog.confirmDeletion(id, deletion),
    forget: id => catalog.forget(id),
  };
  const createClient = (voice = false) => clients.create({
    capabilities: { experimentalApi: true, ...(voice ? { explicitGatewayOauth: true } : {}) },
    command: { executable: process.env.CHESHI_CODEX?.trim() || 'codex', args: ['app-server', '--listen', 'stdio://'],
      environment: voice ? { OPENAI_API_KEY: undefined, CODEX_API_KEY: undefined } : {} },
    cwd: options.cwd,
    clientInfo: { name: product.internalName, title: product.displayName, version: product.version },
  });
  const register = (configuration: Pick<Parameters<typeof registerCodexAccountsIpc>[0], 'ipc' | 'assertSender' | 'emit'> & {
    retained: AccountClient[];
    service: CodexChatService;
    contexts: CodexChatContexts;
    deletion: CodexChatSessionDeletion;
    relays: Pick<CodexChatRelays, 'get'>;
    accountUsage: Pick<CodexAccountService, 'stop'>;
    temporaryBusy(): boolean;
    schedulerBusy?(): boolean;
    resetTemporary(): void;
    startup?: { signal: AbortSignal; onPhase(phase: string): void; onError(error: unknown): void };
  }) => {
    const startupOptions = configuration.startup;
    startup = startupOptions ? createWorkspaceAccountStartup({
      ipc: configuration.ipc, signal: startupOptions.signal, assertSender: configuration.assertSender,
      initialize: async () => {
        startupOptions.onPhase('account selection started');
        await selection!.initialize(startupOptions.onError);
        startupOptions.onPhase('account selection ready');
      },
    }) : undefined;
    selection = registerCodexAccountsIpc({
      ...configuration, ipc: startup?.ipc ?? configuration.ipc, clients, profiles, accountSelection: options.accountSelection,
      exclusive: operation => configuration.deletion.exclusive(operation),
      assertCanLogin: () => {
        const services = [configuration.service, ...configuration.contexts.allServices().map(entry => entry.service)];
        if (services.some(service => service.viewedThreadId !== null)) {
          throw new Error('Close the open conversations before signing in to the active account.');
        }
      },
      assertIdle: () => {
        if (configuration.schedulerBusy?.()) throw new Error('Wait for the scheduled task to finish before switching accounts.');
        if (configuration.temporaryBusy()) throw new Error('Close temporary chat and wait for code explanations before switching accounts.');
        const entries = configuration.contexts.allServices();
        for (const service of [configuration.service, ...entries.map(entry => entry.service)]) {
          if (service.viewedThreadIsSubagent) throw new Error('Open the main conversation before switching accounts.');
          if (service.activeTurns.size || service.pendingTurnStarts.size || service.pendingNewTurnClientMessageId) {
            throw new Error('Wait for all chat responses to finish before switching accounts.');
          }
        }
        for (const ownerId of new Set(entries.map(entry => entry.ownerId))) {
          const relay = configuration.relays.get(ownerId);
          if (relay?.status === 'running' || relay?.status === 'stopping') throw new Error('Stop the linked conversation before switching accounts.');
        }
      },
      reset: async (preserveConversation = false) => {
        loaded = new WeakMap();
        // Logout retires pane IDs; selection keeps their history and user choices.
        for (const { ownerId, contextId } of configuration.contexts.allServices()) {
          if (preserveConversation) await configuration.contexts.existing(ownerId, contextId)?.resetForAccount(true);
          else await configuration.contexts.dispose(ownerId, contextId);
        }
        await configuration.service.resetForAccount(preserveConversation);
        await configuration.accountUsage.stop();
        configuration.resetTemporary();
      },
    });
    return Object.assign(selection, { ipc: startup?.ipc ?? configuration.ipc, ready: startup?.ready ?? (async () => {}) });
  };
  const beforeMessage = async () => {
    if (!selection) throw new Error('Account selection is not ready.');
    await startup?.ready();
    const snapshot = { ...await profiles.list(), activeId: selection.activeId };
    const availability = chooseCodexAccount(snapshot);
    if (!availability.accountId) throw new Error(availability.message ?? 'No Codex account is available.');
    if (availability.accountId !== selection.activeId) await selection.select(availability.accountId);
    await options.codeGraph.synchronization?.ensure(options.cwd);
  };
  return { createClient: () => createClient(), createVoiceClient: () => createClient(true), register, conversations, beforeMessage, stop: () => clients.stop() };
}
