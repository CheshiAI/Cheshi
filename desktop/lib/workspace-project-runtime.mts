import type { IpcMain, IpcMainInvokeEvent, Clipboard, Shell } from 'electron';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { codeGraphStorageDirectory } from '../../config/workspace-storage.mts';
import type { WorkspaceProject } from '../shared/workspace-projects.ts';
import { WorkspaceProjectStore } from './workspace-project-store.mts';
import { mapProjectPaths, projectForPath, qualifiedProjectPath, relativeProjectPath } from './workspace-project-paths.mts';
import { registerWorkspaceFileIpcHandlers } from './workspace-file-ipc.mts';
import { registerGitIpcHandlers } from './git-ipc.mts';
import { registerLocalHistoryIpc } from './local-history-ipc.mts';
import { registerLanguageServerIpcHandlers } from './language-server-ipc.mts';
import { LanguageServerManager } from './language-server-manager.mts';
import { GitService } from './git-service.mts';
import { acquireLocalHistory } from './local-history-runtime.mts';
import { watchWorkspaceFiles } from './workspace-file-service.mts';

type Handler = Parameters<IpcMain['handle']>[1];
type LanguageOptions = ConstructorParameters<typeof LanguageServerManager>[0];
const pathChannels = new Set([
  'list-workspace-directory', 'read-workspace-file', 'read-workspace-file-excerpt', 'get-workspace-file-version',
  'write-workspace-file', 'write-workspace-files', 'create-workspace-entry', 'rename-workspace-entry',
  'move-workspace-entry', 'copy-workspace-entry-full-path', 'delete-workspace-entry',
  'list-local-history', 'read-local-history', 'restore-local-history', 'get-git-line-blame', 'get-git-line-commit',
  'update-language-server-document', 'get-language-server-completions', 'get-language-server-hover',
  'get-language-server-definitions', 'get-language-server-references', 'get-language-server-signature-help',
  'prepare-language-server-rename', 'rename-language-server-symbol', 'get-language-server-code-actions',
  'close-language-server-document',
].map(name => `cheshi:${name}`));
const rawPathChannels = new Set(['list-workspace-directory', 'read-workspace-file', 'get-workspace-file-version',
  'copy-workspace-entry-full-path', 'delete-workspace-entry', 'list-local-history', 'read-local-history'].map(name => `cheshi:${name}`));

interface Options {
  ipc: Pick<IpcMain, 'handle'>;
  root: string;
  dataRoot: string;
  clipboard: Pick<Clipboard, 'writeText'>;
  shell: Pick<Shell, 'trashItem' | 'openExternal'>;
  languageOptions: Omit<LanguageOptions, 'workspaceRoot'>;
  assertSender(event: IpcMainInvokeEvent): void;
  assertIdle(): void;
  chooseDirectory(event: IpcMainInvokeEvent): Promise<string | null>;
  emit(channel: string, value?: unknown): void;
}

interface Services { handlers: Map<string, Handler>; dispose(): Promise<void>; }

