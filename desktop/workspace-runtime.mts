import { createWorkspaceWindowReadiness } from './lib/workspace-window-readiness.mts';
import { createWorkspaceRendererEvents } from './lib/workspace-renderer-events.mts';
import { TemporaryChatService } from './lib/temporary-chat-service.mts';
import { registerTemporaryChatIpc } from './lib/temporary-chat-ipc.mts';
import { createWorkspaceCodeExplanation } from './lib/workspace-code-explanation.mts';
import path from 'node:path';
import { userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { registerGitIpcHandlers } from './lib/git-ipc.mts';
import { registerLanguageServerIpcHandlers } from './lib/language-server-ipc.mts';
import { registerLocalFileLinkIpc, registerWorkspaceFileIpcHandlers } from './lib/workspace-file-ipc.mts';
import { acquireLocalHistory } from './lib/local-history-runtime.mts';
import { registerLocalHistoryIpc } from './lib/local-history-ipc.mts';
import { registerWorkspaceManagementIpcHandlers } from './lib/workspace-management-ipc.mts';
import { registerWorkspaceWindowCloseConfirmation, type WorkspaceRuntimeOptions } from './lib/workspace-application.mts';
import { app, BrowserWindow, clipboard, dialog, nativeImage, shell } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent, OpenDialogOptions } from 'electron';
import { product } from '../config/product.mts';
import {
  CODEGRAPH_DATA_ROOT_ENV,
  codeGraphStorageDirectory,
  registerWorkspace,
  resolveCodeGraphDataRoot,
} from '../config/workspace-storage.mts';
import { chatAttachmentKind, ChatAttachmentStore } from './lib/chat-attachment-store.mts';
import { CodeGraphIndexer, CodeGraphService, createCodeGraphCommands } from './lib/codegraph-service.mts';
import { hasReadyCodeGraphIndex, prepareInitialCodeGraph } from './lib/codegraph-initial-index.mts';
import { CodexAccountService } from './lib/codex-account-service.mts';
import { createWorkspaceChatHistory } from './lib/workspace-chat-history.mts';
import { registerCodexChatIpc } from './lib/codex-chat-ipc.mts';
import { CodexChatRelays } from './lib/codex-chat-relay.mts';
import { CodexChatRelayHistory } from './lib/codex-chat-relay-history.mts';
import { CodexChatSavedTurns } from './lib/codex-chat-saved-turns.mts';
import { createWorkspaceSessionStores } from './lib/workspace-session-stores.mts';
import { CodexChatContexts } from './lib/codex-chat-contexts.mts';
import { CodexChatSessionDeletion } from './lib/codex-chat-session-deletion.mts';
import { CodexChatService } from './lib/codex-chat-service.mts';
import { workspaceChatInstructions } from './lib/workspace-chat-instructions.mts';
import { GhosttySurfaceHost } from './lib/ghostty-surface-host.mts';
import { GitService } from './lib/git-service.mts';
import { LanguageServerManager } from './lib/language-server-manager.mts';
import { createBundledLanguageServerCommands } from './lib/language-server-runtime.mts';
import { pluginLogoDataUrl } from './lib/plugin-logo-service.mts';
import { SkillRecordingStore } from './lib/skill-recording-store.mts';
import { TerminalController } from './lib/terminal-controller.mts';
import { startupScreen } from './lib/startup-screen.mts';
import { watchWorkspaceFiles } from './lib/workspace-file-service.mts';
import { pluginWorkflowRequest } from './shared/plugin-actions.ts';
import type { WorkspaceFilesChangedEvent } from './lib/workspace-file-service.mts';
import type { CodexAccountsSnapshot } from './shared/codex-accounts.ts';

export function createWorkspaceRuntime(options: WorkspaceRuntimeOptions,
  onAccountsChanged?: (snapshot: CodexAccountsSnapshot) => void, onWindowCreated?: (window: BrowserWindow) => void) {
const ipcMain = options.scope.ipc;
const rendererEvents = createWorkspaceRendererEvents();
function workspaceWindows(): BrowserWindow[] { return mainWindow && !mainWindow.isDestroyed() ? [mainWindow] : []; }

type IpcSenderEvent = IpcMainEvent | IpcMainInvokeEvent;
type TerminalSplitDirection = 'right' | 'left' | 'down' | 'up';
type WindowTheme = keyof typeof INITIAL_WINDOW_BACKGROUND_COLORS;

interface TerminalSurfaceRequest {
  paneId: string;
  visible: boolean;
  frame: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

function assertRecord(
  value: unknown,
  message: string,
): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(message);
  }
}

function assertWindowTheme(value: unknown): asserts value is WindowTheme {
  if (value !== 'dark' && value !== 'light') {
    throw new TypeError('Terminal theme is invalid.');
  }
}

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const rootDirectory = path.resolve(currentDirectory, '..');
const codeGraphCommands = createCodeGraphCommands({
  packaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  rootDirectory,
  bunExecutable: process.env.CHESHI_BUN,
});
const rendererUrl = options.initial ? process.env.CHESHI_RENDERER_URL?.trim() : undefined;
const startupStartedAt = Number(process.env.CHESHI_DEV_STARTED_AT);
function logStartup(phase: string): void {
  if (!rendererUrl || !Number.isFinite(startupStartedAt) || startupStartedAt <= 0) return;
  process.stdout.write(`[cheshi] Startup ${phase}: ${Date.now() - startupStartedAt} ms\n`);
}
logStartup('main module loaded');
const workspaceRoot = options.workspaceRoot;

