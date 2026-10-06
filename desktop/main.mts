import { createToolCredentials } from './lib/agent-management/tool-credentials.mts';
import { createCodeGraphSynchronization } from './lib/codegraph-synchronization.mts';
import { createAgentCodeGraph } from './lib/agent-orchestration/codegraph-source.mts';
import { createAgentChats } from './lib/agent-chats/service.mts';
import { registerAgentChatsIpc } from './lib/agent-chats/ipc.mts';
import { createSpecialistRuntime } from './lib/agent-management/runtime.mts';
import { createAgentDeletion } from './lib/agent-management/deletion.mts';
import { startScheduler, resumeScheduler, stopScheduler, suspendScheduler } from './lib/scheduler/application.mts';
import { configureSchedulerDesktop } from './lib/scheduler/desktop.mts';
import { createSchedulerNotifications } from './lib/scheduler/notifications.mts';
import type { SchedulerEngine } from './lib/scheduler/engine.mts';
import type { ScheduleRun } from './shared/scheduler.ts';
import { createCodeGraphCommands } from './lib/codegraph-service.mts';
import { codeGraphStorageDirectory, resolveCodeGraphDataRoot } from '../config/workspace-storage.mts';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, autoUpdater, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, nativeTheme, Notification, powerMonitor, screen, safeStorage, shell, Tray } from 'electron';
import { createStickyNotesRuntime } from './lib/sticky-notes-runtime.mts';
import { STICKY_NOTES_SHORTCUT, STICKY_NOTES_LIST_SHORTCUT } from './shared/sticky-notes.ts';
import { product } from '../config/product.mts';
import { aboutBackgroundColor, aboutPage } from './lib/about-page.mts';
import { registerSelectionCopy } from './lib/selection-copy.mts';
import { createAboutWindow } from './lib/about-window.mts';
import { aboutMenuTemplate } from './lib/about-menu.mts';
import { createHelpMenuAction, helpMenuTemplate } from './lib/help-menu.mts';
import { startupScreen } from './lib/startup-screen.mts';
import { WorkspaceApplication, WorkspaceWindowCloseCancelledError } from './lib/workspace-application.mts';
import { WorkspaceIpcRouter } from './lib/workspace-ipc-router.mts';
import { createWorkspaceRuntime } from './workspace-runtime.mts';
import { createWorkspaceManagerRuntime } from './lib/workspace-manager-runtime.mts';
import { canRestoreStartupWorkspace, resolveStartupWorkspace } from './lib/workspace-startup.mts';
import { createWorkspaceCodexLoginService } from './lib/workspace-codex-login.mts';
import { desktopToolPath, getWorkspaceToolStatus } from './lib/workspace-tool-status.mts';
import { createAccountUsageTray } from './lib/account-usage-tray.mts';
import { createAccountUsagePopover } from './lib/account-usage-popover.mts';
import { loadMenuBarFont } from './lib/menu-bar-font.mts';
import { loadMenuBarLogo } from './lib/menu-bar-logo.mts';
import { createAccountUsageBackground } from './lib/account-usage-background.mts';
import { getCodexAccountProfiles } from './lib/codex-account-profiles.mts';
import { createSettingsService } from './lib/settings-service.mts';
import { registerSettingsIpc } from './lib/settings-ipc.mts';
import { createAgentManagementService } from './lib/agent-management/service.mts';
import { createDockerAgentEngine } from './lib/agent-management/docker.mts';
import { registerAgentManagementIpc } from './lib/agent-management/ipc.mts';
import { AgentTerminalManager } from './lib/agent-management/terminal.mts';
import { createAgentRegistry } from './lib/agent-management/registry.mts';
import { registerAgentRegistryIpc } from './lib/agent-management/registry-ipc.mts';
import { checkTypeSafeConnection } from './lib/typesafe-connection.mts';
import { readTypeSafeKey } from './lib/typesafe-key.mts';
import { findAppRelease } from './lib/app-release-checker.mts';
import { createAppUpdateService } from './lib/app-update-service.mts';
import { createAppUpdatePreview } from './lib/app-update-preview.mts';
import { appUpdateUnavailableReason, stageAppUpdate } from './lib/app-update-installer.mts';
import { createAppUpdateResume } from './lib/app-update-resume.mts';
import { APP_UPDATE_CHANNEL } from './shared/app-update.ts';
import { KEEP_AWAKE_CHANNEL } from './shared/keep-awake.ts';
import { createNotificationEvents } from './lib/notification-events.mts';
import { registerNotificationEventsIpc } from './lib/notification-events-ipc.mts';
import { createDiscordService } from './lib/discord-service.mts';
import { createDiscordSetupBrowser } from './lib/discord-setup-browser.mts';
import { registerDiscordIpc } from './lib/discord-ipc.mts';
import { createIMessageNotifications } from './lib/imessage-notifications.mts';
import { registerIMessageIpc } from './lib/imessage-ipc.mts';
import { createIMessageCommands } from './lib/imessage-commands.mts';
import { KeepAwakeService } from './lib/keep-awake-service.mts';
import type { WorkspaceRuntimeOptions } from './lib/workspace-application.mts';

