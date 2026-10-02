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
  let hidden = 0;
  const options = {
    directory: ${JSON.stringify(path.join(directory, 'notes'))},
    rendererUrl: ${JSON.stringify(source('../frontend/dist/index.html'))},
    preload: ${JSON.stringify(fileURLToPath(new URL('../runtime/sticky-notes-preload.cjs', import.meta.url)))},
    appearanceFile: ${JSON.stringify(path.join(directory, 'appearance.json'))},
    ipc: ipcMain, screen,
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
    await wait(() => windows.length === 2);
    const list = windows[1];
    await wait(() => evaluate(list, '!!document.querySelector("[data-note-id] button")'));
    const listed = await evaluate(list, 'document.querySelector("section[aria-label]").textContent');
    await evaluate(list, 'document.querySelector("[data-note-id] button").click()');
    await new Promise(resolve => setTimeout(resolve, 80));
    const reused = windows.length === 2;
    const raisedNote = raised.at(-1) === first.id;
    shortcuts.get('CommandOrControl+Shift+M')();
    await wait(() => raised.at(-1) === list.id);
    const reusedList = windows.length === 2;
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
    runtime.dispose();
    runtime = createStickyNotesRuntime(options);
    phase = 'open list'; await runtime.openList();
    const restoredList = windows[2];
    await wait(() => evaluate(restoredList, '!!document.querySelector("[data-note-id] button")'));
    await evaluate(restoredList, 'document.querySelector("[data-note-id] button").click()');
    await wait(() => windows.length === 4);
    const restored = windows[3];
    await wait(() => evaluate(restored, '!!document.querySelector("textarea")'));
    const text = await evaluate(restored, 'document.querySelector("textarea").value');
    const bounds = restored.getBounds();
    const restoredPin = restored.isAlwaysOnTop();
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
    await wait(() => evaluate(restoredList, 'document.querySelectorAll("[data-note-id]").length === 3'));
    const click = (window, selector) => evaluate(window, 'document.querySelector(' + JSON.stringify(selector) + ').click()');
    const checkbox = id => '[data-note-id="' + id + '"] input[type=checkbox]';
    await click(restoredList, checkbox(id));
    await click(restoredList, checkbox(middle.id));
    const askDelete = window => evaluate(window, 'Array.from(document.querySelectorAll("button")).find(button => button.textContent === "Delete selected").click()');
    const confirmDelete = window => evaluate(window, 'Array.from(document.querySelectorAll("dialog[open] button")).find(button => button.textContent === "Delete").click()');
    await askDelete(restoredList);
    await wait(() => evaluate(restoredList, '!!document.querySelector("dialog[open]")'));
    await evaluate(restoredList, 'Array.from(document.querySelectorAll("dialog[open] button")).find(button => button.textContent === "Cancel").click()');
    const countAfterCancel = (await new StickyNotesStore(options.directory).list()).length;
    await askDelete(restoredList);
    await wait(() => evaluate(restoredList, '!!document.querySelector("dialog[open]")'));
    await confirmDelete(restoredList);
    await wait(() => evaluate(restoredList, 'document.querySelectorAll("[data-note-id]").length === 1 && !document.querySelector("dialog[open]")'));
    const selectedDeletion = { countAfterCancel, deletedWindows: restored.isDestroyed() && middle.window.isDestroyed(),
      survivor: (await new StickyNotesStore(options.directory).list()).map(note => note.id), expected: latest.id };
    // A note's own list must stay open when its underlying note is selected for deletion.
    await click(latest.window, '[aria-label="Note actions"]');
    await wait(() => evaluate(latest.window, '!!document.querySelector("[role=menu]")'));
    await click(latest.window, '[role=menuitem][aria-label="All notes"]');
    await wait(() => evaluate(latest.window, '!!document.querySelector("[data-note-id]")'));
    await click(latest.window, checkbox(latest.id));
    await askDelete(latest.window);
    await wait(() => evaluate(latest.window, '!!document.querySelector("dialog[open]")'));
    await confirmDelete(latest.window);
    await wait(() => evaluate(latest.window, 'document.body.textContent.includes("No notes yet") && !document.querySelector("dialog[open]")'));
    selectedDeletion.keptListWindow = !latest.window.isDestroyed();
    const remaining = await new StickyNotesStore(options.directory).list();
    phase = 'prepare to quit'; await runtime.prepareToQuit(); runtime.dispose();
    console.log('RESULT:' + JSON.stringify({ shortcutNames: [...shortcuts.keys()], unregistered, raisedNote, reusedList, overflow, wideBridge, initialCount, initialStatus, saved, survivedClose, listed,
      reused, pinned, denied, frozen, text, bounds, restoredPin, selectedDeletion, remaining, errors }));
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
    assert.match(value.listed, /Last edit before close/);
    assert.equal(value.reused, true);
    assert.equal(value.pinned, true);
    assert.equal(value.denied, true);
    assert.equal(value.frozen, true);
    assert.equal(value.text, value.saved.text);
    assert.equal(value.restoredPin, true);
    assert.equal(value.bounds.width, 400);
    assert.equal(value.bounds.height, 460);
    assert.equal(value.selectedDeletion.countAfterCancel, 3);
    assert.equal(value.selectedDeletion.deletedWindows, true);
    assert.deepEqual(value.selectedDeletion.survivor, [value.selectedDeletion.expected]);
    assert.equal(value.selectedDeletion.keptListWindow, true);
    assert.deepEqual(value.remaining, []);
    assert.deepEqual(value.errors, []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