const userDataDirectory = app.getPath('userData');
const codeGraphDataRoot = resolveCodeGraphDataRoot();
if (codeGraphDataRoot === null) {
  throw new Error(`${CODEGRAPH_DATA_ROOT_ENV} must resolve after configuring the Cheshi user-data directory.`);
}

const codeGraphDirectory = codeGraphStorageDirectory(codeGraphDataRoot, workspaceRoot);
const codeGraphDatabasePath = path.join(codeGraphDirectory, 'codegraph.db');
const localHistory = acquireLocalHistory({
  workspaceRoot, directory: path.join(path.dirname(codeGraphDirectory), 'local-history'),
  onError: error => process.stderr.write(`[cheshi] Local history: ${error.message}\n`),
});
const CODEX_ACCOUNT_USAGE_CHANNEL = 'cheshi:codex-account-usage-changed';
const CODEX_CHAT_EVENT_CHANNEL = 'cheshi:codex-chat-event';
const GIT_REPOSITORY_CHANGED_CHANNEL = 'cheshi:git-repository-changed';
const LANGUAGE_SERVER_DIAGNOSTICS_CHANNEL = 'cheshi:language-server-diagnostics';
const RENDERER_READY_CHANNEL = 'cheshi:renderer-ready';
const TERMINAL_STATE_CHANNEL = 'cheshi:terminal-state-changed';
const WORKSPACE_FILES_CHANGED_CHANNEL = 'cheshi:workspace-files-changed';
const INITIAL_WINDOW_BACKGROUND_COLORS = Object.freeze({
  dark: '#171717',
  light: '#d7e6ed',
});
const TERMINAL_SPLIT_DIRECTIONS = new Set<TerminalSplitDirection>(['right', 'left', 'down', 'up']);
const MAX_CHAT_ATTACHMENTS = 20;
const ATTACHMENT_PREVIEW_MAX_SIZE = 160;
const languageServerModulesDirectory = app.isPackaged
  ? path.join(
      process.resourcesPath,
      'runtime',
      `${process.platform}-${process.arch}`,
      'language-servers',
      'node_modules',
    )
  : path.join(rootDirectory, 'node_modules');
const codexChatAttachmentStore = new ChatAttachmentStore({
  directory: path.join(userDataDirectory, 'chat-attachments'),
});
const skillRecordingStore = new SkillRecordingStore(path.join(userDataDirectory, 'skill-recordings'));
const languageServerManager = new LanguageServerManager({
  workspaceRoot,
  settingsPath: path.join(userDataDirectory, 'language-servers.json'),
  clientInfo: { name: product.internalName, version: product.version },
  homeDirectory: app.getPath('home'),
  bundledCommands: createBundledLanguageServerCommands({
    runtimeExecutable: process.execPath,
    modulesDirectory: languageServerModulesDirectory,
  }),
});
const gitService = new GitService({ workspaceRoot });

function attachmentPreviewUrl(attachmentPath: string): string | null {
  const source = nativeImage.createFromPath(attachmentPath);
  if (source.isEmpty()) return null;
  const { width, height } = source.getSize();
  if (width <= 0 || height <= 0) return null;
  const preview = Math.max(width, height) > ATTACHMENT_PREVIEW_MAX_SIZE
    ? source.resize({
      ...(width >= height
        ? { width: ATTACHMENT_PREVIEW_MAX_SIZE }
        : { height: ATTACHMENT_PREVIEW_MAX_SIZE }),
      quality: 'good',
    })
    : source;
  return preview.toDataURL();
}

function codexChatAttachmentPreviewUrl(attachmentPath: unknown): string | null {
  if (typeof attachmentPath !== 'string' || !attachmentPath.trim()) {
    throw new TypeError('Chat attachment path must be a non-empty string.');
  }
  if (!path.isAbsolute(attachmentPath)) {
    throw new TypeError('Chat attachment path must be absolute.');
  }
  if (chatAttachmentKind(attachmentPath) !== 'image') return null;
  return attachmentPreviewUrl(attachmentPath);
}

const { accounts: workspaceAccounts, search: chatHistorySearch, mcp: historyMcp } = createWorkspaceChatHistory({
  cwd: workspaceRoot, userDataDirectory, home: app.getPath('home'), openExternal: url => shell.openExternal(url),
  codeGraph: { cli: codeGraphCommands.cli(), dataRoot: codeGraphDataRoot },
  historyDirectory: path.join(path.dirname(codeGraphDirectory), 'chat-history-index'),
  getKey: options.getTypeSafeKey, access: options.historyRecall,
  accountSelection: options.accountSelection,
});
const createChatClient = workspaceAccounts.createClient;
const codexAppServerClient = createChatClient();
const ephemeralSessionClient = createChatClient();
const codeExplanation = createWorkspaceCodeExplanation(ephemeralSessionClient, workspaceRoot);
const temporaryChats = registerTemporaryChatIpc({
  ipc: ipcMain, assertSender: assertCheshiSender,
  createService: () => new TemporaryChatService({ createClient: createChatClient, cwd: workspaceRoot }),
  selectFiles: async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options: OpenDialogOptions = { title: 'Attach files to temporary chat', buttonLabel: 'Attach', properties: ['openFile', 'multiSelections'] };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    return result.canceled ? [] : result.filePaths;
  },
  onCleanupError: (error) => chatServiceOptions.log('temporary-chat-cleanup-failed', { message: String(error) }),
});
const codexAccountService = new CodexAccountService({
  client: codexAppServerClient,
  log: (event, details) => {
    process.stderr.write(`[cheshi] ${event} ${JSON.stringify(details)}\n`);
  },
});
const chatServiceOptions = {
  conversations: workspaceAccounts.conversations,
  createMcpProbeClient: createChatClient,
  cwd: workspaceRoot,
  serviceName: product.internalName,
  historyToolsEnabled: true,
  developerInstructions: workspaceChatInstructions(product.displayName),
  log: (event: string, details: Record<string, unknown>) => {
    process.stderr.write(`[cheshi] ${event} ${JSON.stringify(details)}\n`);
  },
};