process.env.PATH = desktopToolPath(process.env.PATH);
const selectionCopyPreload = path.join(import.meta.dirname, 'runtime', 'selection-copy-preload.cjs');
const usagePopoverPreload = path.join(app.isPackaged ? process.resourcesPath : import.meta.dirname, 'runtime', 'account-usage-preload.cjs');
const stickyNotes = createStickyNotesRuntime({
  directory: path.join(app.getPath('userData'), 'sticky-notes'),
  appearanceFile: path.join(app.getPath('userData'), 'appearance.json'),
  rendererUrl: process.env.CHESHI_RENDERER_URL?.trim() || pathToFileURL(app.isPackaged
    ? path.join(process.resourcesPath, 'dist', 'index.html')
    : path.join(import.meta.dirname, 'frontend', 'dist', 'index.html')).href,
  preload: path.join(app.isPackaged ? process.resourcesPath : import.meta.dirname, 'runtime', 'sticky-notes-preload.cjs'),
  createWindow: options => new BrowserWindow(options), ipc: ipcMain, shortcuts: globalShortcut, screen,
  onError: error => dialog.showErrorBox('Cheshi Notes', error instanceof Error ? error.message : String(error)),
});
const aboutWindow = createAboutWindow({
  title: `About ${product.displayName}`,
  backgroundColor: aboutBackgroundColor,
  createWindow: options => {
    const window = new BrowserWindow({ ...options, webPreferences: { ...options.webPreferences, preload: selectionCopyPreload } });
    registerSelectionCopy(window.webContents, clipboard);
    return window;
  },
  page: () => aboutPage({ name: product.displayName, version: product.version, buildNumber: product.buildNumber, publisher: product.publisher }),
  openExternal: url => shell.openExternal(url),
  onError: error => process.stderr.write(`[cheshi] About window failed: ${String(error)}\n`),
});
const updateResume = createAppUpdateResume(path.join(app.getPath('userData'), 'updates'));
const agentEngines = [createDockerAgentEngine()];
const agentManagement: ReturnType<typeof createAgentManagementService> = createAgentManagementService({ engines: agentEngines,
  control: (engine, id, action, operation) => specialistRuntime.manualControl(engine, id, action, operation),
  pendingDeletions: engineId => agentDeletion.pending(engineId) });
const agentRegistry = createAgentRegistry(path.join(app.getPath('userData'), 'agents', 'registry.json'));
const agentDeletion = createAgentDeletion({ directory: path.join(app.getPath('userData'), 'agents', 'deletions'),
  runtimeDirectory: path.join(app.getPath('userData'), 'agents', 'runtimes'), registry: agentRegistry, management: agentManagement });