/** Dispatches only registered project services, never arbitrary IPC channels or paths. */
export function createWorkspaceProjects(options: Options) {
  const store = new WorkspaceProjectStore(options.dataRoot, options.root);
  const primaryHandlers = new Map<string, Handler>();
  const services = new Map<string, Services>();
  const pendingDisposals = new Set<Promise<void>>();
  let closed = false;
  const emit = (channel: string, value?: unknown) => { if (!closed) options.emit(channel, value); };
  const report = (error: unknown) => process.stderr.write(`[cheshi] Project service: ${String(error)}\n`);

  function connect(project: WorkspaceProject): Services {
    const existing = services.get(project.id);
    if (existing) return existing;
    const handlers = new Map<string, Handler>();
    const ipc: Pick<IpcMain, 'handle'> = { handle: (channel, handler) => { handlers.set(channel, handler); } };
    const history = acquireLocalHistory({ workspaceRoot: project.rootPath,
      directory: path.join(path.dirname(codeGraphStorageDirectory(options.dataRoot, project.rootPath)), 'local-history'), onError: report });
    const git = new GitService({ workspaceRoot: project.rootPath });
    const language = new LanguageServerManager({ ...options.languageOptions, workspaceRoot: project.rootPath });
    const qualify = (value: unknown) => mapProjectPaths(value, file => qualifiedProjectPath(project, file));
    const changed: Parameters<typeof watchWorkspaceFiles>[1] = event => {
      void history.captureChanged(event).catch(report);
      emit('cheshi:workspace-files-changed', qualify(event));
    };
    registerWorkspaceFileIpcHandlers({ ipcMain: ipc, workspaceRoot: project.rootPath,
      clipboard: options.clipboard, shell: options.shell, localHistory: history });
    registerLocalHistoryIpc({ ipcMain: ipc, service: history, assertSender: options.assertSender, onChanged: changed });
    registerGitIpcHandlers({ ipcMain: ipc, gitService: git, assertCheshiSender: options.assertSender, shell: options.shell });
    registerLanguageServerIpcHandlers({ ipcMain: ipc, languageServerManager: language, assertCheshiSender: options.assertSender,
      selectLanguageServerExecutable: async () => { throw new Error('Configure language servers in Settings.'); } });
    const unsubscribe = language.onDiagnostics(value => emit('cheshi:language-server-diagnostics', qualify(value)));
    const watchers = Promise.allSettled([
      watchWorkspaceFiles(project.rootPath, changed, { onError: report }),
      git.watchRepository(() => emit('cheshi:git-repository-changed'), { onError: report }),
    ]);
    const entry: Services = { handlers, async dispose() {
      unsubscribe();
      for (const result of await watchers) { if (result.status === 'fulfilled') result.value(); else report(result.reason); }
      await Promise.all([language.stop(), history.dispose()]);
    } };
    services.set(project.id, entry);
    return entry;
  }

  async function handlerFor(project: WorkspaceProject, channel: string): Promise<Handler> {
    if (closed) throw new Error('The workspace has closed.');
    store.get(project.id);
    if (await realpath(project.rootPath) !== project.rootPath) throw new Error('The project folder changed. Reconnect it.');
    store.get(project.id);
    const handler = (project.primary ? primaryHandlers : connect(project).handlers).get(channel);
    if (!handler) throw new Error('This operation is unavailable for the project.');
    return handler;
  }

  const unsubscribe = store.subscribe(() => {
    const ids = new Set(store.list().map(project => project.id));
    for (const [id, service] of services) if (!ids.has(id)) {
      services.delete(id);
      const pending = service.dispose();
      pendingDisposals.add(pending);
      void pending.catch(report).finally(() => pendingDisposals.delete(pending));
    }
    emit('cheshi:workspace-projects-changed');
  });

  const ipc: Pick<IpcMain, 'handle'> = { handle(channel, handler) {
    primaryHandlers.set(channel, handler);
    options.ipc.handle(channel, async (event, ...args: unknown[]) => {
      options.assertSender(event);
      if (channel === 'cheshi:search-workspace-files') {
        const results = await Promise.all(store.list().filter(project => project.available).map(async project => {
          const run = await handlerFor(project, channel);
          return mapProjectPaths(await run(event, ...args), file => qualifiedProjectPath(project, file)) as
            { files: { path: string; name: string }[]; truncated: boolean };
        }));
        const files = results.flatMap(result => result.files);
        return { files: files.slice(0, 100), truncated: files.length > 100 || results.some(result => result.truncated) };
      }
      if (!pathChannels.has(channel)) return handler(event, ...args);
      const paths: string[] = [];
      if (rawPathChannels.has(channel)) {
        const file = args[0] ?? (channel === 'cheshi:list-workspace-directory' ? '.' : undefined);
        if (typeof file !== 'string') throw new TypeError('Workspace paths must be strings.');
        paths.push(file);
      }
      else mapProjectPaths(args, file => { paths.push(file); return file; });
      const project = projectForPath(store.list(), paths[0] ?? '.');
      if (channel === 'cheshi:write-workspace-files' && paths.some(file => projectForPath(store.list(), file).id !== project.id)) {
        throw new Error('Save changes separately for each project.');
      }
      const translate = (file: string) => relativeProjectPath(project, file);
      const translated = rawPathChannels.has(channel) ? [translate(paths[0]!), ...args.slice(1)]
        : mapProjectPaths(args, translate) as unknown[];
      const run = await handlerFor(project, channel);
      const result: unknown = await run(event, ...translated);
      return mapProjectPaths(result, file => qualifiedProjectPath(project, file));
    });
  } };

  const handle = (name: string, run: Handler) => options.ipc.handle(`cheshi:workspace-projects:${name}`, (event, ...args) => {
    options.assertSender(event);
    if (closed) throw new Error('The workspace has closed.');
    return run(event, ...args);
  });
  handle('list', () => store.list());
  handle('add', async event => {
    options.assertIdle();
    const selected = await options.chooseDirectory(event);
    if (!selected) return null;
    options.assertIdle();
    return store.add(selected, options.assertIdle);
  });
  handle('remove', (_event, id: unknown) => { options.assertIdle(); return store.remove(id); });
  handle('invoke', async (event, id: unknown, channel: unknown, args: unknown) => {
    if (typeof channel !== 'string' || !Array.isArray(args) || args.length > 4
      || !/^cheshi:(?:[a-z-]+-git(?:hub)?-|list-github-|read-github-|open-github-)/u.test(channel)) {
      throw new Error('Invalid project Git operation.');
    }
    const project = store.get(id);
    return (await handlerFor(project, channel))(event, ...args);
  });

  return { store, ipc, async dispose() {
    closed = true;
    unsubscribe();
    await Promise.all([...services.values()].map(service => service.dispose()).concat([...pendingDisposals]));
    services.clear();
  } };
}
