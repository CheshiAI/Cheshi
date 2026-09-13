import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const electronPath = require('electron') as string;
const preloadPath = fileURLToPath(new URL('../runtime/preload.cjs', import.meta.url));

// Run explicitly after desktop:preload. This creates only an independent hidden
// test window and never connects to, starts, or controls the Cheshi application.
test('real Electron bridge imports pathless clipboard files and native dropped files', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cheshi-attachment-electron-'));
  const sourcePath = path.join(directory, 'drop.txt');
  const mainPath = path.join(directory, 'main.cjs');
  try {
    await writeFile(sourcePath, 'native dropped file');
    await writeFile(mainPath, `
const { app, BrowserWindow, ipcMain } = require('electron');
app.setPath('userData', ${JSON.stringify(path.join(directory, 'user-data'))});
app.commandLine.appendSwitch('disable-gpu');
app.whenReady().then(async () => {
  app.dock?.hide();
  const received = [];
  ipcMain.on('cheshi:get-workspace-metadata', event => { event.returnValue = {}; });
  ipcMain.handle('cheshi:import-codex-chat-attachments', (_event, payload) => {
    received.push(payload.map(value => 'path' in value ? { path: value.path } : {
      name: value.name, mimeType: value.mimeType, bytes: Array.from(value.bytes), byteArray: value.bytes instanceof Uint8Array,
    }));
    return [];
  });
  const window = new BrowserWindow({ show: false, webPreferences: {
    preload: ${JSON.stringify(preloadPath)}, contextIsolation: true, nodeIntegration: false, sandbox: true,
  } });
  await window.loadURL('data:text/html,<input id="file" type="file">');
  const clipboard = await window.webContents.executeJavaScript(
    '(async () => { try { await window.cheshiDesktop.importCodexChatAttachments([new File([new Uint8Array([137,80,78,71,13,10,26,10])], "clip.png", {type:"image/png"})]); return "ok"; } catch (error) { return error.message; } })()');
  window.webContents.debugger.attach('1.3');
  const { root } = await window.webContents.debugger.sendCommand('DOM.getDocument');
  const { nodeId } = await window.webContents.debugger.sendCommand('DOM.querySelector', {nodeId:root.nodeId,selector:'#file'});
  await window.webContents.debugger.sendCommand('DOM.setFileInputFiles', {nodeId,files:[${JSON.stringify(sourcePath)}]});
  const dropped = await window.webContents.executeJavaScript(
    '(async () => { try { await window.cheshiDesktop.importCodexChatAttachments([document.querySelector("#file").files[0]]); return "ok"; } catch (error) { return error.message; } })()');
  process.stdout.write('ATTACHMENT_BRIDGE_RESULT ' + JSON.stringify({clipboard,dropped,received}) + '\\n');
  window.destroy();
  app.quit();
}).catch(error => { process.stderr.write(String(error.stack)); app.exit(1); });
setTimeout(() => app.exit(2), 15000).unref();
`);
    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    const child = spawnSync(electronPath, [mainPath], {
      env: environment, encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024,
    });
    strictEqual(child.status, 0, child.error?.message || child.stderr || `Electron terminated with ${child.signal}`);
    const line = child.stdout.split('\n').find((value) => value.startsWith('ATTACHMENT_BRIDGE_RESULT '));
    strictEqual(typeof line, 'string', child.stdout || child.stderr);
    const result = JSON.parse(line!.slice('ATTACHMENT_BRIDGE_RESULT '.length));
    deepStrictEqual(result, {
      clipboard: 'ok', dropped: 'ok', received: [
        [{ name: 'clip.png', mimeType: 'image/png', bytes: [137, 80, 78, 71, 13, 10, 26, 10], byteArray: true }],
        [{ path: sourcePath }],
      ],
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