const agentChats = createAgentChats({ roomChanged: () => specialistRuntime.notify(), filename: path.join(app.getPath('userData'), 'agents', 'chats.json'),
  registry: workspace => agentRegistry.snapshot(workspace),
  permissions: (workspace, input) => specialistRuntime.permissions(workspace, input),
  lifecycle: binding => specialistRuntime.lifecycle(binding),
  wake: (workspace, input, retry) => specialistRuntime.wake(workspace, input, retry),
  status: (workspace, input) => specialistRuntime.request(workspace, input),
  question: (workspace, input) => specialistRuntime.request(workspace, input),
  recover: (workspace, input) => specialistRuntime.request(workspace, input),
  dispatch: (workspace, input, context) => specialistRuntime.chat(workspace, input, context),
});
const codeGraphCommand = createCodeGraphCommands({ packaged: app.isPackaged, resourcesPath: process.resourcesPath,
  rootDirectory: path.resolve(import.meta.dirname, '..'), bunExecutable: process.env.CHESHI_BUN }).cli();
const codeGraphDataRoot = resolveCodeGraphDataRoot() ?? app.getPath('userData');
const codeGraphSynchronization = createCodeGraphSynchronization({ command: codeGraphCommand, dataRoot: codeGraphDataRoot });
const specialistRuntime = createSpecialistRuntime({
  rooms: agentChats.rooms,
  toolCredential: (origin, name) => toolCredentials.get(origin, name),
  codegraph: createAgentCodeGraph({ cli: codeGraphCommand, dataRoot: codeGraphDataRoot, beforeQuery: codeGraphSynchronization.ensure }),
  prepareCodeGraph: codeGraphSynchronization.ensure,
  getProjectDocMaxBytes: () => apiSettings.getProjectDocMaxBytes(),
  history: { enabled: () => apiSettings.isHistoryRecallEnabled(), getKey: () => apiSettings.getKey(),
    subscribe: listener => apiSettings.subscribe(() => listener()) },
  directory: path.join(app.getPath('userData'), 'agents', 'runtimes'), registry: agentRegistry, management: agentManagement,
  buildContext: app.isPackaged ? path.join(process.resourcesPath, 'runtime', 'specialist-worker') : path.join(app.getAppPath(), 'experiments', 'codex-specialists'),
  account: async id => {
    const profiles = acquireAccountProfiles();
    try { return { home: (await profiles.environment(id)).CODEX_HOME!, models: await profiles.models(id) }; }
    finally { await profiles.release(); }
  },
});
const unsubscribeChatsRuntime = specialistRuntime.subscribe(binding => agentChats.changed(binding));
const unsubscribeChatsRegistry = agentRegistry.subscribe(() => agentChats.changed());
void app.whenReady().then(() => { specialistRuntime.start(); agentChats.start(); });
app.on('will-quit', () => { unsubscribeChatsRuntime(); unsubscribeChatsRegistry(); void specialistRuntime.dispose(); void agentChats.dispose(); void codeGraphSynchronization.dispose(); });
const apiSettings = createSettingsService({
  directory: path.join(app.getPath('userData'), 'api-keys'),
  settingsPath: path.join(app.getPath('userData'), 'settings.json'),
  encryption: {
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable()
      && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
    encryptString: value => safeStorage.encryptString(value),
    decryptString: value => safeStorage.decryptString(value),
  },
  fallback: () => readTypeSafeKey({
    developmentFile: app.isPackaged ? undefined : path.resolve(import.meta.dirname, '..', '.env.signing'),
  }),
  checkKey: checkTypeSafeConnection,
});
const toolCredentials = createToolCredentials(path.join(app.getPath('userData'), 'api-keys', 'homie-tools'), {
  isEncryptionAvailable: () => safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
  encryptString: value => safeStorage.encryptString(value), decryptString: value => safeStorage.decryptString(value),
});
const notificationEvents = createNotificationEvents({ filename: path.join(app.getPath('userData'), 'notification-events.json'),
  legacyIMessageFilename: path.join(app.getPath('userData'), 'imessage-notifications.json') });
const discord = createDiscordService({ directory: app.getPath('userData'), encryption: safeStorage, events: notificationEvents });
void app.whenReady().then(() => discord.start());
const notifications = createIMessageNotifications({ filename: path.join(app.getPath('userData'), 'imessage-notifications.json'), events: notificationEvents });
const messageCommands = createIMessageCommands({ recipient: async () => (await notifications.get()).recipient,
  reply: (recipient, text) => notifications.reply(recipient, text) });