const codexChatService = new CodexChatService({ ...chatServiceOptions, client: codexAppServerClient });
const codexChatContexts = new CodexChatContexts({
  createClient: createChatClient,
  service: chatServiceOptions,
  emit: (ownerId, event) => {
    const window = workspaceWindows().find((candidate) => candidate.webContents.id === ownerId);
    rendererEvents.send(window ?? null, CODEX_CHAT_EVENT_CHANNEL, event);
  },
});
const codexChatRelays = new CodexChatRelays({
  contexts: codexChatContexts,
  history: new CodexChatRelayHistory(path.join(path.dirname(codeGraphDirectory), 'chat-relays')),
  emit: (ownerId, state) => {
    const window = workspaceWindows().find((candidate) => candidate.webContents.id === ownerId);
    rendererEvents.send(window ?? null, 'cheshi:codex-chat-relay-event', state);
  },
});
const codexChatSavedTurns = new CodexChatSavedTurns(path.join(path.dirname(codeGraphDirectory), 'saved-chat-turns'));
const codexChatSessionDeletion = new CodexChatSessionDeletion({ contexts: codexChatContexts, service: codexChatService, relays: codexChatRelays });
const accountSwitch = workspaceAccounts.register({
  ipc: ipcMain, assertSender: assertCheshiSender,
  retained: [codexAppServerClient, ephemeralSessionClient],
  service: codexChatService, contexts: codexChatContexts, deletion: codexChatSessionDeletion,
  relays: codexChatRelays, accountUsage: codexAccountService,
  temporaryBusy: () => temporaryChats.hasSessions || codeExplanation.busy,
  resetTemporary: () => codeExplanation.reset(),
  emit: snapshot => {
    onAccountsChanged?.(snapshot);
    for (const window of workspaceWindows()) rendererEvents.send(window, 'cheshi:codex-accounts-changed', snapshot);
  },
});
const chatContextOwners = new WeakSet<Electron.WebContents>();
function isCrossDocumentMainFrameNavigation(details: { isMainFrame: unknown; isSameDocument: unknown }): boolean {
  return details.isMainFrame === true && details.isSameDocument === false;
}

function chatServiceFor(event: IpcMainInvokeEvent, contextId: unknown) {
  assertCheshiSender(event, 'Chat');
  if (contextId === undefined) return codexChatService;
  if (!chatContextOwners.has(event.sender)) {
    chatContextOwners.add(event.sender);
    const ownerId = event.sender.id;
    const disposeOwner = () => {
      void codexChatContexts.disposeOwner(ownerId).catch((error: unknown) => {
        chatServiceOptions.log('codex-chat-context-cleanup-failed', { ownerId, message: String(error) });
      });
    };
    event.sender.on('did-start-navigation', (details) => {
      if (isCrossDocumentMainFrameNavigation(details)) disposeOwner();
    });
    event.sender.on('render-process-gone', disposeOwner);
    event.sender.once('destroyed', disposeOwner);
  }
  return codexChatContexts.get(event.sender.id, contextId);
}

const unsubscribeAccount = codexAccountService.onDidChange((status) => {
  for (const window of workspaceWindows()) {
    rendererEvents.send(window, CODEX_ACCOUNT_USAGE_CHANNEL, status);
  }
});

const unsubscribeChat = codexChatService.onEvent((event) => {
  for (const window of workspaceWindows()) {
    rendererEvents.send(window, CODEX_CHAT_EVENT_CHANNEL, event);
  }
});

const unsubscribeDiagnostics = languageServerManager.onDiagnostics((diagnostics) => {
  for (const window of workspaceWindows()) {
    rendererEvents.send(window, LANGUAGE_SERVER_DIAGNOSTICS_CHANNEL, diagnostics);
  }
});

function chatMessageRequest(value: unknown) {
  assertRecord(value, 'Chat message request must be an object.');
  const {
    text,
    clientMessageId,
    threadId: threadIdValue,
    skill: skillValue,
    attachments: attachmentValues = [],
  } = value;
  if (typeof text !== 'string' || !text.trim()) throw new TypeError('Chat message must be a non-empty string.');
  if (typeof clientMessageId !== 'string' || !clientMessageId.trim()) {
    throw new TypeError('Client message id must be a non-empty string.');
  }
  if (
    threadIdValue !== undefined
    && threadIdValue !== null
    && (typeof threadIdValue !== 'string' || !threadIdValue.trim())
  ) {
    throw new TypeError('Chat session id must be undefined, null, or a non-empty string.');
  }
  const threadId = typeof threadIdValue === 'string' ? threadIdValue.trim() : threadIdValue;
  let skill = null;
  if (skillValue !== undefined && skillValue !== null) {
    assertRecord(skillValue, 'Chat skill must be an object.');
    const { name, path: skillPath } = skillValue;
    if (typeof name !== 'string' || !name.trim()) throw new TypeError('Chat skill name must be a non-empty string.');
    if (typeof skillPath !== 'string' || !skillPath.trim()) {
      throw new TypeError('Chat skill path must be a non-empty string.');
    }
    skill = { name: name.trim(), path: skillPath.trim() };
  }
  if (!Array.isArray(attachmentValues)) throw new TypeError('Chat attachments must be an array.');
  if (attachmentValues.length > MAX_CHAT_ATTACHMENTS) {
    throw new TypeError(`Chat messages support up to ${MAX_CHAT_ATTACHMENTS} attachments.`);
  }
  const attachments = attachmentValues.map((attachmentValue) => {
    assertRecord(attachmentValue, 'Each chat attachment must be an object.');
    const { kind, name, path: attachmentPath } = attachmentValue;
    if (kind !== 'image' && kind !== 'file') throw new TypeError('Chat attachment kind is invalid.');
    if (typeof name !== 'string' || !name.trim()) throw new TypeError('Chat attachment name must be a non-empty string.');
    if (typeof attachmentPath !== 'string' || !attachmentPath.trim() || !path.isAbsolute(attachmentPath)) {
      throw new TypeError('Chat attachment path must be absolute.');
    }
    return { kind, name: name.trim(), path: attachmentPath };
  });
  return { text, clientMessageId, threadId, skill, attachments };
}

