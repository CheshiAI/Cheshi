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

// Hidden windows and isolated storage; never register an OS shortcut or use the user's app/data.
test('sticky notes bridge saves the last edit on native close, restores notes, pins and flushes before quit', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cheshi-sticky-bridge-'));
  try {
    const mainPath = path.join(directory, 'main.mts');
    await writeFile(mainPath, `
import { createRequire } from 'node:module';
const { app, BrowserWindow, ipcMain, screen } = createRequire(import.meta.url)('electron');
import { createStickyNotesRuntime } from ${JSON.stringify(source('../lib/sticky-notes-runtime.mts'))};
import { registerStickyNotesLibrary } from ${JSON.stringify(source('../lib/sticky-notes-library.mts'))};
import { StickyNotesStore } from ${JSON.stringify(source('../lib/sticky-notes-store.mts'))};
import { createWindowAppearance } from ${JSON.stringify(source('../lib/window-appearance.mts'))};
app.setPath('userData', ${JSON.stringify(path.join(directory, 'user-data'))});
app.commandLine.appendSwitch('disable-gpu');
app.on('window-all-closed', () => {});
let phase = 'startup';
const timeout = setTimeout(() => { console.error('Bridge timed out: ' + phase); app.exit(1); }, 25000);
app.whenReady().then(async () => {
  app.dock?.hide();
  const windows = [], errors = [];
  const shortcuts = new Map(), unregistered = [], raised = [];
  let hidden = 0, listRequests = 0;
  const options = {
    directory: ${JSON.stringify(path.join(directory, 'notes'))},
    rendererUrl: ${JSON.stringify(source('../frontend/dist/index.html'))},
    preload: ${JSON.stringify(fileURLToPath(new URL('../runtime/sticky-notes-preload.cjs', import.meta.url)))},
    appearanceFile: ${JSON.stringify(path.join(directory, 'appearance.json'))},
    ipc: ipcMain, screen, onOpenList: async () => { listRequests++; },
    shortcuts: { register(name, action) { shortcuts.set(name, action); return true; }, unregister(name) { unregistered.push(name); } },
    createAppearance: input => createWindowAppearance({ ...input, binding: null }),
    createWindow(configuration) {
      const window = new BrowserWindow(configuration);
      window.show = () => {};
      window.focus = () => {};
      window.moveTop = () => { raised.push(window.id); };
      window.hide = () => { hidden++; };
      window.webContents.on('preload-error', (_event, _path, error) => errors.push(error.message));
      window.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
      windows.push(window);
      return window;
    },
    onError: error => errors.push(String(error)),
  };
  let runtime = createStickyNotesRuntime(options);
  ipcMain.on('cheshi:get-workspace-metadata', event => { event.returnValue = { workspaceName: 'Fixture', workspaceRoot: options.directory, userName: 'Test' }; });
  const workspace = new BrowserWindow({ show: false, webPreferences: {
    preload: ${JSON.stringify(fileURLToPath(new URL('../runtime/preload.cjs', import.meta.url)))}, contextIsolation: true, sandbox: true } });
  let disposeLibrary = registerStickyNotesLibrary({ ipc: ipcMain, windows: () => [workspace], service: runtime.library });
  await workspace.loadURL('about:blank');
  const wait = async operation => {
    for (let i = 0; i < 150; i++) { if (await operation()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
    throw new Error('Condition not reached');
  };
  const evaluate = (window, expression) => window.webContents.executeJavaScript(expression);
  try {
    runtime.start(); shortcuts.get('CommandOrControl+Shift+N')();
    await wait(() => windows.length === 1);
    const first = windows[0];
    await wait(() => evaluate(first, '!!document.querySelector("textarea")'));
    const overflow = await evaluate(first, 'document.documentElement.scrollWidth > innerWidth');
    const wideBridge = await evaluate(first, '!!window.cheshiDesktop');
    const initialCount = await evaluate(first, 'window.cheshiStickyNotes.list().then(notes => notes.length)');
    const initialStatus = await evaluate(first, 'document.querySelector("[role=status]").textContent');
    const id = await evaluate(first, 'window.cheshiStickyNotes.read().then(value => value.note.id)');
    await evaluate(first, 'Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(document.querySelector("textarea"), "Last edit before close 한글"); document.querySelector("textarea").dispatchEvent(new Event("input", { bubbles: true }));');
    first.close();
    await wait(() => hidden === 1);
    const saved = await new StickyNotesStore(options.directory).get(id);
    const survivedClose = !first.isDestroyed();
    phase = 'open list'; shortcuts.get('CommandOrControl+Shift+M')();
    await wait(() => listRequests === 1);
    const listed = await evaluate(workspace, 'window.cheshiDesktop.notes.list()');
    await evaluate(workspace, 'window.cheshiDesktop.notes.open(' + JSON.stringify(id) + ')');
    const reused = windows.length === 1;
    const raisedNote = raised.at(-1) === first.id;
    shortcuts.get('CommandOrControl+Shift+M')();
    await wait(() => listRequests === 2);
    const reusedList = windows.length === 1;
    await evaluate(first, 'document.querySelector("[aria-label^=Keep]").click()');
    await wait(() => evaluate(first, '!!document.querySelector("[aria-label^=Unpin]")'));
    const pinned = first.isAlwaysOnTop();
    first.setBounds({ x: 40, y: 60, width: 400, height: 460 });
    const intruder = new BrowserWindow({ show: false, webPreferences: { preload: options.preload, contextIsolation: true, sandbox: true } });
    await intruder.loadURL('about:blank');
    const denied = await evaluate(intruder, 'window.cheshiStickyNotes.list().then(() => false, () => true)');
    intruder.destroy();
    phase = 'prepare to quit'; await runtime.prepareToQuit();
    const frozen = await evaluate(first, 'document.querySelector("textarea").readOnly');
    runtime.resume();
    await wait(() => evaluate(first, '!document.querySelector("textarea").readOnly'));
    phase = 'prepare to quit'; await runtime.prepareToQuit();
    disposeLibrary(); runtime.dispose();
    runtime = createStickyNotesRuntime(options);
    disposeLibrary = registerStickyNotesLibrary({ ipc: ipcMain, windows: () => [workspace], service: runtime.library });
    phase = 'restore note';
    await evaluate(workspace, 'window.cheshiDesktop.notes.open(' + JSON.stringify(id) + ')');
    const restored = windows[1];
    await wait(() => evaluate(restored, '!!document.querySelector("textarea")'));
    const text = await evaluate(restored, 'document.querySelector("textarea").value');
    const bounds = restored.getBounds();
    const restoredPin = restored.isAlwaysOnTop();
    phase = 'rename with a pending editor draft';
    await evaluate(restored, 'Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(document.querySelector("textarea"), "Pending full body 한글"); document.querySelector("textarea").dispatchEvent(new Event("input", { bubbles: true }));');
    await evaluate(workspace, 'window.cheshiDesktop.notes.rename(' + JSON.stringify(id) + ', "Renamed from sidebar")');
    const renamed = await new StickyNotesStore(options.directory).get(id);
    const editorTitle = await evaluate(restored, 'document.querySelector("input").value');
    const bodyMatches = await evaluate(workspace, 'window.cheshiDesktop.notes.list("FULL BODY 한글").then(notes => notes.length)');
    await evaluate(restored, 'Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(document.querySelector("textarea"), "Body edited after rename"); document.querySelector("textarea").dispatchEvent(new Event("input", { bubbles: true }));');
    await wait(async () => (await new StickyNotesStore(options.directory).get(id)).text === 'Body edited after rename');
    const afterRenameEdit = await new StickyNotesStore(options.directory).get(id);
    phase = 'selected deletion';
    const seed = async text => {
      await runtime.create();
      const window = windows.at(-1);
      await wait(() => evaluate(window, '!!document.querySelector("textarea")'));
      await evaluate(window, 'window.cheshiStickyNotes.save(' + JSON.stringify({ title: text, text }) + ')');
      const id = await evaluate(window, 'window.cheshiStickyNotes.read().then(value => value.note.id)');
      return { window, id };
    };
    const middle = await seed('Middle'), latest = await seed('Latest must survive');
    await evaluate(workspace, 'window.notesChanges = 0; window.cheshiDesktop.notes.onChanged(() => window.notesChanges++); true');
    await evaluate(workspace, 'window.cheshiDesktop.notes.deleteSelected(' + JSON.stringify([id, middle.id]) + ')');
    await wait(() => restored.isDestroyed() && middle.window.isDestroyed());
    const selectedDeletion = { deletedWindows: restored.isDestroyed() && middle.window.isDestroyed(),
      survivor: (await new StickyNotesStore(options.directory).list()).map(note => note.id), expected: latest.id };
    const changes = await evaluate(workspace, 'window.notesChanges');
    const narrowLibrary = await evaluate(workspace, '!window.cheshiDesktop.notes.save && !window.cheshiDesktop.notes.read && !window.cheshiDesktop.appleNotes');
    const click = (window, selector) => evaluate(window, 'document.querySelector(' + JSON.stringify(selector) + ').click()');
    await click(latest.window, '[aria-label="Note actions"]');
    await wait(() => evaluate(latest.window, '!!document.querySelector("[role=menu]")'));
    await click(latest.window, '[role=menuitem][aria-label="All notes"]');
    await wait(() => listRequests === 3);
    const editorPreserved = await evaluate(latest.window, '!!document.querySelector("textarea") && !document.querySelector("[data-note-id]")');
    await evaluate(workspace, 'window.cheshiDesktop.notes.deleteSelected(' + JSON.stringify([latest.id]) + ')');
    const remaining = await new StickyNotesStore(options.directory).list();
    phase = 'prepare to quit'; await runtime.prepareToQuit(); disposeLibrary(); runtime.dispose(); workspace.destroy();
    console.log('RESULT:' + JSON.stringify({ shortcutNames: [...shortcuts.keys()], unregistered, raisedNote, reusedList, overflow, wideBridge, initialCount, initialStatus, saved, survivedClose, listed,
      reused, pinned, denied, frozen, text, bounds, restoredPin, selectedDeletion, remaining, errors, changes, narrowLibrary, editorPreserved, renamed, editorTitle, bodyMatches, afterRenameEdit }));
    clearTimeout(timeout); app.exit(0);
  } catch (error) { console.error(error); runtime.dispose(); clearTimeout(timeout); app.exit(1); }
}).catch(error => { console.error(error); clearTimeout(timeout); app.exit(1); });
`);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(electronPath, [mainPath], { env, encoding: 'utf8', timeout: 35_000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${result.signal ?? ''}\n${result.stdout}\n${result.stderr}`);
    const line = result.stdout.split('\n').find(value => value.startsWith('RESULT:'));
    assert.ok(line, result.stdout);
    const value = JSON.parse(line.slice(7));
    assert.deepEqual(value.shortcutNames, ['CommandOrControl+Shift+N', 'CommandOrControl+Shift+M']);
    assert.deepEqual(value.unregistered, value.shortcutNames);
    assert.equal(value.raisedNote, true);
    assert.equal(value.reusedList, true);
    assert.equal(value.overflow, false);
    assert.equal(value.wideBridge, false);
    assert.equal(value.initialCount, 0);
    assert.equal(value.initialStatus, 'Write something to save this note');
    assert.equal(value.saved.text, 'Last edit before close 한글');
    assert.equal(value.survivedClose, true);
    assert.equal(value.listed[0].preview, 'Last edit before close 한글');
    assert.equal(value.reused, true);
    assert.equal(value.pinned, true);
    assert.equal(value.denied, true);
    assert.equal(value.frozen, true);
    assert.equal(value.text, value.saved.text);
    assert.equal(value.restoredPin, true);
    assert.equal(value.bounds.width, 400);
    assert.equal(value.bounds.height, 460);
    assert.equal(value.selectedDeletion.deletedWindows, true);
    assert.deepEqual(value.selectedDeletion.survivor, [value.selectedDeletion.expected]);
    assert.ok(value.changes > 0);
    assert.equal(value.narrowLibrary, true);
    assert.equal(value.editorPreserved, true);
    assert.equal(value.renamed.title, 'Renamed from sidebar');
    assert.equal(value.renamed.text, 'Pending full body 한글');
    assert.equal(value.renamed.createdAt, value.saved.createdAt);
    assert.equal(value.editorTitle, 'Renamed from sidebar');
    assert.equal(value.bodyMatches, 1);
    assert.equal(value.afterRenameEdit.title, 'Renamed from sidebar');
    assert.equal(value.afterRenameEdit.createdAt, value.saved.createdAt);
    assert.deepEqual(value.remaining, []);
    assert.deepEqual(value.errors, []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