const keepAwake = new KeepAwakeService();
const updatePreview = createAppUpdatePreview({ packaged: app.isPackaged, setting: process.env.CHESHI_UPDATE_PREVIEW });
const updates = createAppUpdateService({
  currentVersion: product.version,
  unavailableReason: 'Checking update installation support…',
  check: signal => findAppRelease({ currentVersion: product.version, platform: process.platform, arch: process.arch, signal }),
  openExternal: url => shell.openExternal(url),
  onCheckError: error => process.stderr.write(`[cheshi] Update check failed: ${String(error)}\n`),
  async install(release, report) {
    const reason = await appUpdateUnavailableReason({ packaged: app.isPackaged, platform: process.platform, executable: process.execPath });
    if (reason) throw new Error(reason);
    if (quitting || workspaces.isTransitioning) throw new Error('Wait for the workspace operation to finish before updating.');
    try {
      await updateResume.prepare();
      await stageAppUpdate(autoUpdater, release, { onProgress: report });
      await updateResume.prepare();
      await updateResume.activate();
      report({ phase: 'restarting' });
      quitting = true;
      await stickyNotes.prepareToQuit();
      await workspaces.closeAll();
      schedulerNotifications?.dispose();
      await stopScheduler();
      await keepAwake.dispose();
      await discord.dispose(); await messageCommands.dispose(); await notifications.dispose();
      await backgroundUsage.dispose().catch(reportTrayError);
      usageTray?.dispose();
      aboutWindow.close();
      stickyNotes.dispose();
      cleanupComplete = true;
      updates.dispose();
      autoUpdater.quitAndInstall();
    } catch (error) {
      quitting = false;
      stickyNotes.resume();
      await updateResume.cancel();
      throw error;
    }
  },
  ...updatePreview,
});
let usageTray: ReturnType<typeof createAccountUsageTray> | undefined;
let scheduler: SchedulerEngine | undefined;
let schedulerNotifications: ReturnType<typeof createSchedulerNotifications> | undefined;
async function openScheduledRun(run?: ScheduleRun): Promise<void> {
  if (!run) { await openStartupWindow(); return; }
  if (run.workspace === '*') {
    const result = await dialog.showMessageBox({ type: 'info', title: 'Upcoming event', message: run.title,
      detail: new Date(run.plannedAt).toLocaleString(), buttons: ['Got it', 'Later'], defaultId: 0, cancelId: 1 });
    const current = scheduler?.store.run(run.id);
    if (result.response === 0 && current?.status === 'pending' && Date.parse(current.plannedAt) > Date.now()) await scheduler?.act('*', run.id, 'acknowledge');
    return;
  }
  scheduler?.review(run.workspace, run.id);
  await workspaces.reveal(run.workspace);
}
function openSchedulerReview(): void {
  const runs = scheduler?.allRuns() ?? [];
  const input = scheduler?.allAttention().find(item => item.approvals.length || item.inputs.length);
  const run = runs.find(item => item.id === input?.runId) ?? runs.find(item => item.status === 'pending')
    ?? runs.find(item => item.kind === 'task');
  void openScheduledRun(run).catch(reportStartupError);
}
let usagePopoverWindow: BrowserWindow | null = null;
function acquireAccountProfiles() {
  return getCodexAccountProfiles({
    directory: path.join(app.getPath('userData'), 'codex-accounts'),
    defaultHome: process.env.CODEX_HOME?.trim() || path.join(app.getPath('home'), '.codex'),
    cwd: app.getPath('home'), openExternal: url => shell.openExternal(url),
  });
}
const backgroundUsage = createAccountUsageBackground({
  acquire: acquireAccountProfiles,
  update: snapshot => usageTray?.updateBackground(snapshot),
  onError: reportTrayError,
});

const workspaces = new WorkspaceApplication({
  router: new WorkspaceIpcRouter(ipcMain),
  createRuntime: createApplicationRuntime,
  initialRoot: '',
});

