import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { app, autoUpdater, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, powerMonitor, session, shell, Tray, WebContentsView } from 'electron';
import { product } from '../config/product.mts';
import { aboutBackgroundColor, aboutPage } from './lib/about-page.mts';
import { createAboutWindow } from './lib/about-window.mts';
import { aboutMenuTemplate } from './lib/about-menu.mts';
import { startupScreen } from './lib/startup-screen.mts';
import { WorkspaceApplication, WorkspaceWindowCloseCancelledError } from './lib/workspace-application.mts';
import { WorkspaceIpcRouter } from './lib/workspace-ipc-router.mts';
import { createWorkspaceRuntime } from './workspace-runtime.mts';
import { createWorkspaceManagerRuntime } from './lib/workspace-manager-runtime.mts';
import { canRestoreStartupWorkspace, resolveStartupWorkspace } from './lib/workspace-startup.mts';
import { createWorkspaceCodexLoginService } from './lib/workspace-codex-login.mts';
import { desktopToolPath, getWorkspaceToolStatus } from './lib/workspace-tool-status.mts';
import { createAccountUsageTray } from './lib/account-usage-tray.mts';
import { loadMenuBarFont } from './lib/menu-bar-font.mts';
import { loadMenuBarLogo } from './lib/menu-bar-logo.mts';
import { createAccountUsageBackground } from './lib/account-usage-background.mts';
import { getCodexAccountProfiles } from './lib/codex-account-profiles.mts';
import { createShowcaseBrowser } from './lib/showcase-browser.mts';
import { findAppRelease } from './lib/app-release-checker.mts';
import { createAppUpdateService } from './lib/app-update-service.mts';
import { createAppUpdatePreview } from './lib/app-update-preview.mts';
import { appUpdateUnavailableReason, stageAppUpdate } from './lib/app-update-installer.mts';
import { createAppUpdateResume } from './lib/app-update-resume.mts';
import { APP_UPDATE_CHANNEL } from './shared/app-update.ts';
import type { WorkspaceRuntimeOptions } from './lib/workspace-application.mts';

