import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { build, mergeConfig } from 'vite';
import viteConfig from '../frontend/vite.config.ts';

// Exercise real portal-host transitions and the embedded editor in a disposable
// Electron profile, without touching the user's development app or canvas files.
test('workspace transitions retain the Canvas iframe, document, draft and viewport', { timeout: 90_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cheshi-pane-canvas-'));
  const root = fileURLToPath(new URL('..', import.meta.url));
  const entry = pathToFileURL(path.join(root, 'frontend/public/open-pencil/index.html')).href;
  const output = path.join(directory, 'renderer');
  const main = path.join(directory, 'main.mts');
  try {
    await build(mergeConfig(viteConfig, { configFile: false, root, base: './', logLevel: 'error',
      publicDir: false, cacheDir: path.join(directory, 'vite-cache'),
      build: { outDir: output, rollupOptions: { input: path.join(root, 'test/workspace-pane-canvas-fixture.html') } } }));
    await writeFile(main, `
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { app, BrowserWindow, session } = createRequire(${JSON.stringify(import.meta.url)})('electron');
void (async () => {
app.setPath('userData', ${JSON.stringify(path.join(directory, 'profile'))});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let stage = 'startup';
const timeout = setTimeout(() => { console.error('Pane Canvas timeout:', stage); app.exit(2); }, 55000);
await app.whenReady();
app.dock?.hide();
session.defaultSession.webRequest.onBeforeRequest((details, done) => done({cancel:/^https?:|^wss?:/.test(details.url)}));
const win = new BrowserWindow({show:false,width:1200,height:800,
  webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
const errors = [];
win.webContents.on('console-message', event => { if(event.level === 'error') errors.push(event.message); });
const host = expression => win.webContents.executeJavaScript(expression);
const canvas = expression => win.webContents.mainFrame.frames[0].executeJavaScript(expression);
async function waitFor(read, expression) {
  for(let i=0;i<240;i++) { if(await read(expression)) return; await delay(25); }
  throw Error(stage+': condition timed out: '+expression);
}
const snapshot = \`(() => {const s=window.openPencil.getStore();return {
  sameStore:s===window.__retainedStore, path:s.getDocumentFilePath(), dirty:s.hasUnsavedChanges(),
  nodes:JSON.stringify([...s.graph.getAllNodes()]), selected:[...s.state.selectedIds],
  zoom:s.state.zoom,panX:s.state.panX,panY:s.state.panY
}})()\`;
try {
  await win.loadFile(${JSON.stringify(path.join(output, 'test/workspace-pane-canvas-fixture.html'))}, {query:{editor:${JSON.stringify(entry)}}});
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
  await waitFor(host, 'window.paneCanvasFixture?.loads === 1');
  await waitFor(canvas, '(() => {try {return !!window.openPencil?.getStore()} catch {return false}})()');
  assert.equal(await host('typeof document.body.moveBefore'), 'function');
  await host('document.querySelector("iframe").contentWindow.postMessage({channel:"cheshi:open-pencil:v1",type:"command",id:1,method:"new"}, "*")');
  await waitFor(canvas, '!!window.openPencil.getStore().renderer');
  await canvas(\`(() => {
    const s=window.openPencil.getStore();
    window.__retainedStore=s;
    window.__shape=s.createShape('RECTANGLE',50,80,300,200);
    s.setDocumentSource('return.fig','fig',undefined,'designs/return.fig');
    s.updateNodeWithUndo(window.__shape,{x:90},'Unsaved move');
    s.select([window.__shape]);
    s.zoomToLevel(.75);s.pan(23,17);
  })()\`);
  const before = await canvas(snapshot);
  assert.equal(before.dirty,true);
  const initialLoads = await host('window.paneCanvasFixture.loads');
  async function retained(label) {
    await delay(150);
    assert.equal(await host('window.paneCanvasFixture.loads'),initialLoads,label+': iframe reloaded');
    assert.deepEqual(await canvas(snapshot),before,label+': canvas state changed');
  }
  for(const name of ['explorer','canvas','split','swapped','nested','explorer','canvas']) {
    stage=name;
    await host('document.querySelector('+JSON.stringify('[data-layout="'+name+'"]')+').click()');
    await retained(name);
  }
  stage='maximize and restore';
  await host('document.querySelector("[data-layout=split]").click()');
  await delay(100);
  await host('document.querySelector("[data-editor] [aria-label=\\\\"Maximize pane\\\\"]").click()');
  await retained('maximize Explorer');
  await host('document.querySelector("[data-editor] [aria-label=\\\\"Restore pane size\\\\"]").click()');
  await retained('restore split');
  await host('document.querySelector("[data-canvas-controls] [aria-label=\\\\"Maximize pane\\\\"]").click()');
  await retained('maximize Canvas');
  await host('document.querySelector("[data-canvas-controls] [aria-label=\\\\"Restore pane size\\\\"]").click()');
  await retained('restore Canvas');
  await canvas('window.openPencil.getStore().undoAction()');
  assert.equal(await canvas('window.openPencil.getStore().graph.getNode(window.__shape).x'),50,'Undo history must survive navigation');
  await canvas('window.openPencil.getStore().redoAction()');
  assert.equal(await canvas('window.openPencil.getStore().graph.getNode(window.__shape).x'),90);
  stage='dispose';
  await host('document.querySelector("[data-unmount]").click()');
  await delay(100);
  assert.equal(await host('document.querySelector("iframe") === null'),true);
  assert.deepEqual(errors,[]);
  console.log('PANE_CANVAS_RETAINED');
  win.destroy();clearTimeout(timeout);app.exit(0);
} catch(error) {
  console.error(stage,error,errors);
  win.destroy();clearTimeout(timeout);app.exit(1);
}
})();
`);
    const electron = createRequire(import.meta.url)('electron') as string;
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(electron, [main], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', data => { output += String(data); });
      child.stderr.on('data', data => { output += String(data); });
      child.on('error', reject);
      child.on('close', code => resolve({ code, output }));
    });
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /PANE_CANVAS_RETAINED/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
