import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog } from 'electron';
import { product } from '../config/product.mts';
import { CODEGRAPH_DATA_ROOT_ENV, resolveCheshiUserDataDirectory } from '../config/workspace-storage.mts';
import { shouldShowStartupScreen, startupScreen } from './lib/startup-screen.mts';
import { DEVELOPMENT_SHUTDOWN_DIRECTORY, watchDevelopmentShutdown } from './lib/development-shutdown.mts';

// Configure storage before any BrowserWindow creates its Chromium session.
app.setName(product.displayName);
const commandLineUserDataDirectory = app.commandLine.getSwitchValue('user-data-dir').trim();
if (commandLineUserDataDirectory && !path.isAbsolute(commandLineUserDataDirectory)) {
  throw new Error('--user-data-dir must use an absolute path.');
}
const userDataDirectory = commandLineUserDataDirectory
  ? path.resolve(commandLineUserDataDirectory)
  : resolveCheshiUserDataDirectory(product.dataDirectory, { homeDirectory: app.getPath('home') });
app.setPath('userData', userDataDirectory);
mkdirSync(userDataDirectory, { recursive: true });
process.env[CODEGRAPH_DATA_ROOT_ENV] = userDataDirectory;

let quitting = false;
app.on('before-quit', () => {
  quitting = true;
  startupScreen.close();
});

if (!app.isPackaged) {
  const stopWatching = watchDevelopmentShutdown(process.env[DEVELOPMENT_SHUTDOWN_DIRECTORY], () => {
    void app.whenReady().then(() => app.quit());
  });
  app.once('will-quit', stopWatching);
}

void app.whenReady().then(async () => {
  if (quitting) return;
  if (process.platform === 'darwin') {
    app.dock?.setIcon(fileURLToPath(new URL('../resources/icons/app-icon.png', import.meta.url)));
  }
  if (shouldShowStartupScreen()) {
    const window = new BrowserWindow({
      show: false,
      width: 300,
      height: 300,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      title: product.displayName,
      backgroundColor: '#101419',
      titleBarStyle: 'hiddenInset',
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const shown = await startupScreen.open(window, {
      name: product.displayName,
      version: product.version,
      onCancel: () => app.quit(),
    });
    if (!shown || quitting) return;
  }
  // Defer service imports until the initial splash is ready, when shown.
  await import('./main.mts');
}).catch((error: unknown) => {
  startupScreen.close();
  if (quitting) return;
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`[cheshi] Bootstrap failed: ${message}\n`);
  dialog.showErrorBox(`${product.displayName} could not start`, message);
  app.quit();
});