process.env.PATH = desktopToolPath(process.env.PATH);
const aboutWindow = createAboutWindow({
  title: `About ${product.displayName}`,
  backgroundColor: aboutBackgroundColor,
  createWindow: options => new BrowserWindow(options),
  page: () => aboutPage({ name: product.displayName, version: product.version, buildNumber: product.buildNumber, publisher: product.publisher }),
  onError: error => process.stderr.write(`[cheshi] About window failed: ${String(error)}\n`),
});
const updateResume = createAppUpdateResume(path.join(app.getPath('userData'), 'updates'));
const updatePreview = createAppUpdatePreview({ packaged: app.isPackaged, setting: process.env.CHESHI_UPDATE_PREVIEW });
const updates = createAppUpdateService({
  currentVersion: product.version,
  unavailableReason: 'Checking update installation support…',
  check: signal => findAppRelease({ currentVersion: product.version, platform: process.platform, arch: process.arch, signal }),
  openExternal: url => shell.openExternal(url),
  onCheckError: error => process.stderr.write(`[cheshi] Update check failed: ${String(error)}\n`),
  async install(release, installing) {
    const reason = await appUpdateUnavailableReason({ packaged: app.isPackaged, platform: process.platform, executable: process.execPath });
    if (reason) throw new Error(reason);
    if (quitting || workspaces.isTransitioning) throw new Error('Wait for the workspace operation to finish before updating.');
    try {
      await updateResume.prepare();
      await stageAppUpdate(autoUpdater, release);
      await updateResume.prepare();
      await updateResume.activate();
      installing();
      quitting = true;
      await workspaces.closeAll();
      await backgroundUsage.dispose().catch(reportTrayError);
      usageTray?.dispose();
      aboutWindow.close();
      cleanupComplete = true;
      updates.dispose();
      autoUpdater.quitAndInstall();
    } catch (error) {
      quitting = false;
      await updateResume.cancel();
      throw error;
    }
  },
  ...updatePreview,
});
let usageTray: ReturnType<typeof createAccountUsageTray> | undefined;
const backgroundUsage = createAccountUsageBackground({
  acquire: () => getCodexAccountProfiles({
    directory: path.join(app.getPath('userData'), 'codex-accounts'),
    defaultHome: process.env.CODEX_HOME?.trim() || path.join(app.getPath('home'), '.codex'),
    cwd: app.getPath('home'), openExternal: url => shell.openExternal(url),
  }),
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
  return {
    async start() {
      const window = await runtime.start();
      recovery.attach(window);
      unsubscribe = updates.subscribe(state => {
        if (!window.isDestroyed()) window.webContents.send(`${APP_UPDATE_CHANNEL}:changed`, state);
      });
      return window;
    },
    show: () => runtime.show?.(),
    async dispose() { unsubscribe?.(); recovery.dispose(); await runtime.dispose(); },
  };
}
let quitting = false;
let cleanupComplete = false;
let openingStartupWindow = false;

function createTrackedWorkspace(options: Parameters<typeof createWorkspaceRuntime>[0]) {
  const source = usageTray?.register();
  let showcase: ReturnType<typeof createShowcaseBrowser> | undefined;
  let runtime: ReturnType<typeof createWorkspaceRuntime>;
  try { runtime = createWorkspaceRuntime(options, snapshot => source?.update(snapshot)); }
  catch (error) { source?.dispose(); throw error; }
  return {
    async start() {
      try {
        const window = await runtime.start();
        source?.attach(window);
        showcase ??= createShowcaseBrowser({
          window, ipc: options.scope.ipc,
          createView: configuration => new WebContentsView(configuration),
          session: session.fromPartition(`cheshi-showcase-${window.webContents.id}`),
          openExternal: url => shell.openExternal(url),
        });
        return window;
      }
      catch (error) { source?.dispose(); throw error; }
    },
    show: () => runtime.show(),
    async dispose() {
      try { showcase?.dispose(); }
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
    const remainingDisplayMs = startupScreen.remainingMinimumDisplayMs;
    if (!quitting && remainingDisplayMs > 0) await delay(remainingDisplayMs);
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
  updates.start();
  powerMonitor.on('resume', () => { void updates.resume(); });
  autoUpdater.on('error', error => process.stderr.write(`[cheshi] Update installation failed: ${String(error)}\n`));
  if (!updatePreview) {
    void appUpdateUnavailableReason({ packaged: app.isPackaged, platform: process.platform, executable: process.execPath })
      .then(reason => updates.setUnavailableReason(reason));
  }
  const applicationMenu = Menu.getApplicationMenu();
  if (applicationMenu) Menu.setApplicationMenu(Menu.buildFromTemplate(aboutMenuTemplate(applicationMenu.items, product.displayName, aboutWindow.open, template => Menu.buildFromTemplate(template))));
  if (process.platform === 'darwin') {
    try { usageTray = createAccountUsageTray({
      createTray: image => new Tray(image), createMenu: template => Menu.buildFromTemplate(template),
      images: nativeImage, theme: nativeTheme,
      loadFont: loadMenuBarFont,
      logo: loadMenuBarLogo(nativeImage),
      openApp: () => {
        const window = BrowserWindow.getAllWindows().find(candidate => !candidate.isDestroyed());
        if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); }
        else void openStartupWindow().catch(reportStartupError);
      },
      quit: () => app.quit(),
      onError: reportTrayError,
    }); } catch (error) { reportTrayError(error); }
  }
  if (usageTray) backgroundUsage.start();
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
  void workspaces.closeAll().then(async () => {
    await backgroundUsage.dispose().catch(reportTrayError);
    usageTray?.dispose();
    aboutWindow.dispose();
    updates.dispose();
    cleanupComplete = true;
    app.quit();
  }).catch((error: unknown) => {
    quitting = false;
    if (error instanceof WorkspaceWindowCloseCancelledError) return;
    dialog.showErrorBox(`${product.displayName} could not close`, error instanceof Error ? error.message : String(error));
  });
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !quitting && !workspaces.isTransitioning) app.quit();
});