async function selectCodexChatAttachments(event: IpcMainInvokeEvent) {
  const owner = BrowserWindow.fromWebContents(event.sender);
  const options: OpenDialogOptions = {
    title: 'Attach files to this chat',
    buttonLabel: 'Attach',
    properties: ['openFile', 'multiSelections'],
  };
  const result = owner
    ? await dialog.showOpenDialog(owner, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled) return [];
  const storedAttachments = await codexChatAttachmentStore.importFiles(
    result.filePaths.slice(0, MAX_CHAT_ATTACHMENTS),
  );
  return storedAttachments.map((attachment) => {
    const previewUrl = attachment.kind === 'image' ? attachmentPreviewUrl(attachment.path) : null;
    return {
      ...attachment,
      ...(previewUrl ? { previewUrl } : {}),
    };
  });
}

async function selectLanguageServerExecutable(
  event: IpcMainInvokeEvent,
  language: unknown,
) {
  assertCheshiSender(event);
  const status = languageServerManager.getStatuses().find((entry) => entry.language === language);
  if (!status) throw new TypeError('Language server language is invalid.');
  const owner = BrowserWindow.fromWebContents(event.sender);
  const options: OpenDialogOptions = {
    title: `Select ${status.serverName}`,
    buttonLabel: 'Select',
    properties: ['openFile'],
  };
  const result = owner
    ? await dialog.showOpenDialog(owner, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled || !result.filePaths[0]) {
    return { canceled: true, statuses: languageServerManager.getStatuses() };
  }
  const statuses = await languageServerManager.configure({
    language: status.language,
    mode: 'custom',
    executable: result.filePaths[0],
  });
  return { canceled: false, statuses };
}

