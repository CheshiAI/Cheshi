import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const electronPath = createRequire(import.meta.url)('electron') as string;
const preloadPath = fileURLToPath(new URL('../runtime/workspace-manager-preload.cjs', import.meta.url));
const rendererPath = fileURLToPath(new URL('../frontend/dist/index.html', import.meta.url));

// Explicit integration suite: isolated hidden windows, never the running app.
test('real Electron opens the built Workspaces renderer without an initial project', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cheshi-manager-bridge-'));
  const mainPath = path.join(directory, 'main.cjs');
  try {
    await writeFile(mainPath, `
const { app, BrowserWindow, ipcMain } = require('electron');
app.on('window-all-closed', () => {});
app.setPath('userData', ${JSON.stringify(path.join(directory, 'user-data'))});
app.commandLine.appendSwitch('disable-gpu');
app.whenReady().then(async () => {
  app.dock?.hide();
  let listCalls = 0;
  let accountChecks = 0;
  let failure = '';
  const readySnapshots = new Map();
  ipcMain.handle('cheshi:workspace-management:content-ready', async (event) => {
    const snapshot = await event.sender.executeJavaScript('({ setup: !!document.querySelector("code"), login: document.body.textContent.includes("Welcome to Cheshi"), projects: !!document.querySelector("input[type=search]"), error: !!document.querySelector("[role=alert]"), preparing: document.body.textContent.includes("Preparing..."), footerLogin: document.querySelectorAll("footer button").length })');
    readySnapshots.set(event.sender.id, snapshot);
  });
  ipcMain.handle('cheshi:workspace-management:list', async () => {
    listCalls += 1;
    await new Promise(resolve => setTimeout(resolve, 400));
    if (failure === 'list') throw new Error('Mock catalog failure');
    return { workspaces: [] };
  });
  let installedTools = 0;
  let codexState = 'signed_out';
  let signInStarts = 0;
  ipcMain.handle('cheshi:workspace-management:get-codex-login', async () => {
    accountChecks += 1;
    if (failure === 'login') throw new Error('Mock account failure');
    return { state: codexState, error: null };
  });
  ipcMain.handle('cheshi:workspace-management:start-codex-login', () => {
    signInStarts += 1;
    codexState = 'signing_in';
    setTimeout(() => { codexState = 'signed_in'; }, 200);
    return { state: codexState, error: null };
  });
  ipcMain.handle('cheshi:workspace-management:cancel-codex-login', () => ({ state: 'signed_out', error: null }));
  ipcMain.handle('cheshi:workspace-management:get-tool-status', () => {
    if (failure === 'tools') throw new Error('Mock tools failure');
    return { platform: 'darwin', brew: installedTools > 0, gh: installedTools > 0, codex: installedTools === 2 };
  });
  const homeState = '({ search: !!document.querySelector("input[type=search]"), open: Array.from(document.querySelectorAll("button")).some(button => button.textContent === "Open folder"), welcome: document.body.textContent.includes("Your next workspace starts here") })';
  const results = [];
  for (const root of ['', '/work/example']) {
    installedTools = 0;
    codexState = root ? 'signed_in' : 'signed_out';
    signInStarts = 0;
    listCalls = 0;
    const errors = [];
    const window = new BrowserWindow({ show: false, webPreferences: {
      preload: ${JSON.stringify(preloadPath)}, contextIsolation: true, sandbox: true, nodeIntegration: false,
      additionalArguments: ['--cheshi-manager-root=' + encodeURIComponent(root), '--cheshi-manager-name=Workspaces'],
    } });
    window.webContents.on('preload-error', (_event, _path, error) => errors.push(error.message));
    await window.loadFile(${JSON.stringify(rendererPath)});
    await new Promise(resolve => setTimeout(resolve, 200));
    results.push(await window.webContents.executeJavaScript('({ root: window.workspaceManager?.workspaceRoot, title: document.querySelector("h1")?.textContent, appShell: !!document.querySelector(".app-shell"), hasWorkspaceApi: !!window.cheshiDesktop })'));
    results[results.length - 1].errors = errors;
    results[results.length - 1].commands = await window.webContents.executeJavaScript('Array.from(document.querySelectorAll("code"), node => node.textContent)');
    results[results.length - 1].homeBeforeInstall = await window.webContents.executeJavaScript(homeState);
    installedTools = 1;
    await window.webContents.executeJavaScript('Array.from(document.querySelectorAll("button")).find(button => button.textContent === "Check again").click()');
    await new Promise(resolve => setTimeout(resolve, 200));
    results[results.length - 1].homeAfterPartialInstall = await window.webContents.executeJavaScript(homeState);
    installedTools = 2;
    await window.webContents.executeJavaScript('Array.from(document.querySelectorAll("button")).find(button => button.textContent === "Check again").click()');
    await new Promise(resolve => setTimeout(resolve, 200));
    results[results.length - 1].setupAfterInstall = await window.webContents.executeJavaScript('Array.from(document.querySelectorAll("section")).some(node => node.getAttribute("aria-label") === "Workspace tool setup")');
    results[results.length - 1].homeAfterInstall = await window.webContents.executeJavaScript(homeState);
    results[results.length - 1].listCallsBeforeAuth = listCalls;
    const loginButton = 'Array.from(document.querySelectorAll("main button")).find(button => button.textContent.includes("Continue with ChatGPT"))';
    results[results.length - 1].loginOffered = await window.webContents.executeJavaScript('!!(' + loginButton + ')');
    if (!root) {
      await window.webContents.executeJavaScript('(' + loginButton + ').click()');
    }
    let preparingShown = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      const preparing = await window.webContents.executeJavaScript('Array.from(document.querySelectorAll("div")).some(node => node.getAttribute("aria-label") === "Preparing workspaces")');
      preparingShown ||= preparing;
      const home = await window.webContents.executeJavaScript(homeState);
      if (home.welcome) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    results[results.length - 1].preparingShown = preparingShown;
    results[results.length - 1].homeAfterAuth = await window.webContents.executeJavaScript(homeState);
    results[results.length - 1].loginHiddenAfterAuth = await window.webContents.executeJavaScript('!Array.from(document.querySelectorAll("div")).some(node => node.getAttribute("aria-label") === "Codex sign-in")');
    results[results.length - 1].footerButtons = await window.webContents.executeJavaScript('document.querySelectorAll("footer button").length');
    results[results.length - 1].signInStarts = signInStarts;
    window.destroy();
  }
  const startupResults = [];
  for (const scenario of ['missing-tools', 'signed-out', 'signed-in', 'tools-error', 'login-error', 'list-error']) {
    installedTools = scenario === 'missing-tools' ? 0 : 2;
    codexState = scenario === 'signed-in' || scenario === 'list-error' ? 'signed_in' : 'signed_out';
    failure = scenario.endsWith('-error') ? scenario.split('-')[0] : '';
    accountChecks = 0;
    listCalls = 0;
    const window = new BrowserWindow({ show: false, webPreferences: {
      preload: ${JSON.stringify(preloadPath)}, contextIsolation: true, sandbox: true, nodeIntegration: false,
      additionalArguments: ['--cheshi-manager-root=', '--cheshi-manager-name=Workspaces'],
    } });
    await window.loadFile(${JSON.stringify(rendererPath)});
    for (let attempt = 0; attempt < 40 && !readySnapshots.has(window.webContents.id); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    startupResults.push({ scenario, snapshot: readySnapshots.get(window.webContents.id), accountChecks, listCalls });
    window.destroy();
  }
  process.stdout.write('STARTUP_BRANCH_RESULT ' + JSON.stringify(startupResults) + '\\n');
  process.stdout.write('MANAGER_BRIDGE_RESULT ' + JSON.stringify(results) + '\\n');
  app.quit();
}).catch(error => { process.stderr.write(String(error.stack)); app.exit(1); });
setTimeout(() => app.exit(2), 25000).unref();
`);
    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    const child = spawnSync(electronPath, [mainPath], {
      env: environment, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024,
    });
    assert.equal(child.status, 0, child.error?.message || child.stderr || `Electron terminated with ${child.signal}`);
    const result = child.stdout.split('\n').find((line) => line.startsWith('MANAGER_BRIDGE_RESULT '));
    assert.ok(result, child.stdout || child.stderr);
    assert.deepEqual(JSON.parse(result.slice('MANAGER_BRIDGE_RESULT '.length)), ['', '/work/example'].map(root => ({
      root, title: 'Workspaces', appShell: false, hasWorkspaceApi: false, errors: [],
      commands: ['/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"', 'brew install gh', 'brew install --cask codex'],
      setupAfterInstall: false,
      homeBeforeInstall: { search: false, open: false, welcome: false },
      homeAfterPartialInstall: { search: false, open: false, welcome: false },
      homeAfterInstall: { search: false, open: false, welcome: false },
      listCallsBeforeAuth: root ? 1 : 0, preparingShown: true,
      homeAfterAuth: { search: true, open: true, welcome: true }, footerButtons: 0,
      loginOffered: root === '', loginHiddenAfterAuth: true, signInStarts: root === '' ? 1 : 0,
    })));
    const startupResult = child.stdout.split('\n').find((line) => line.startsWith('STARTUP_BRANCH_RESULT '));
    assert.ok(startupResult, child.stdout || child.stderr);
    assert.deepEqual(JSON.parse(startupResult.slice('STARTUP_BRANCH_RESULT '.length)), [
      ['missing-tools', true, false, false, false, 0, 0],
      ['signed-out', false, true, false, false, 1, 0],
      ['signed-in', false, false, true, false, 1, 1],
      ['tools-error', false, false, false, true, 0, 0],
      ['login-error', false, true, false, true, 1, 0],
      ['list-error', false, false, true, true, 1, 1],
    ].map(([scenario, setup, login, projects, error, accountChecks, listCalls]) => ({
      scenario, snapshot: { setup, login, projects, error, preparing: false, footerLogin: 0 }, accountChecks, listCalls,
    })));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
