import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

test('Canvas preserves and recovers its viewport after a zero-size iframe', { timeout: 90_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cheshi-canvas-viewport-'));
  const entry = fileURLToPath(new URL('../frontend/public/open-pencil/index.html', import.meta.url));
  const host = path.join(directory, 'host.html');
  const main = path.join(directory, 'main.mts');
  try {
    await writeFile(host, `<!doctype html><html style="width:100%;height:100%">
      <meta http-equiv="Content-Security-Policy" content="default-src 'self' file:; style-src 'unsafe-inline'">
      <body style="margin:0;width:100%;height:100%"><iframe title="Test Canvas"
        style="border:0;width:100%;height:100%" src="${pathToFileURL(entry).href}"></iframe></body></html>`);
    await writeFile(main, `
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { app, BrowserWindow, session } = createRequire(${JSON.stringify(import.meta.url)})('electron');
void (async () => {
app.setPath('userData', ${JSON.stringify(path.join(directory, 'profile'))});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let stage = 'startup';
const timeout = setTimeout(() => { console.error('Canvas viewport timeout:',stage); app.exit(2); }, 60000);
await app.whenReady();
app.dock?.hide();
session.defaultSession.webRequest.onBeforeRequest((details, done) => done({cancel:/^https?:|^wss?:/.test(details.url)}));
const win = new BrowserWindow({show:false,width:1200,height:800,
  webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
const errors = [];
win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
const hostEval = expression => win.webContents.executeJavaScript(expression);
const evaluate = expression => win.webContents.mainFrame.frames[0].executeJavaScript(expression);
const state = () => evaluate('(() => {const s=window.openPencil.getStore();return {zoom:s.state.zoom,panX:s.state.panX,panY:s.state.panY}})()');
async function waitFor(expression) {
  for(let i=0;i<200;i++) { if(await evaluate(expression)) return; await delay(25); }
  throw Error('Canvas condition timed out: '+expression+' '+JSON.stringify(errors));
}
async function resize(hidden) {
  await hostEval('document.querySelector("iframe").style.cssText='+JSON.stringify(hidden
    ? 'border:0;width:0;height:0' : 'border:0;width:100%;height:100%'));
  await waitFor(hidden
    ? 'window.openPencil.getStore().getViewportSize().width===0'
    : 'window.openPencil.getStore().getViewportSize().width>500');
  await delay(150);
}
async function brightPixels() {
  const pixels = (await win.webContents.capturePage({x:30,y:110,width:1000,height:550})).toBitmap();
  let count=0;
  for(let i=0;i<pixels.length;i+=4) if(pixels[i]>180&&pixels[i+1]>180&&pixels[i+2]>180) count++;
  return count;
}
try {
  await win.loadFile(${JSON.stringify(host)});
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
  stage = 'initialize';
  await waitFor('(() => {try {return !!window.openPencil?.getStore()} catch {return false}})()');
  await hostEval('document.querySelector("iframe").contentWindow.postMessage({channel:"cheshi:open-pencil:v1",type:"command",id:1,method:"new"}, "*")');
  await waitFor('!!window.openPencil.getStore().renderer && window.openPencil.getStore().getViewportSize().width>500');
  await evaluate(\`(() => {
    const s=window.openPencil.getStore();
    window.__shape=s.createShape('RECTANGLE',50,80,300,200);
    s.updateNodeWithUndo(window.__shape,{fills:[{type:'SOLID',color:{r:1,g:1,b:1,a:1},opacity:1,visible:true}]},'Color');
    s.zoomToFit();
  })()\`);
  await delay(400);
  const before=await state();
  assert.ok(before.zoom>0);
  const initialPixels=await brightPixels();
  assert.ok(initialPixels>10000, 'Fixture must contain visible artwork');

  // Preparation must keep intermediate zoom/layout frames off screen without
  // stopping the renderer or changing the size used by the final Fit.
  stage = 'preparation visibility';
  const initialSize = await evaluate('window.openPencil.getStore().getViewportSize()');
  await evaluate(\`(() => {
    const s=window.openPencil.getStore();
    window.__preparation=s.preparationController.begin({kind:'document-open',subject:'first-load.fig'});
    s.zoomToLevel(1);s.pan(40,20);
  })()\`);
  for (const phase of ['reading','decoding','preparing-render']) {
    await evaluate('window.__preparation.update({phase:'+JSON.stringify(phase)+'})');
    await delay(80);
    assert.deepEqual(await evaluate('window.openPencil.getStore().getViewportSize()'),initialSize);
    assert.ok(await brightPixels()<initialPixels*.05,'Intermediate '+phase+' artwork must stay hidden');
  }
  await evaluate(\`(async () => {
    const s=window.openPencil.getStore();
    await s.fitCurrentPageToViewport();
    await s.preparationController.waitForPresentation(window.__preparation.id,s.state.sceneVersion);
    window.__preparation.complete();
  })()\`);
  await waitFor('document.querySelector(".cheshi-canvas-scene").dataset.preparing === "false"');
  assert.deepEqual(await state(),before,'Reveal must preserve the final fitted view');
  assert.ok(await brightPixels()>initialPixels*.95,'Completed preparation must reveal painted artwork');

  await evaluate('window.__preparation=window.openPencil.getStore().preparationController.begin({kind:"font-retry"})');
  await delay(80);
  assert.ok(await brightPixels()>initialPixels*.95,'A background font retry must not hide visible artwork');
  await evaluate('window.__preparation.complete()');

  // Direct Fit and the asynchronous import Fit must not persist a zero zoom.
  stage = 'zero-size fit';
  await resize(true);
  await evaluate('window.openPencil.getStore().zoomToFit()');
  assert.deepEqual(await state(),before,'Fit in a zero-size iframe must preserve the viewport');
  await evaluate('window.openPencil.getStore().pan(10000,10000)');
  const displaced=await state();
  await evaluate('window.openPencil.getStore().fitCurrentPageToViewport()');
  assert.deepEqual(await state(),displaced,'Deferred fit must preserve the viewport until layout is ready');
  await resize(false);
  await delay(250);
  assert.deepEqual(await state(),before,'Pending fit must execute once the viewport has a size');
  assert.ok(await brightPixels()>initialPixels*.95,'Deferred fit must restore visible artwork');

  // An ordinary tab/layout hide must not reset a user-selected view.
  await evaluate('(() => {const s=window.openPencil.getStore();s.zoomToLevel(.75);s.pan(23,17)})()');
  const custom=await state();
  await resize(true);
  await resize(false);
  assert.deepEqual(await state(),custom,'Valid zoom and pan must survive hide/show');

  // Repair documents whose presentation was already poisoned by the old code.
  await resize(true);
  await evaluate('Object.assign(window.openPencil.getStore().state,{zoom:0,panX:378,panY:540})');
  await resize(false);
  await waitFor('window.openPencil.getStore().state.zoom>0');
  await delay(250);
  assert.ok(await brightPixels()>initialPixels*.95,'Recovery must paint artwork, not just update state');
  assert.equal(await evaluate('window.openPencil.getStore().graph.getNode(window.__shape).width'),300);

  // Empty documents must also recover; zoomToFit alone has nothing to fit.
  await evaluate('(() => {const s=window.openPencil.getStore();s.select([window.__shape]);s.deleteSelected()})()');
  await resize(true);
  await evaluate('Object.assign(window.openPencil.getStore().state,{zoom:NaN,panX:Infinity,panY:NaN})');
  await resize(false);
  await waitFor('window.openPencil.getStore().state.zoom===1');
  assert.deepEqual(await state(),{zoom:1,panX:0,panY:0});
  assert.deepEqual(errors,[]);
  console.log('CANVAS_VIEWPORT_OK');
  win.destroy(); clearTimeout(timeout); app.exit(0);
} catch(error) {
  console.error(error,errors);
  win.destroy(); clearTimeout(timeout); app.exit(1);
}
})();
`);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const electron = createRequire(import.meta.url)('electron') as string;
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(electron, [main], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', data => { output += String(data); });
      child.stderr.on('data', data => { output += String(data); });
      child.on('error', reject);
      child.on('close', code => resolve({ code, output }));
    });
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /CANVAS_VIEWPORT_OK/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