function createApplicationRuntime(options: WorkspaceRuntimeOptions) {
  const recovery = updateResume.register(options);
  options.scope.ipc.handle(`${APP_UPDATE_CHANNEL}:get`, () => updates.snapshot());
  options.scope.ipc.handle(`${APP_UPDATE_CHANNEL}:install`, () => updates.install());
  options.scope.ipc.handle(`${APP_UPDATE_CHANNEL}:open`, () => updates.openRelease());
  if (options.managementOnly !== true) {
    options.scope.ipc.handle(`${KEEP_AWAKE_CHANNEL}:get`, () => keepAwake.snapshot());
    options.scope.ipc.handle(`${KEEP_AWAKE_CHANNEL}:set`, (_event, enabled: unknown) => keepAwake.setEnabled(enabled));
  }
  let runtime: ReturnType<typeof createWorkspaceRuntime> | ReturnType<typeof createWorkspaceManagerRuntime>;
  try { runtime = options.managementOnly === true
    ? createWorkspaceManagerRuntime(options, {
      app, dialog, dataRoot: app.getPath('userData'),
      createWindow: (configuration) => new BrowserWindow(configuration),
      rendererUrl: process.env.CHESHI_RENDERER_URL?.trim(),
      trashItem: (root) => shell.trashItem(root), openExternal: (url) => shell.openExternal(url),
      onShown: () => startupScreen.close(),
    }) : createTrackedWorkspace(options); }
  catch (error) { recovery.dispose(); throw error; }
  let unsubscribe: (() => void) | undefined;
  let unsubscribeKeepAwake: (() => void) | undefined;
  return {
    async start() {
      const window = await runtime.start();
      recovery.attach(window);
      unsubscribe = updates.subscribe(state => {
        if (!window.isDestroyed()) window.webContents.send(`${APP_UPDATE_CHANNEL}:changed`, state);
      });
      if (options.managementOnly !== true) {
        const sendKeepAwake = (state: ReturnType<KeepAwakeService['snapshot']>) => {
          if (!window.isDestroyed()) window.webContents.send(`${KEEP_AWAKE_CHANNEL}:changed`, state);
        };
        unsubscribeKeepAwake = keepAwake.subscribe(sendKeepAwake);
        sendKeepAwake(keepAwake.snapshot());
      }
      return window;
    },
    show: () => runtime.show?.(),
    async dispose() { unsubscribeKeepAwake?.(); unsubscribe?.(); recovery.dispose(); await runtime.dispose(); },
  };
}
let quitting = false;
let cleanupComplete = false;
let openingStartupWindow = false;

