import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const electronPath = createRequire(import.meta.url)('electron') as string;
const source = (name: string) => new URL(name, import.meta.url).href;

// Hidden, isolated Electron runtime: no user app, account, provider or history access.
test('temporary native window renders and sends through the shared UI and disposable IPC', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cheshi-temporary-bridge-'));
  try {
    const mainPath = path.join(directory, 'main.mts');
    await writeFile(mainPath, `
import { createRequire } from 'node:module';
const { app, BrowserWindow, ipcMain } = createRequire(import.meta.url)('electron');
import { createTemporaryChatWindow } from ${JSON.stringify(source('../lib/temporary-chat-window.mts'))};
import { WorkspaceIpcRouter } from ${JSON.stringify(source('../lib/workspace-ipc-router.mts'))};
import { registerTemporaryChatIpc } from ${JSON.stringify(source('../lib/temporary-chat-ipc.mts'))};
import { createWindowAppearance } from ${JSON.stringify(source('../lib/window-appearance.mts'))};
app.setPath('userData', ${JSON.stringify(path.join(directory, 'user-data'))});
app.commandLine.appendSwitch('disable-gpu');
app.on('window-all-closed', () => {});
const timer = setTimeout(() => { console.error('Bridge timed out'); app.exit(1); }, 20000);
app.whenReady().then(async () => {
app.dock?.hide();
const parent = new BrowserWindow({ show: false, minWidth: 1280, minHeight: 750 });
await parent.loadURL('about:blank');
parent.webContents.getURL = () => ${JSON.stringify(source('../frontend/dist/index.html'))};
const router = new WorkspaceIpcRouter(ipcMain);
const scope = router.createScope();
scope.addOwner(parent.webContents);
const errors = [], sends = [];
let child, closes = 0;
const manager = createTemporaryChatWindow({
  scope, getParent: () => parent,
  preload: ${JSON.stringify(fileURLToPath(new URL('../runtime/preload.cjs', import.meta.url)))},
  appearanceFile: ${JSON.stringify(path.join(directory, 'appearance.json'))},
  metadata: { workspaceRoot: '/fixture', workspaceName: 'Fixture', userName: 'Tester' },
  createAppearance: options => createWindowAppearance({ ...options, binding: null }),
  createWindow: options => {
    child = new BrowserWindow(options);
    child.show = () => {};
    child.focus = () => {};
    child.webContents.on('console-message', event => { if (event.level === 'error') console.error(event.message); });
    child.webContents.on('preload-error', (_event, _path, error) => errors.push(error.message));
    return child;
  },
  openExternal: async () => {}, onCleanupError: error => errors.push(String(error)),
  registerSession: (childScope, window) => registerTemporaryChatIpc({
    ipc: childScope.ipc,
    assertSender: event => { if (event.sender !== window.webContents) throw new Error('Wrong owner'); },
    selectFiles: async () => [], onCleanupError: error => errors.push(String(error)),
    createService: () => ({
      models: async () => [{ id: 'test', model: 'test', displayName: 'Test model', description: 'Fixture', isDefault: true,
        defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ effort: 'medium', description: 'Fixture effort' }],
        serviceTiers: [], defaultServiceTier: null }],
      send: async request => { sends.push(request); return { text: '**Fixture reply**', model: 'test' }; },
      close: async () => { closes++; },
    }),
  }),
});
try {
  await manager.open();
  const initialSize = child.getSize();
  const evaluate = expression => child.webContents.executeJavaScript(expression).catch(error => { console.error(expression); throw error; });
  const waitFor = async expression => {
    for (let i = 0; i < 100; i++) {
      if (await evaluate(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Condition not reached: ' + expression);
  };
  await waitFor('!!document.querySelector("textarea:not(:disabled)") && document.body.textContent.includes("Test model")');
  const initial = await evaluate('({ shell: !!document.querySelector(".app-shell"), conversation: !!document.querySelector("[aria-label=Conversation]"), user: window.cheshiDesktop.userName, modal: !!document.querySelector("[role=dialog]"), noHistory: document.body.textContent.includes("Not saved to chat history") })');
  await evaluate('Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(document.querySelector("textarea"), "Fixture question"); document.querySelector("textarea").dispatchEvent(new Event("input", { bubbles: true }));');
  await waitFor('!Array.from(document.querySelectorAll("button")).find(button => button.ariaLabel === "Send message").disabled');
  await evaluate('document.querySelector("form").requestSubmit()');
  await waitFor('!!document.querySelector("[data-chat-item-id=temporary-1] p strong")');
  const replied = await evaluate('document.querySelector("[data-chat-item-id=temporary-1] p strong").textContent');
  const measure = () => evaluate('(() => { const card = document.querySelector("[data-chat-item-id=temporary-1]").getBoundingClientRect(); const input = document.querySelector("form").parentElement.getBoundingClientRect(); return { left: Math.abs(card.left - input.left), right: Math.abs(card.right - input.right), overflow: document.documentElement.scrollWidth > innerWidth }; })()');
  child.setSize(900, 760);
  await new Promise(resolve => setTimeout(resolve, 100));
  const wide = await measure();
  child.setSize(480, 550);
  await new Promise(resolve => setTimeout(resolve, 100));
  const narrow = await measure();
  await evaluate('Array.from(document.querySelectorAll("button")).find(button => button.ariaLabel === "Choose model and reasoning effort").click()');
  await waitFor('!!document.querySelector("[role=menu]")');
  const menu = await evaluate('document.querySelector("[role=menu]").textContent');
  await manager.stop();
  parent.destroy(); scope.dispose();
  console.log('RESULT:' + JSON.stringify({ initialSize, initial, replied, wide, narrow, menu, sends, closes, errors }));
  clearTimeout(timer); app.exit(0);
} catch (error) {
  console.error(error); await manager.stop(); parent.destroy(); scope.dispose(); clearTimeout(timer); app.exit(1);
}
}).catch(error => { console.error(error); clearTimeout(timer); app.exit(1); });
`);
    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(electronPath, [mainPath], { env: environment, encoding: 'utf8', timeout: 30_000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${result.signal ?? ''}\n${result.stdout}\n${result.stderr}`);
    const line = result.stdout.split('\n').find(value => value.startsWith('RESULT:'));
    assert.ok(line, result.stdout);
    const value = JSON.parse(line.slice(7));
    assert.deepEqual(value.errors, []);
    assert.deepEqual(value.initialSize, [500, 750]);
    assert.deepEqual(value.initial, { shell: true, conversation: true, user: 'Tester', modal: false, noHistory: true });
    assert.equal(value.replied, 'Fixture reply');
    assert.equal(value.sends.length, 1);
    assert.equal(value.sends[0].text, 'Fixture question');
    assert.equal(value.closes, 1);
    assert.match(value.menu, /Model.*Reasoning/);
    for (const size of [value.wide, value.narrow]) {
      assert.ok(size.left <= 1 && size.right <= 1, JSON.stringify(size));
      assert.equal(size.overflow, false);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