registerWorkspaceFileIpcHandlers({ ipcMain, workspaceRoot, clipboard, shell, localHistory });
registerLocalFileLinkIpc({ ipcMain, workspaceRoot, shell, assertSender: assertCheshiSender });
registerLocalHistoryIpc({ ipcMain, service: localHistory, assertSender: assertCheshiSender, onChanged: sendWorkspaceFilesChanged });
const management = registerWorkspaceManagementIpcHandlers({ ipcMain, app, dialog, trashItem: (root) => shell.trashItem(root), withWorkspaceDeletion: options.withWorkspaceDeletion, assertWorkspaceAvailable: options.assertWorkspaceAvailable, openExternal: (url) => shell.openExternal(url), getWindow: () => mainWindow, assertSender: assertCheshiSender, dataRoot: codeGraphDataRoot, onOpenWorkspace: options.onOpenWorkspace, onReplaceWorkspace: options.onReplaceWorkspace, manager: { createWindow: (configuration) => new BrowserWindow(configuration), rendererUrl, workspaceRoot, onWindowCreated: (window) => options.scope.addOwner(window.webContents, true) } });
registerGitIpcHandlers({ ipcMain, gitService, assertCheshiSender, shell });
registerLanguageServerIpcHandlers({ ipcMain, languageServerManager, assertCheshiSender, selectLanguageServerExecutable });
ipcMain.handle('cheshi:set-terminal-view-visible', (event, visible) => {
  assertTerminalSender(event);
  if (visible !== true && visible !== false) {
    throw new TypeError('Terminal visibility must be a boolean.');
  }
  terminalViewVisible = visible;
  if (visible && terminalSurfaces?.available) terminalController?.open(workspaceRoot);
  syncTerminalSurfaces();
  return terminalSnapshot();
});
ipcMain.handle('cheshi:set-terminal-theme', (event, theme) => {
  assertTerminalSender(event);
  assertWindowTheme(theme);
  mainWindow?.setBackgroundColor(INITIAL_WINDOW_BACKGROUND_COLORS[theme]);
  terminalDark = theme === 'dark';
  terminalSurfaces?.setDark(terminalDark);
  return terminalSnapshot();
});
ipcMain.on('cheshi:update-terminal-surface-bounds', (event, value) => {
  assertTerminalSender(event);
  const surface = readTerminalSurfaceBounds(value, event.sender.getZoomFactor());
  if (!surface || !terminalController?.findPane(surface.paneId)) return;
  terminalSurfaces?.updatePane(surface.paneId, surface.frame, surface.visible);
});
ipcMain.handle('cheshi:new-terminal-session', (event) => {
  assertTerminalSender(event);
  if (terminalSurfaces?.available) terminalController?.newSession();
  return terminalSnapshot();
});
ipcMain.handle('cheshi:select-terminal-session', (event, sessionId) => {
  assertTerminalSender(event);
  terminalController?.selectSession(sessionId);
  return terminalSnapshot();
});
ipcMain.handle('cheshi:close-terminal-session', (event, sessionId) => {
  assertTerminalSender(event);
  terminalController?.closeSession(sessionId);
  return terminalSnapshot();
});
ipcMain.handle('cheshi:select-terminal-pane', (event, sessionId, paneId) => {
  assertTerminalSender(event);
  terminalController?.selectPane(sessionId, paneId);
  return terminalSnapshot();
});
ipcMain.handle('cheshi:split-terminal-pane', (event, sessionId, paneId, direction) => {
  assertTerminalSender(event);
  if (TERMINAL_SPLIT_DIRECTIONS.has(direction)) {
    terminalController?.splitPane(sessionId, paneId, direction);
  }
  return terminalSnapshot();
});
ipcMain.handle('cheshi:resize-terminal-split', (event, sessionId, splitId, ratio) => {
  assertTerminalSender(event);
  if (typeof splitId !== 'string' || !splitId.trim()) {
    throw new TypeError('Terminal split id must be a non-empty string.');
  }
  if (!Number.isFinite(ratio) || ratio < 0.1 || ratio > 0.9) {
    throw new TypeError('Terminal split ratio must be between 0.1 and 0.9.');
  }
  terminalController?.resizeSplit(sessionId, splitId.trim(), ratio);
  return terminalSnapshot();
});
ipcMain.handle('cheshi:close-terminal-pane', (event, sessionId, paneId) => {
  assertTerminalSender(event);
  terminalController?.closePane(sessionId, paneId);
  return terminalSnapshot();
});
ipcMain.handle('cheshi:is-codegraph-indexed', () => hasReadyCodeGraphIndex(codeGraphDatabasePath));
ipcMain.handle('cheshi:reindex-codegraph', () => reindexCodeGraph());
ipcMain.handle('cheshi:get-codex-account-usage', () => codexAccountService.getStatus());
ipcMain.handle('cheshi:list-codex-plugins', (_event, forceRefetch) => codexChatService.listPlugins(forceRefetch));
ipcMain.handle('cheshi:add-codex-marketplace', (event, request) => {
  assertCheshiSender(event, 'Marketplace');
  return codexChatService.addMarketplace(request);
});
ipcMain.handle('cheshi:save-skill-recording', (event, recording) => {
  assertCheshiSender(event, 'Skill recording');
  return skillRecordingStore.save(recording);
});
ipcMain.handle('cheshi:start-plugin-workflow', async (event, value, contextId) => {
  assertCheshiSender(event, 'Plugin workflow');
  const request = pluginWorkflowRequest(value);
  const attachments = request.recordingId ? await skillRecordingStore.attachments(request.recordingId) : [];
  return codexChatRelays.mutation(event.sender.id, contextId, () => chatServiceFor(event, contextId).startPluginWorkflow(request, attachments));
});
ipcMain.handle('cheshi:get-codex-plugin-logo', async (_event, pluginId) => {
  const sources = codexChatService.getPluginLogoSources(pluginId);
  if (!sources) return { light: null, dark: null };
  const [light, dark] = await Promise.all([
    pluginLogoDataUrl(sources.light),
    pluginLogoDataUrl(sources.dark),
  ]);
  return { light, dark };
});
ipcMain.handle('cheshi:read-codex-plugin', (_event, reference) => codexChatService.readPlugin(reference));
ipcMain.handle('cheshi:install-codex-plugin', (_event, reference) => codexChatService.installPlugin(reference));
ipcMain.handle('cheshi:uninstall-codex-plugin', (_event, pluginId) => codexChatService.uninstallPlugin(pluginId));
ipcMain.handle('cheshi:explain-code', (event, request) => {
  assertCheshiSender(event);
  return codeExplanation.explain(request);
});
ipcMain.handle('cheshi:cancel-code-explanation', (event, requestId) => {
  assertCheshiSender(event);
  codeExplanation.cancel(requestId);
});
ipcMain.handle('cheshi:select-codex-chat-attachments', (event) => selectCodexChatAttachments(event));
ipcMain.handle('cheshi:import-codex-chat-attachments', async (_event, payload: unknown) => {
  const attachments = await codexChatAttachmentStore.importTransferredFiles(payload);
  return attachments.map((attachment) => ({
    ...attachment,
    ...(attachment.kind === 'image' ? { previewUrl: attachmentPreviewUrl(attachment.path) ?? undefined } : {}),
  }));
});
ipcMain.handle(
  'cheshi:get-codex-chat-attachment-preview',
  (_event, attachmentPath) => codexChatAttachmentPreviewUrl(attachmentPath),
);
const sessionStores = createWorkspaceSessionStores(ipcMain, codeGraphDirectory, assertCheshiSender);
registerCodexChatIpc({
  ipc: ipcMain, service: chatServiceFor, relays: codexChatRelays, assertSender: assertCheshiSender,
  savedTurns: codexChatSavedTurns,
  historySearch: chatHistorySearch,
  beforeMessage: workspaceAccounts.beforeMessage,
  deletion: codexChatSessionDeletion,
  prepareMessage: async (value) => {
    const request = chatMessageRequest(value);
    const attachments = await codexChatAttachmentStore.importAttachments(request.attachments);
    return { ...request, attachments };
  },
});
ipcMain.handle('cheshi:dispose-codex-chat-context', (event, contextId) => {
  assertCheshiSender(event, 'Chat');
  return codexChatSessionDeletion.mutation(() => codexChatContexts.dispose(event.sender.id, contextId));
});
function currentUserName(): string {
  try {
    return userInfo().username.trim();
  } catch {
    return '';
  }
}