function createTrackedWorkspace(options: Parameters<typeof createWorkspaceRuntime>[0]) {
  const source = usageTray?.register();
  let settingsIpc: ReturnType<typeof registerSettingsIpc> | undefined;
  let agentManagementIpc: ReturnType<typeof registerAgentManagementIpc> | undefined;
  let agentChatsIpc: ReturnType<typeof registerAgentChatsIpc> | undefined;
  let agentRegistryIpc: ReturnType<typeof registerAgentRegistryIpc> | undefined;
  let discordIpc: ReturnType<typeof registerDiscordIpc> | undefined;
  let notificationIpc: ReturnType<typeof registerIMessageIpc> | undefined;
  let notificationEventsIpc: ReturnType<typeof registerNotificationEventsIpc> | undefined;
  let runtime: ReturnType<typeof createWorkspaceRuntime>;
  try {
    runtime = createWorkspaceRuntime({ ...options, notifications, messageCommands, discord, getTypeSafeKey: apiSettings.getKey,
      getProjectDocMaxBytes: apiSettings.getProjectDocMaxBytes, codeGraphSynchronization,
      voiceChats: request => agentChats.request(options.workspaceRoot, request),
      historyRecall: { enabled: apiSettings.isHistoryRecallEnabled, subscribe: listener => apiSettings.subscribe(() => listener()) },
      accountSelection: apiSettings.workspaceAccountSelection(options.workspaceRoot) }, snapshot => source?.update(snapshot), window => {
      settingsIpc = registerSettingsIpc({ window, ipc: options.scope.ipc, service: apiSettings });
      agentChatsIpc = registerAgentChatsIpc({ window, ipc: options.scope.ipc, workspaceRoot: options.workspaceRoot, service: agentChats });
      agentRegistryIpc = registerAgentRegistryIpc({ window, ipc: options.scope.ipc, registry: agentRegistry, workspaceRoot: options.workspaceRoot,
        testTool: input => specialistRuntime.testTool(options.workspaceRoot, input),
        toolCredential: input => input.action === 'save' ? toolCredentials.save(input.origin, input.name, input.value!)
          : input.action === 'remove' ? toolCredentials.remove(input.origin, input.name) : toolCredentials.status(input.origin, input.name),
        packsDirectory: path.join(app.getPath('userData'), 'homie-packs'),
        exportPackagePath: async name => {
          const result = await dialog.showSaveDialog(window, { title: 'Export Homie pack', defaultPath: name,
            filters: [{ name: 'Homie pack', extensions: ['json'] }] });
          return result.canceled ? null : result.filePath ?? null;
        },
        selectPackage: async () => {
          const result = await dialog.showOpenDialog(window, { title: 'Import Homie pack', defaultPath: options.workspaceRoot,
            properties: ['openFile'], filters: [{ name: 'Homie pack or agent.json', extensions: ['json'] }] });
          return result.canceled ? null : result.filePaths[0] ?? null;
        },
        selectInstructionFiles: async () => {
          const result = await dialog.showOpenDialog(window, { title: 'Link instruction files', defaultPath: options.workspaceRoot,
            properties: ['openFile', 'multiSelections'], filters: [{ name: 'Markdown', extensions: ['md'] }] });
          return result.canceled ? [] : result.filePaths;
        },
        openInstructionFile: async filename => {
          const error = await shell.openPath(filename);
          if (error) throw new Error(`Could not open instruction file: ${error}`);
        },
        remove: request => agentDeletion.agent(options.workspaceRoot, request),
        runtime: request => specialistRuntime.request(options.workspaceRoot, request),
        models: async accountId => {
          const profiles = acquireAccountProfiles();
          try { return await profiles.models(accountId); }
          finally { await profiles.release(); }
        } });
      agentManagementIpc = registerAgentManagementIpc({ window, ipc: options.scope.ipc, service: agentManagement,
        remove: request => agentDeletion.container(request),
        terminal: new AgentTerminalManager({ window, hold: (engine, id) => specialistRuntime.hold(engine, id), engines: agentEngines, workingDirectory: options.workspaceRoot }) });
      notificationEventsIpc = registerNotificationEventsIpc({ window, ipc: options.scope.ipc, service: notificationEvents });
      discordIpc = registerDiscordIpc({ window, ipc: options.scope.ipc, service: discord,
        setup: context => runtime.startDiscordSetup(context, () => createDiscordSetupBrowser({ parent: window,
          createWindow: configuration => new BrowserWindow(configuration), clipboard, settings: discord,
          confirm: (preferences, signal) => discordIpc?.confirm(preferences, signal) ?? Promise.resolve(false) })) });
      notificationIpc = registerIMessageIpc({ window, ipc: options.scope.ipc, service: notifications, commands: messageCommands });
    });
  }
  catch (error) { source?.dispose(); throw error; }
  return {
    async start() {
      try {
        const window = await runtime.start();
        source?.attach(window);
        return window;
      }
      catch (error) { source?.dispose(); throw error; }
    },
    show: () => runtime.show(),
    async dispose() {
      try { agentChatsIpc?.dispose(); agentRegistryIpc?.dispose(); agentManagementIpc?.dispose(); notificationEventsIpc?.dispose(); discordIpc?.dispose(); notificationIpc?.dispose(); settingsIpc?.dispose(); }
      finally { try { await runtime.dispose(); } finally { source?.dispose(); } }
    },
  };
}

