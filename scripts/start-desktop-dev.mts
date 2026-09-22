import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { FSWatcher } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { forwardDesktopDevOutput } from './forward-desktop-dev-output.mts';
import { buildDesktopPreload } from './build-desktop-preload.mts';
import { buildAppleCalendar } from './build-apple-calendar.mts';
import { prepareCalendarDevelopment } from './prepare-calendar-development.mts';
import { launchDevelopmentApp } from './launch-development-app.mts';
import { watchFileContents } from './watch-file-contents.mts';
import { createDevelopmentShutdownRequest, DEVELOPMENT_SHUTDOWN_DIRECTORY, stopDevelopmentProcess } from '../desktop/lib/development-shutdown.mts';

const rootDirectory = fileURLToPath(new URL('..', import.meta.url));
const frontendDirectory = path.join(rootDirectory, 'desktop', 'frontend');
const frontendRequire = createRequire(path.join(frontendDirectory, 'package.json'));
const viteDirectory = path.dirname(frontendRequire.resolve('vite/package.json'));
const viteCli = path.join(viteDirectory, 'bin', 'vite.js');
const hostname = '127.0.0.1';
const localServerProtocol = 'http:';
const preloadSourcePath = path.join(rootDirectory, 'desktop', 'preload.cts');
const rendererReadinessSourcePath = path.join(rootDirectory, 'desktop', 'lib', 'renderer-readiness.mts');
let startupStartedAt = Math.round(performance.timeOrigin);

function logStartup(phase: string): void {
  process.stdout.write(`[cheshi] Startup ${phase}: ${Date.now() - startupStartedAt} ms\n`);
}

interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

let viteProcess: ChildProcess | null = null;
let forgeProcess: ChildProcess | null = null;
let viteCompletion: Promise<ProcessResult> | null = null;
let forgeCompletion: Promise<ProcessResult> | null = null;
let shuttingDown = false;
let shutdownPromise: Promise<void> | null = null;
let sourceWatchers: FSWatcher[] = [];
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let restartRequested = false;
let preloadBuildQueue = Promise.resolve();
let forgeShutdownRequest: ReturnType<typeof createDevelopmentShutdownRequest> | null = null;
let forgeStopping: Promise<void> | null = null;
let developmentBundle: string | undefined;
let signalApp: ((signal: 'SIGTERM' | 'SIGKILL') => void) | null = null;

function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, hostname, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not allocate a development port.'));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

function signalProcess(child: ChildProcess, signal: 'SIGTERM' | 'SIGKILL', processGroup = false): void {
  if (processGroup && process.platform !== 'win32' && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child if its process group is already gone.
    }
  }
  if (child.exitCode === null && child.signalCode === null) child.kill(signal);
}

function stopForge(): Promise<void> {
  if (forgeStopping) return forgeStopping;
  const child = forgeProcess;
  const request = forgeShutdownRequest;
  if (!child || !forgeCompletion) return Promise.resolve();
  forgeStopping = stopDevelopmentProcess({
    completion: forgeCompletion,
    requestQuit: () => request?.request(),
    signal: (signal) => signalApp ? signalApp(signal) : signalProcess(child, signal, true),
  });
  return forgeStopping;
}

function restoreTerminal(): void {
  if (!process.stdout.isTTY) return;
  process.stdout.write('\u001B[0m\u001B[?25h');
}

function shutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  for (const watcher of sourceWatchers) watcher.close();
  sourceWatchers = [];
  if (restartTimer !== null) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  shutdownPromise = (async () => {
    try { await stopForge(); }
    finally {
      if (viteProcess && viteCompletion) {
        const child = viteProcess;
        await stopDevelopmentProcess({
          completion: viteCompletion, requestQuit: () => signalProcess(child, 'SIGTERM', true),
          signal: (signal) => signalProcess(child, signal, true), graceMs: 1_000,
        });
      }
    }
  })().catch((error: unknown) => {
    process.exitCode = 1;
    process.stderr.write(`[cheshi] Shutdown failed: ${String(error)}\n`);
  }).finally(() => {
    forgeShutdownRequest?.dispose();
    restoreTerminal();
  });
  return shutdownPromise;
}

