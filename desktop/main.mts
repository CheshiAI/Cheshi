import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, session, shell, Tray, WebContentsView } from 'electron';
import { product } from '../config/product.mts';
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

process.env.PATH = desktopToolPath(process.env.PATH);
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
  createRuntime: (options) => options.managementOnly === true
    ? createWorkspaceManagerRuntime(options, {
      app, dialog, dataRoot: app.getPath('userData'),
      createWindow: (configuration) => new BrowserWindow(configuration),
      rendererUrl: process.env.CHESHI_RENDERER_URL?.trim(),
      trashItem: (root) => shell.trashItem(root), openExternal: (url) => shell.openExternal(url),
      onShown: () => startupScreen.close(),
    }) : createTrackedWorkspace(options),
  initialRoot: '',
});
let quitting = false;
let cleanupComplete = false;
let openingStartupWindow = false;

function createTrackedWorkspace(options: Parameters<typeof createWorkspaceRuntime>[0]) {
  const source = usageTray?.register();
  let showcase: ReturnType<typeof createShowcaseBrowser> | undefined;
  let runtime: ReturnType<typeof createWorkspaceRuntime>;
  try { runtime = createWorkspaceRuntime(options, snapshot => source?.update(snapshot)); }
  catch (error) { source?.dispose(); throw error; }
  if (usageTray) backgroundUsage.start();
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
    // Keep the startup screen visible for development layout review.
    if (!quitting && !app.isPackaged && startupScreen.isOpen) await delay(2_000);
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
  app.setAboutPanelOptions({
    applicationName: product.displayName, applicationVersion: product.version,
    version: product.buildNumber, copyright: `© ${new Date().getFullYear()} ${product.publisher}`,
  });
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
  await openStartupWindow();
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
