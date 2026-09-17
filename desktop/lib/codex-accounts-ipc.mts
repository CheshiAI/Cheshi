import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import type { CodexAccountsSnapshot } from '../shared/codex-accounts.ts';
import type { CodexAccountProfiles } from './codex-account-profiles.mts';
import type { AccountClient, CodexAccountClients } from './codex-account-clients.mts';
import { chooseCodexAccount } from './codex-account-availability.mts';

interface Options {
  ipc: Pick<IpcMain, 'handle'>;
  profiles: CodexAccountProfiles;
  clients: CodexAccountClients;
  retained: AccountClient[];
  assertSender(event: IpcMainInvokeEvent): void;
  assertIdle(): void;
  assertCanLogin?(): void;
  exclusive<T>(operation: () => Promise<T>): Promise<T>;
  reset(preserveConversation?: boolean): Promise<void>;
  emit(snapshot: CodexAccountsSnapshot): void;
}

interface SharedWorkspaceAccounts {
  workspaces: Map<symbol, Set<string>>;
  loggingOut: Set<string>;
}
const workspaceAccounts = new WeakMap<CodexAccountProfiles, SharedWorkspaceAccounts>();

function sharedAccounts(profiles: CodexAccountProfiles): SharedWorkspaceAccounts {
  let state = workspaceAccounts.get(profiles);
  if (!state) {
    state = { workspaces: new Map(), loggingOut: new Set() };
    workspaceAccounts.set(profiles, state);
  }
  return state;
}

/** Account selection belongs to this workspace; registrations are shared across windows. */
export function registerCodexAccountsIpc(options: Options) {
  let activeId = 'default';
  let selecting = false;
  let closed = false;
  const shared = sharedAccounts(options.profiles);
  if (shared.loggingOut.has(activeId)) throw new Error('The default account is being logged out. Please reopen this workspace afterward.');
  const workspace = Symbol('workspace account selection');
  shared.workspaces.set(workspace, new Set([activeId]));
  const selected = (snapshot: CodexAccountsSnapshot): CodexAccountsSnapshot => ({ ...snapshot, activeId });
  const unsubscribe = options.profiles.onDidChange(snapshot => {
    if (!closed) options.emit(selected(snapshot));
  });
  const assertOpen = () => {
    if (closed) throw new Error('The workspace has closed.');
  };
  const handle = (channel: string, operation: (id: unknown) => Promise<CodexAccountsSnapshot>) => {
    options.ipc.handle(channel, (event, id: unknown) => {
      options.assertSender(event);
      assertOpen();
      return operation(id);
    });
  };
  const idValue = (value: unknown): string => {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new TypeError('Invalid account profile id.');
    return value;
  };
  const assertNotLoggingOut = (id: string) => {
    if (shared.loggingOut.has(id)) throw new Error('This account is being logged out. Please wait.');
  };
  handle('cheshi:codex-accounts-list', async () => selected(await options.profiles.list()));
  handle('cheshi:codex-accounts-add', async () => selected(await options.profiles.add()));
  handle('cheshi:codex-accounts-login', async value => {
    const id = idValue(value);
    assertNotLoggingOut(id);
    const login = async () => selected(await options.profiles.login(id));
    if (id !== activeId) return login();
    return options.exclusive(async () => {
      assertOpen();
      options.assertIdle();
      options.assertCanLogin?.();
      return login();
    });
  });
  handle('cheshi:codex-accounts-cancel-login', async id => selected(await options.profiles.cancelLogin(idValue(id))));
  handle('cheshi:codex-accounts-cancel-registration', async value => {
    const id = idValue(value);
    if (selecting || id === activeId) throw new Error('The active or switching account cannot be removed.');
    return selected(await options.profiles.cancelRegistration(id));
  });
  handle('cheshi:codex-accounts-logout', async value => {
    if (selecting) throw new Error('An account switch is already in progress.');
    const id = idValue(value);
    assertNotLoggingOut(id);
    for (const [owner, accounts] of shared.workspaces) {
      if (owner !== workspace && accounts.has(id)) {
        throw new Error('This account is in use in another workspace. Switch or close that workspace before logging out.');
      }
    }
    selecting = true;
    shared.loggingOut.add(id);
    try {
      if (id !== activeId) return selected(await options.profiles.logout(id));
      const environment = await options.profiles.environment(id);
      assertOpen();
      let snapshot: CodexAccountsSnapshot | undefined;
      await options.exclusive(async () => {
        assertOpen();
        options.assertIdle();
        await options.clients.change(environment, options.retained, async () => {
          assertOpen();
          snapshot = await options.profiles.logout(id);
          await options.reset();
        });
      });
      assertOpen();
      const result = selected(snapshot!);
      options.emit(result);
      return result;
    } finally {
      shared.loggingOut.delete(id);
      selecting = false;
    }
  });
  const select = async (value: unknown): Promise<CodexAccountsSnapshot> => {
    assertOpen();
    if (selecting) throw new Error('An account switch is already in progress.');
    const id = idValue(value);
    assertNotLoggingOut(id);
    selecting = true;
    // Reserve synchronously so another window cannot log out the target during lookup.
    shared.workspaces.get(workspace)!.add(id);
    try {
      const snapshot = await options.profiles.list();
      assertOpen();
      const target = snapshot.profiles.find(profile => profile.id === id);
      if (!target) throw new Error('Account profile not found.');
      if (!target.usage.authenticated || target.usage.state !== 'ready') throw new Error('Sign in to this account before selecting it.');
      if (id === activeId) return selected(snapshot);
      const environment = await options.profiles.environment(id);
      assertOpen();
      await options.exclusive(async () => {
        assertOpen();
        options.assertIdle();
        const retained = [...new Set([...options.retained, ...options.clients.clients])];
        await options.clients.change(environment, retained, () => options.reset(true));
        assertOpen();
        activeId = id;
      });
      const result = selected(snapshot);
      options.emit(result);
      return result;
    } finally {
      if (!closed) shared.workspaces.set(workspace, new Set([activeId]));
      selecting = false;
    }
  };
  handle('cheshi:codex-accounts-select', select);
  return {
    select,
    /** Resolve selection before renderer requests start; usage failures must not prevent opening the workspace. */
    async initialize(onError: (error: unknown) => void): Promise<CodexAccountsSnapshot | null> {
      try {
        assertOpen();
        const snapshot = selected(await options.profiles.list());
        assertOpen();
        const choice = chooseCodexAccount(snapshot);
        if (choice.accountId !== null && choice.accountId !== activeId) return await select(choice.accountId);
        // Publish even when no switch is possible, before the renderer starts requesting accounts.
        options.emit(snapshot);
        return snapshot;
      } catch (error) {
        onError(error);
        return null;
      }
    },
    get activeId(): string { return activeId; },
    async stop(): Promise<void> {
      closed = true;
      unsubscribe();
      // Keep the selection reserved until its transports can no longer use credentials.
      await options.clients.stop();
      shared.workspaces.delete(workspace);
      await options.profiles.release();
    },
  };
}