ipcMain.on('cheshi:get-workspace-metadata', (event) => {
  event.returnValue = {
    userName: currentUserName(),
    workspaceName: path.basename(workspaceRoot) || 'Workspace',
    workspaceRoot,
  };
});

let mainWindow: BrowserWindow | null = null;
let codeGraphService: CodeGraphService | null = null;
const initialIndexAbort = new AbortController();
let codeGraphIndexer: CodeGraphIndexer | null = null;
let codeGraphReindexPromise: Promise<{ reindexed: true }> | null = null;
let appQuitting = false;
let codeGraphServerPort = options.initial ? process.env.CHESHI_VIEWER_API_PORT?.trim() || null : null;
let terminalController: TerminalController | null = null;
let terminalSurfaces: GhosttySurfaceHost | null = null;
let terminalRuntimeError: string | null = null;
let terminalViewVisible = false;
let terminalDark = true;
let stopGitRepositoryWatcher: (() => void) | null = null;
let stopWorkspaceFileWatcher: (() => void) | null = null;

function sendGitRepositoryChanged() {
  for (const window of workspaceWindows()) {
    rendererEvents.send(window, GIT_REPOSITORY_CHANGED_CHANNEL);
  }
}

async function initializeGitRepositoryWatcher() {
  stopGitRepositoryWatcher?.();
  stopGitRepositoryWatcher = null;
  try {
    stopGitRepositoryWatcher = await gitService.watchRepository(sendGitRepositoryChanged, {
      onError: (error) => {
        process.stderr.write(
          `[cheshi] Git repository watcher: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      },
    });
  } catch (error) {
    process.stderr.write(
      `[cheshi] Git repository watcher could not start: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

function disposeGitRepositoryWatcher() {
  stopGitRepositoryWatcher?.();
  stopGitRepositoryWatcher = null;
}

function sendWorkspaceFilesChanged(event: WorkspaceFilesChangedEvent): void {
  void localHistory.captureChanged(event);
  for (const window of workspaceWindows()) {
    rendererEvents.send(window, WORKSPACE_FILES_CHANGED_CHANNEL, event);
  }
}

async function initializeWorkspaceFileWatcher() {
  stopWorkspaceFileWatcher?.();
  stopWorkspaceFileWatcher = null;
  try {
    stopWorkspaceFileWatcher = await watchWorkspaceFiles(workspaceRoot, sendWorkspaceFilesChanged, {
      onError: (error) => {
        process.stderr.write(`[cheshi] Workspace file watcher: ${error.message}\n`);
      },
    });
  } catch (error) {
    process.stderr.write(
      `[cheshi] Workspace file watcher could not start: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

function disposeWorkspaceFileWatcher() {
  stopWorkspaceFileWatcher?.();
  stopWorkspaceFileWatcher = null;
}

function assertTerminalSender(event: IpcSenderEvent): void {
  assertCheshiSender(event, 'Terminal');
}

function assertCheshiSender(event: IpcSenderEvent, feature = 'Cheshi'): void {
  if (mainWindow && event.sender === mainWindow.webContents) return;
  throw new Error(`${feature} IPC sender is not the active Cheshi window.`);
}

function readTerminalSurfaceBounds(
  value: unknown,
  zoomFactor: number,
): TerminalSurfaceRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const surface = value as Record<string, unknown>;
  if (typeof surface.paneId !== 'string' || !surface.paneId.trim()) return null;
  if (surface.visible !== true && surface.visible !== false) return null;
  const { x, y, width, height } = surface;
  if (![x, y, width, height].every((coordinate) => (
    typeof coordinate === 'number' && Number.isFinite(coordinate)
  ))) return null;
  const zoom = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  return {
    paneId: surface.paneId.trim(),
    visible: surface.visible,
    frame: {
      x: (x as number) / zoom,
      y: (y as number) / zoom,
      width: (width as number) / zoom,
      height: (height as number) / zoom,
    },
  };
}

function terminalSnapshot() {
  const state = terminalController?.snapshot() ?? {
    cwd: null,
    sessions: [],
    activeSessionId: null,
    activePaneId: null,
  };
  return {
    available: terminalSurfaces?.available === true,
    error: terminalRuntimeError,
    ...state,
  };
}

function sendTerminalState() {
  rendererEvents.send(mainWindow, TERMINAL_STATE_CHANNEL, terminalSnapshot());
}

function syncTerminalSurfaces() {
  const controller = terminalController;
  const activeSession = controller?.sessions.find(
    (session) => session.id === controller.activeSessionId,
  );
  terminalSurfaces?.sync({
    paneIds: controller?.sessions.flatMap(
      (session) => session.panes.map((pane) => pane.id),
    ) ?? [],
    visiblePaneIds: activeSession?.panes.map((pane) => pane.id) ?? [],
    activePaneId: controller?.activePaneId ?? null,
    pageVisible: terminalViewVisible,
  });
}

function reportTerminalError(error: unknown): void {
  terminalRuntimeError = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[cheshi] Ghostty terminal: ${terminalRuntimeError}\n`);
  sendTerminalState();
}

function initializeTerminal(window: BrowserWindow): void {
  terminalViewVisible = false;
  terminalRuntimeError = null;
  terminalController = new TerminalController({
    onStateChanged: () => {
      syncTerminalSurfaces();
      sendTerminalState();
    },
  });
  try {
    terminalSurfaces = new GhosttySurfaceHost({
      owner: window,
      workingDirectory: workspaceRoot,
      dark: terminalDark,
      onFocus: (paneId) => {
        const controller = terminalController;
        const pane = controller?.findPane(paneId);
        if (controller && pane) controller.selectPane(pane.sessionId, paneId);
      },
      onSplit: (paneId, direction) => {
        const controller = terminalController;
        const pane = controller?.findPane(paneId);
        if (controller && pane) controller.splitPane(pane.sessionId, paneId, direction);
      },
      onClose: (paneId) => terminalController?.handleSurfaceExit(paneId),
      onTitle: (paneId, title) => terminalController?.setPaneTitle(paneId, title),
      onError: reportTerminalError,
    });
    if (!terminalSurfaces.available) {
      terminalRuntimeError = 'libghostty terminals are available on macOS only.';
    }
  } catch (error) {
    terminalSurfaces = null;
    terminalRuntimeError = `Could not load libghostty: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function disposeTerminal() {
  terminalViewVisible = false;
  syncTerminalSurfaces();
  terminalSurfaces?.close();
  terminalController?.close(false);
  terminalSurfaces = null;
  terminalController = null;
}

function frontendAssetsDirectory() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'dist')
    : path.join(rootDirectory, 'desktop', 'frontend', 'dist');
}

async function startCodeGraphServer() {
  if (!hasReadyCodeGraphIndex(codeGraphDatabasePath)) return null;
  codeGraphService = new CodeGraphService({
    command: codeGraphCommands.viewer({ CHESHI_VIEWER_API_PORT: codeGraphServerPort || '', CHESHI_VIEWER_API_ONLY: rendererUrl ? '1' : '0' }),
    log: (event, details) => process.stdout.write(`[cheshi] ${event} ${JSON.stringify(details)}\n`),
  });
  try {
    const url = await codeGraphService.start(workspaceRoot, frontendAssetsDirectory(), userDataDirectory);
    if (!codeGraphServerPort) {
      codeGraphServerPort = new URL(url).port || null;
    }
    return url;
  } catch (error) {
    process.stderr.write(`[cheshi] CodeGraph server: ${error instanceof Error ? error.message : String(error)}\n`);
    codeGraphService = null;
    return null;
  }
}

async function performCodeGraphReindex(): Promise<{ reindexed: true }> {
  const activeService = codeGraphService;
  codeGraphService = null;
  await activeService?.stop();

  let indexingError = null;
  codeGraphIndexer = new CodeGraphIndexer({ command: codeGraphCommands.cli() });
  try {
    await codeGraphIndexer.reindex(workspaceRoot, userDataDirectory);
  } catch (error) {
    indexingError = error;
  } finally {
    codeGraphIndexer = null;
  }

  const restartedUrl = appQuitting ? null : await startCodeGraphServer();
  if (indexingError) throw indexingError;
  if (!appQuitting && !restartedUrl) {
    throw new Error('CodeGraph was reindexed, but its Viewer service could not be restarted.');
  }
  return { reindexed: true };
}

async function reindexCodeGraph() {
  if (codeGraphReindexPromise) return await codeGraphReindexPromise;
  codeGraphReindexPromise = performCodeGraphReindex();
  try {
    return await codeGraphReindexPromise;
  } finally {
    codeGraphReindexPromise = null;
  }
}

let revealPreparedWindow: (() => void) | null = null;
let pendingIndexWarning: string | null = null;

async function createMainWindow(contentUrl: string | null): Promise<BrowserWindow> {
  if (appQuitting) throw new Error('Workspace startup was canceled.');
  const shouldShowWindow = process.env.CHESHI_E2E_HEADLESS !== '1';
  const window = new BrowserWindow({
    show: false,
    width: 1440,
    height: 900,
    minWidth: 1280,
    minHeight: 680,
    title: product.displayName,
    backgroundColor: INITIAL_WINDOW_BACKGROUND_COLORS.dark,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 14 },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: app.isPackaged
        ? path.join(process.resourcesPath, 'runtime', 'preload.cjs')
        : path.join(currentDirectory, 'runtime', 'preload.cjs'),
      sandbox: true,
    },
  });
  logStartup('window created');
  registerWorkspaceWindowCloseConfirmation(window, dialog);
  options.scope.addOwner(window.webContents);
  if (options.windowState) window.setBounds(options.windowState.bounds);

  const readiness = createWorkspaceWindowReadiness({ signal: initialIndexAbort.signal });
  let initialRevealComplete = false;
  const revealWindow = () => {
    const theme = readiness.assertReady();
    if (appQuitting || window.isDestroyed()) throw new Error('Workspace startup was canceled.');
    window.setBackgroundColor(INITIAL_WINDOW_BACKGROUND_COLORS[theme]);
    if (initialRevealComplete) return;
    initialRevealComplete = true;
    if (shouldShowWindow) {
      if (options.windowState) window.setBounds(options.windowState.bounds);
      window.show();
      if (options.windowState?.maximized) window.maximize();
      if (options.windowState?.fullscreen) window.setFullScreen(true);
      if (options.initial) startupScreen.close();
      logStartup('window shown');
    }
    if (options.deferShow) {
      try { registerWorkspace(userDataDirectory, workspaceRoot, { setCurrent: true }); }
      catch (error) { process.stderr.write(`[cheshi] Workspace registration failed: ${String(error)}\n`); }
    }
    if (shouldShowWindow && pendingIndexWarning) {
      void dialog.showMessageBox(window, {
        type: 'warning', title: 'CodeGraph indexing failed',
        message: 'The workspace is open, but its CodeGraph index could not be created.',
        detail: `${pendingIndexWarning}\n\nOpen this workspace again to retry indexing.`,
      }).catch((error: unknown) => process.stderr.write(`[cheshi] Index notification: ${String(error)}\n`));
      pendingIndexWarning = null;
    }
  };
  revealPreparedWindow = revealWindow;
  const handleRendererReady = (event: IpcMainEvent, theme: unknown) => {
    if (event.sender !== window.webContents) return;
    assertCheshiSender(event, 'Renderer readiness');
    if (theme !== 'dark' && theme !== 'light') throw new TypeError('Renderer theme is invalid.');
    readiness.rendererReady(theme);
    logStartup('renderer ready');
  };
  const handleReadyToShow = () => {
    logStartup('browser ready to show');
    readiness.browserReady();
  };
  ipcMain.on(RENDERER_READY_CHANNEL, handleRendererReady);

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.session.setDisplayMediaRequestHandler((_request, callback) => {
    callback({});
  }, { useSystemPicker: true });
  window.webContents.on('render-process-gone', (_event, details) => {
    process.stderr.write(
      `[cheshi] Renderer process exited: reason=${details.reason} exitCode=${details.exitCode}\n`,
    );
    if (!initialRevealComplete && !appQuitting) {
      readiness.fail(new Error('The workspace renderer exited before it was ready.'));
      window.destroy();
    }
  });
  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return;
    process.stderr.write(
      `[cheshi] Renderer load failed: code=${errorCode} description=${errorDescription} url=${validatedUrl}\n`,
    );
    readiness.fail(new Error(`The workspace renderer could not load: ${errorDescription}`));
  });

  mainWindow = window;
  onWindowCreated?.(window);
  initializeTerminal(window);
  logStartup('terminal bridge ready');
  window.on('show', () => terminalSurfaces?.setWindowVisible(true));
  window.on('hide', () => terminalSurfaces?.setWindowVisible(false));
  window.on('minimize', () => terminalSurfaces?.setWindowVisible(false));
  window.on('restore', () => terminalSurfaces?.setWindowVisible(true));
  window.once('ready-to-show', handleReadyToShow);
  window.on('closed', () => {
    readiness.fail(new Error('The workspace window closed before it was revealed.'));
    ipcMain.off(RENDERER_READY_CHANNEL, handleRendererReady);
    if (mainWindow !== window) return;
    disposeTerminal();
    void languageServerManager.stop();
    mainWindow = null;
    options.onClosed();
  });

  const loading = rendererUrl ? window.loadURL(rendererUrl)
    : contentUrl ? window.loadURL(contentUrl)
      : window.loadFile(path.join(frontendAssetsDirectory(), 'index.html'));
  void loading.then(() => readiness.loaded(), (error: unknown) => readiness.fail(error));
  await readiness.ready;
  if (!options.deferShow) revealWindow();
  return window;
}

async function initialize(): Promise<BrowserWindow> {
  logStartup('electron ready');
  if (options.initial) await startupScreen.setStatus('Preparing workspace…');
  if (!options.deferShow) registerWorkspace(userDataDirectory, workspaceRoot, { setCurrent: true });
  const index = await prepareInitialCodeGraph({
    databasePath: codeGraphDatabasePath,
    workspaceRoot,
    dataRoot: codeGraphDataRoot!,
    command: codeGraphCommands.cli(),
    signal: initialIndexAbort.signal,
    onIndexing: () => { if (options.initial) void startupScreen.setStatus('Indexing workspace…'); },
  });
  const codeGraphUrl = index.ready ? await startCodeGraphServer() : null;
  logStartup('codegraph ready');
  await initializeWorkspaceFileWatcher();
  logStartup('workspace watcher ready');
  await initializeGitRepositoryWatcher();
  logStartup('git watcher ready');
  if (options.initial) await startupScreen.setStatus('Loading workspace information…');
  pendingIndexWarning = index.error ? String(index.error) : null;
  await accountSwitch.initialize(error => chatServiceOptions.log('codex-account-initialization-failed', { message: String(error) }));
  return await createMainWindow(codeGraphUrl);
}

let initialization: Promise<BrowserWindow> | null = null;
let disposal: Promise<void> | null = null;
function start(): Promise<BrowserWindow> {
  initialization ??= initialize();
  return initialization;
}
function dispose(): Promise<void> {
  if (disposal) return disposal;
  appQuitting = true;
  rendererEvents.stop();
  unsubscribeAccount();
  unsubscribeChat();
  unsubscribeDiagnostics();
  disposeWorkspaceFileWatcher();
  disposeGitRepositoryWatcher();
  initialIndexAbort.abort();
  disposal = Promise.resolve().then(async () => {
    await initialization?.catch(() => undefined);
    const managementDisposal = management.dispose();
    // Startup may have completed a watcher registration after disposal began.
    disposeWorkspaceFileWatcher();
    disposeGitRepositoryWatcher();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
    disposeTerminal();
    codeExplanation.stop();
    const results = await Promise.allSettled([
      codexChatService.stop(),
      historyMcp.stop(), chatHistorySearch.stop(),
      temporaryChats.stop(),
      localHistory.dispose(),
      managementDisposal,
      codexAccountService.stop(), accountSwitch.stop(), workspaceAccounts.stop(),
      codeGraphService?.stop(), codeGraphIndexer?.stop(), ephemeralSessionClient.stop(),
      codexChatRelays.shutdown(), codexChatContexts.stop(), codexChatSavedTurns.flush(), sessionStores.flush(), languageServerManager.stop(),
    ]);
    options.scope.dispose();
    for (const result of results) {
      if (result.status === 'rejected') process.stderr.write(`[cheshi] Workspace cleanup failed: ${String(result.reason)}\n`);
    }
  });
  return disposal;
}
function show() {
  if (!revealPreparedWindow) throw new Error('The workspace window is not ready.');
  revealPreparedWindow();
}
return { start, show, dispose };
}