function waitForServer(url: string, child: ChildProcess): Promise<void> {
  return (async () => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (shuttingDown) return;
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Vite exited before becoming ready (code ${child.exitCode}).`);
      }
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
        if (response.ok) return;
      } catch {
        // Vite is still starting.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Vite did not start within 30 seconds.');
  })();
}

function waitForClose(child: ChildProcess): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

function childEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CI: '1',
    FORCE_COLOR: '0',
    TERM: 'dumb',
    ...extra,
  };
}

function scheduleForgeRestart(changedPath: string): void {
  if (shuttingDown) return;
  restartRequested = true;
  if (restartTimer !== null) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (shuttingDown) return;
    process.stdout.write(`[cheshi] Restarting Electron after ${path.relative(rootDirectory, changedPath)} changed\n`);
    void stopForge().catch((error: unknown) => {
      process.stderr.write(`[cheshi] Restart failed: ${String(error)}\n`);
      void shutdown();
    });
  }, 150);
}

function handleMainSourceChange(changedPath: string): void {
  if (![preloadSourcePath, rendererReadinessSourcePath,
    path.join(rootDirectory, 'desktop', 'lib', 'window-appearance-preload.cts'),
    path.join(rootDirectory, 'desktop', 'shared', 'window-appearance.ts'),
    path.join(rootDirectory, 'desktop', 'lib', 'apple-mail-preload.cts'),
    path.join(rootDirectory, 'desktop', 'shared', 'apple-mail.ts'),
    path.join(rootDirectory, 'desktop', 'lib', 'apple-calendar-preload.cts'),
    path.join(rootDirectory, 'desktop', 'shared', 'apple-calendar.ts'),
    path.join(rootDirectory, 'desktop', 'lib', 'settings-preload.cts'),
    path.join(rootDirectory, 'desktop', 'lib', 'workspace-feature-preload.cts'),
    path.join(rootDirectory, 'desktop', 'shared', 'settings.ts'),
    path.join(rootDirectory, 'desktop', 'lib', 'app-update-preload.cts'),
    path.join(rootDirectory, 'desktop', 'shared', 'app-update.ts')].includes(changedPath)) {
    scheduleForgeRestart(changedPath);
    return;
  }

  preloadBuildQueue = preloadBuildQueue
    .catch(() => undefined)
    .then(async () => {
      if (shuttingDown) return;
      await buildDesktopPreload();
      scheduleForgeRestart(changedPath);
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `[cheshi] ${error instanceof Error ? error.message : String(error)}\n`,
      );
    });
}

function watchMainSources(): FSWatcher[] {
  const sourcePaths = [
    ...['window-appearance.mts', 'window-appearance-store.mts', 'window-appearance-preload.cts']
      .map(name => path.join(rootDirectory, 'desktop', 'lib', name)),
    path.join(rootDirectory, 'desktop', 'shared', 'window-appearance.ts'),
    ...['apple-mail-service.mts', 'apple-mail-script.mts', 'apple-mail-process.mts', 'apple-mail-ipc.mts', 'apple-mail-preload.cts']
      .map(name => path.join(rootDirectory, 'desktop', 'lib', name)),
    path.join(rootDirectory, 'desktop', 'shared', 'apple-mail.ts'),
    ...['apple-calendar-service.mts', 'apple-calendar-process.mts', 'apple-calendar-ipc.mts', 'apple-calendar-preload.cts']
      .map(name => path.join(rootDirectory, 'desktop', 'lib', name)),
    path.join(rootDirectory, 'desktop', 'shared', 'apple-calendar.ts'),
    path.join(rootDirectory, 'desktop', 'bootstrap.mts'),
    path.join(rootDirectory, 'desktop', 'lib', 'development-shutdown.mts'),
    path.join(rootDirectory, 'desktop', 'main.mts'),
    ...['typesafe-key.mts', 'typesafe-connection.mts', 'settings-service.mts', 'settings-ipc.mts', 'settings-preload.cts', 'workspace-feature-preload.cts'].map(name => path.join(rootDirectory, 'desktop', 'lib', name)),
    path.join(rootDirectory, 'desktop', 'shared', 'settings.ts'),
    ...['app-release-checker.mts', 'app-update-service.mts', 'app-update-preview.mts', 'app-update-resume.mts',
      'app-update-download.mts', 'app-update-installer.mts', 'app-update-preload.cts']
      .map(name => path.join(rootDirectory, 'desktop', 'lib', name)),
    path.join(rootDirectory, 'desktop', 'shared', 'app-update.ts'),
    path.join(rootDirectory, 'desktop', 'workspace-runtime.mts'),
    path.join(rootDirectory, 'desktop', 'lib', 'startup-page.mts'),
    path.join(rootDirectory, 'desktop', 'lib', 'startup-screen.mts'),
    path.join(rootDirectory, 'resources', 'icons', 'startup-logo.png'),
    path.join(rootDirectory, 'desktop', 'frontend', 'src', 'shared', 'styles', 'tokens.css'),
    preloadSourcePath,
    rendererReadinessSourcePath,
    path.join(rootDirectory, 'desktop', 'workspace-manager-preload.cts'),
    path.join(rootDirectory, 'desktop', 'lib', 'workspace-manager-window.mts'),
    path.join(rootDirectory, 'desktop', 'backend', 'codegraph-host.ts'),
    path.join(rootDirectory, 'desktop', 'lib', 'chat-attachment-store.mts'),
    path.join(rootDirectory, 'desktop', 'lib', 'codegraph-service.mts'),
    path.join(rootDirectory, 'desktop', 'lib', 'codegraph-initial-index.mts'),
    path.join(rootDirectory, 'desktop', 'lib', 'codex-account-service.mts'),
    path.join(rootDirectory, 'desktop', 'lib', 'codex-app-server-client.mts'),
    path.join(rootDirectory, 'desktop', 'lib', 'codex-chat-service.mts'),
    path.join(rootDirectory, 'desktop', 'lib', 'codex-mcp-recovery.mts'),
    path.join(rootDirectory, 'desktop', 'lib', 'codex-service-utils.mts'),
    path.join(rootDirectory, 'desktop', 'lib', 'ghostty-surface-host.mts'),
    path.join(rootDirectory, 'desktop', 'lib', 'git-service.mts'),
    path.join(rootDirectory, 'desktop', 'lib', 'json-rpc-client-utils.mts'),
    path.join(rootDirectory, 'desktop', 'lib', 'language-server-client.mts'),
    path.join(rootDirectory, 'desktop', 'lib', 'language-server-manager.mts'),
    path.join(rootDirectory, 'desktop', 'lib', 'language-server-runtime.mts'),
    path.join(rootDirectory, 'desktop', 'lib', 'plugin-logo-service.mts'),
    path.join(rootDirectory, 'desktop', 'lib', 'terminal-controller.mts'),
    path.join(rootDirectory, 'desktop', 'lib', 'workspace-file-service.mts'),
    path.join(rootDirectory, 'desktop', 'lib', 'workspace-management-ipc.mts'),
    path.join(rootDirectory, 'desktop', 'lib', 'workspace-management-service.mts'),
    path.join(rootDirectory, 'desktop', 'lib', 'workspace-deletion.mts'),
    path.join(rootDirectory, 'desktop', 'lib', 'github-repositories.mts'),
    path.join(rootDirectory, 'desktop', 'lib', 'github-login-service.mts'),
    path.join(rootDirectory, 'desktop', 'lib', 'workspace-management-preload.cts'),
    path.join(rootDirectory, 'desktop', 'lib', 'workspace-application.mts'),
    path.join(rootDirectory, 'desktop', 'lib', 'workspace-manager-runtime.mts'),
    path.join(rootDirectory, 'desktop', 'lib', 'workspace-startup.mts'),
    path.join(rootDirectory, 'desktop', 'lib', 'workspace-tool-status.mts'),
    path.join(rootDirectory, 'desktop', 'lib', 'workspace-codex-login.mts'),
    path.join(rootDirectory, 'desktop', 'lib', 'workspace-ipc-router.mts'),
    path.join(rootDirectory, 'desktop', 'lib', 'workspace-renderer-events.mts'),
    path.join(rootDirectory, 'desktop', 'shared', 'workspace-management.ts'),
    path.join(rootDirectory, 'config', 'product.mts'),
    path.join(rootDirectory, 'config', 'workspace-storage.mts'),
    path.join(rootDirectory, 'codegraph', 'src', 'directory.ts'),
    path.join(rootDirectory, '.env.product'),
    path.join(rootDirectory, 'forge.config.mts'),
  ];
  return watchFileContents(sourcePaths, handleMainSourceChange);
}

function trackProcessOutput(child: ChildProcess): Promise<ProcessResult> {
  forwardDesktopDevOutput(child.stdout, process.stdout);
  forwardDesktopDevOutput(child.stderr, process.stderr);
  return waitForClose(child);
}

function spawnForge(url: string, apiPort: number): Promise<ProcessResult> {
  logStartup(developmentBundle ? 'launching Cheshi Development' : 'launching electron forge');
  forgeStopping = null;
  forgeShutdownRequest?.dispose();
  forgeShutdownRequest = createDevelopmentShutdownRequest();
  const env = childEnvironment({
    CHESHI_RENDERER_URL: url,
    CHESHI_DEV_STARTED_AT: String(startupStartedAt),
    CHESHI_VIEWER_API_ONLY: '1',
    CHESHI_VIEWER_API_PORT: String(apiPort),
    [DEVELOPMENT_SHUTDOWN_DIRECTORY]: forgeShutdownRequest.directory,
  });
  if (developmentBundle) {
    const launched = launchDevelopmentApp({ bundle: developmentBundle, root: rootDirectory,
      directory: forgeShutdownRequest.directory, env });
    forgeProcess = launched.child;
    forgeCompletion = launched.completion;
    signalApp = launched.signal;
    return forgeCompletion;
  }
  signalApp = null;
  forgeProcess = spawn(process.execPath, ['x', 'electron-forge', 'start'], {
    cwd: rootDirectory,
    detached: process.platform !== 'win32',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  forgeCompletion = trackProcessOutput(forgeProcess);
  return forgeCompletion;
}

async function runForge(url: string, apiPort: number): Promise<ProcessResult> {
  while (!shuttingDown) {
    const result = await spawnForge(url, apiPort);
    await forgeStopping;
    if (shuttingDown) return result;
    if (restartRequested) {
      restartRequested = false;
      startupStartedAt = Date.now();
      continue;
    }
    return result;
  }
  return { code: 0, signal: null };
}

process.once('SIGINT', () => {
  void shutdown();
});
process.once('SIGTERM', () => {
  void shutdown();
});

async function startDevelopment(): Promise<void> {
  logStartup('preparing preload');
  await buildDesktopPreload();
  if (shuttingDown) return;
  await buildAppleCalendar();
  if (shuttingDown) return;
  developmentBundle = prepareCalendarDevelopment();
  if (shuttingDown) return;
  logStartup('preload ready');

  const apiPort = await reservePort();
  if (shuttingDown) return;
  const vitePort = await reservePort();
  if (shuttingDown) return;
  const apiUrl = `${localServerProtocol}//${hostname}:${apiPort}`;
  const url = `${localServerProtocol}//${hostname}:${vitePort}`;

  viteProcess = spawn(process.execPath, [viteCli, '--host', hostname, '--port', String(vitePort), '--strictPort'], {
    cwd: frontendDirectory,
    detached: process.platform !== 'win32',
    env: childEnvironment({ CHESHI_VIEWER_API_URL: apiUrl }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  viteCompletion = trackProcessOutput(viteProcess);

  await waitForServer(url, viteProcess);
  if (shuttingDown) return;
  logStartup('vite ready');
  process.stdout.write(`[cheshi] Vite ready at ${url}\n`);

  sourceWatchers = watchMainSources();

  const result = await Promise.race([viteCompletion, runForge(url, apiPort)]);
  if (!shuttingDown && result.code !== 0) {
    process.exitCode = 1;
  }
}

try {
  await startDevelopment();
} catch (error) {
  if (!shuttingDown) {
    process.stderr.write(`[cheshi] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
} finally {
  await shutdown();
}