async function openStartupWindow(): Promise<void> {
  if (openingStartupWindow || quitting) return;
  openingStartupWindow = true;
  try {
    const root = resolveStartupWorkspace({
      dataRoot: app.getPath('userData'),
      workspaceRoot: workspaces.lastWorkspaceRoot || process.env.CHESHI_WORKSPACE,
      fallbackRoot: app.isPackaged ? undefined : path.resolve(process.cwd()),
    });
    await startupScreen.setStatus('Checking setup and sign-in…');
    const restore = root && await canRestoreStartupWorkspace({
      getToolStatus: getWorkspaceToolStatus,
      createLogin: () => createWorkspaceCodexLoginService({
        cwd: app.getPath('userData'), openExternal: (url) => shell.openExternal(url),
      }),
    });
    if (quitting) return;
    if (root && restore) await workspaces.open(root);
    else await workspaces.openManager();
  } finally { openingStartupWindow = false; }
}

function reportStartupError(error: unknown): void {
  startupScreen.close();
  process.stderr.write(`[cheshi] Workspace startup failed: ${String(error)}\n`);
  dialog.showErrorBox(`${product.displayName} could not open the workspace`, error instanceof Error ? error.message : String(error));
}

function reportTrayError(error: unknown): void {
  process.stderr.write(`[cheshi] Menu bar usage indicator failed: ${String(error)}\n`);
}

app.whenReady().then(async () => {
  configureSchedulerDesktop({
    startup: () => ({ enabled: process.platform === 'darwin' && app.getLoginItemSettings().openAtLogin,
      available: process.platform === 'darwin' && app.isPackaged }),
    setStartup(enabled) {
      if (process.platform !== 'darwin' || !app.isPackaged) throw new Error('Login startup is available in the installed macOS app.');
      app.setLoginItemSettings({ openAtLogin: enabled });
    },
  });
  powerMonitor.on('suspend', suspendScheduler);
  powerMonitor.on('resume', resumeScheduler);
  updates.start();
  powerMonitor.on('resume', () => { void updates.resume(); });
  autoUpdater.on('error', error => process.stderr.write(`[cheshi] Update installation failed: ${String(error)}\n`));
  if (!updatePreview) {
    void appUpdateUnavailableReason({ packaged: app.isPackaged, platform: process.platform, executable: process.execPath })
      .then(reason => updates.setUnavailableReason(reason));
  }
  const applicationMenu = Menu.getApplicationMenu();
  if (applicationMenu) {
    const openHelp = createHelpMenuAction({ focused: () => BrowserWindow.getFocusedWindow(), windows: () => workspaces.readyWindows,
      openManager: () => workspaces.openManager() });
    const template = helpMenuTemplate(aboutMenuTemplate(applicationMenu.items, product.displayName, aboutWindow.open, items => Menu.buildFromTemplate(items)),
      () => { void openHelp().catch(error => dialog.showErrorBox('Cheshi Help', String(error))); }, items => Menu.buildFromTemplate(items));
    template.push({ label: 'Notes', submenu: [
      { label: 'New Note', accelerator: STICKY_NOTES_SHORTCUT, registerAccelerator: false,
        click: () => { void stickyNotes.create().catch(error => dialog.showErrorBox('Cheshi Notes', String(error))); } },
      { label: 'All Notes', accelerator: STICKY_NOTES_LIST_SHORTCUT, registerAccelerator: false,
        click: () => { void stickyNotes.openList().catch(error => dialog.showErrorBox('Cheshi Notes', String(error))); } },
    ] });
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }
  stickyNotes.start();
  if (process.platform === 'darwin') {
    try { usageTray = createAccountUsageTray({
      createTray: image => new Tray(image), createMenu: template => Menu.buildFromTemplate(template),
      createPopover: (tray, showApp) => createAccountUsagePopover({
        createWindow: configuration => {
          const window = new BrowserWindow(configuration);
          usagePopoverWindow = window;
          window.once('closed', () => { if (usagePopoverWindow === window) usagePopoverWindow = null; });
          return window;
        }, ipc: ipcMain,
        getAnchor: () => tray.getBounds(), getWorkArea: anchor => screen.getDisplayMatching(anchor).workArea,
        rendererUrl: process.env.CHESHI_RENDERER_URL?.trim() || pathToFileURL(app.isPackaged
          ? path.join(process.resourcesPath, 'dist', 'index.html')
          : path.join(import.meta.dirname, 'frontend', 'dist', 'index.html')).href,
        preload: usagePopoverPreload,
        appearanceFile: path.join(app.getPath('userData'), 'appearance.json'),
        showApp, openScheduler: openSchedulerReview, quit: () => app.quit(), onError: reportTrayError,
      }),
      images: nativeImage, theme: nativeTheme,
      loadFont: loadMenuBarFont,
      logo: loadMenuBarLogo(nativeImage),
      openApp: () => {
        const window = BrowserWindow.getAllWindows().find(candidate => !candidate.isDestroyed()
          && candidate !== usagePopoverWindow);
        if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); }
        else void openStartupWindow().catch(reportStartupError);
      },
      quit: () => app.quit(),
      onError: reportTrayError,
    }); } catch (error) { reportTrayError(error); }
  }
  if (usageTray) backgroundUsage.start();
  const dataRoot = resolveCodeGraphDataRoot() ?? app.getPath('userData');
  const commands = createCodeGraphCommands({ packaged: app.isPackaged, resourcesPath: process.resourcesPath,
    rootDirectory: path.resolve(import.meta.dirname, '..'), bunExecutable: process.env.CHESHI_BUN });
  scheduler = await startScheduler({ userDataDirectory: app.getPath('userData'), home: app.getPath('home'),
    openExternal: url => shell.openExternal(url), codeGraph: { cli: commands.cli(), dataRoot, synchronization: codeGraphSynchronization },
    historyDirectory: workspace => path.join(path.dirname(codeGraphStorageDirectory(dataRoot, workspace)), 'chat-history-index'),
    accountSelection: apiSettings.workspaceAccountSelection, getKey: apiSettings.getKey,
    getProjectDocMaxBytes: apiSettings.getProjectDocMaxBytes,
    access: { enabled: apiSettings.isHistoryRecallEnabled, subscribe: listener => apiSettings.subscribe(() => listener()) } });
  schedulerNotifications = createSchedulerNotifications({ engine: scheduler,
    shouldNotify: run => !workspaces.hasFocusedWorkspace(run.workspace === '*' ? undefined : run.workspace),
    open: run => { void openScheduledRun(run).catch(reportStartupError); },
    summary: value => usageTray?.updateScheduler(value),
    notify(title, body, open) {
      if (!Notification.isSupported()) return () => {};
      const notification = new Notification({ title, body, silent: false });
      notification.on('click', open); notification.on('failed', (_event, error) => reportTrayError(error)); notification.show();
      return () => { notification.removeAllListeners(); notification.close(); };
    },
  });
  if (process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin) { startupScreen.close(); return; }
  const resumeWindows = await updateResume.load().catch(error => {
    process.stderr.write(`[cheshi] Could not load update recovery: ${String(error)}\n`);
    return [];
  });
  if (resumeWindows.length) {
    for (const saved of resumeWindows) {
      if (saved.managementOnly) await workspaces.openManager();
      else await workspaces.open(saved.root, saved.windowState);
    }
  } else await openStartupWindow();
}).catch(reportStartupError);

app.on('activate', () => {
  if (!quitting && !workspaces.hasWorkspaces && !workspaces.isTransitioning) {
    void openStartupWindow().catch(reportStartupError);
  }
});
app.on('before-quit', (event) => {
  if (cleanupComplete) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  void stickyNotes.prepareToQuit().then(() => workspaces.closeAll()).then(async () => {
    schedulerNotifications?.dispose();
    await stopScheduler();
    await keepAwake.dispose();
    await discord.dispose(); await messageCommands.dispose(); await notifications.dispose();
    await backgroundUsage.dispose().catch(reportTrayError);
    usageTray?.dispose();
    aboutWindow.dispose();
    stickyNotes.dispose();
    updates.dispose();
    cleanupComplete = true;
    app.quit();
  }).catch((error: unknown) => {
    quitting = false;
    stickyNotes.resume();
    if (error instanceof WorkspaceWindowCloseCancelledError) return;
    dialog.showErrorBox(`${product.displayName} could not close`, error instanceof Error ? error.message : String(error));
  });
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !quitting && !workspaces.isTransitioning) app.quit();
});
