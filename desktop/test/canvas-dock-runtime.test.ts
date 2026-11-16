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

test('Canvas pages and layers dock below files, retain editing, and follow sidebar resizing', { timeout: 90_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cheshi-canvas-dock-'));
  const root = fileURLToPath(new URL('..', import.meta.url));
  const entry = pathToFileURL(path.join(root, 'frontend/public/open-pencil/index.html')).href;
  const output = path.join(directory, 'renderer');
  const main = path.join(directory, 'main.mts');
  try {
    await build(mergeConfig(viteConfig, { configFile: false, root, base: './', logLevel: 'error', publicDir: false,
      cacheDir: path.join(directory, 'vite-cache'),
      build: { outDir: output, rollupOptions: { input: path.join(root, 'test/canvas-dock-fixture.html') } } }));
    await writeFile(main, `
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { app, BrowserWindow, session } = createRequire(${JSON.stringify(import.meta.url)})('electron');
void (async () => {
app.setPath('userData', ${JSON.stringify(path.join(directory, 'profile'))});
await app.whenReady(); app.dock?.hide();
session.defaultSession.webRequest.onBeforeRequest((details, done) => done({cancel:/^https?:|^wss?:/.test(details.url)}));
const win = new BrowserWindow({show:false,width:1280,height:900,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
const errors = [];
win.webContents.on('console-message', event => { if(event.level === 'error') errors.push(event.message); });
let stage = 'startup';
const timeout = setTimeout(() => { console.error('Canvas dock timeout',stage,errors); app.exit(2); },65000);
const delay = ms => new Promise(resolve => setTimeout(resolve,ms));
const host = expression => win.webContents.executeJavaScript(expression);
const canvas = expression => win.webContents.mainFrame.frames[0].executeJavaScript(expression);
async function waitFor(read, expression) {
  for(let i=0;i<300;i++) { if(await read(expression)) return; await delay(25); }
  throw Error(stage+': timed out: '+expression);
}
async function command(method) {
  await host('document.querySelector("iframe").contentWindow.postMessage({channel:"cheshi:open-pencil:v1",type:"command",id:'+Date.now()+',method:'+JSON.stringify(method)+'},"*")');
  await delay(120);
}
async function clickPoint(point) {
  win.webContents.sendInputEvent({type:'mouseMove',...point});
  win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});
  win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});
  await delay(80);
}
async function canvasClick(selector) {
  const frame = await host('document.querySelector("iframe").getBoundingClientRect().toJSON()');
  const point = await canvas('(() => {const e=document.querySelector('+JSON.stringify(selector)+'); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}})()');
  await clickPoint({x:Math.round(frame.x+point.x),y:Math.round(frame.y+point.y)});
}
async function hostClick(selector) {
  const point = await host('(() => {const r=document.querySelector('+JSON.stringify(selector)+').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');
  await clickPoint(point);
}
async function wheelAt(point, deltaX, deltaY) {
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',...point});
  await delay(80);
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseWheel',...point,deltaX,deltaY});
  await delay(600);
}
async function swipePackets(point, deltas) {
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',...point});
  await delay(80);
  for (const deltaX of deltas) {
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseWheel',...point,deltaX,deltaY:0});
    await delay(30);
  }
  await delay(600);
}
async function assertGeometry() {
  const outer = await host('(() => {const f=document.querySelector("iframe");const d=document.querySelector("[data-canvas-layers]");return {frame:f.getBoundingClientRect().toJSON(),dock:d.getBoundingClientRect().toJSON(),editor:document.querySelector("[aria-label=Canvas]").getBoundingClientRect().toJSON()}})()');
  const inner = await canvas('({dock:document.querySelector(".cheshi-docked-layers").getBoundingClientRect().toJSON(),editor:document.querySelector("[data-test-id=editor-root]").getBoundingClientRect().toJSON()})');
  for(const key of ['dock','editor']) {
    assert.ok(Math.abs(inner[key].x+outer.frame.x-outer[key].x)<1,key+' x');
    assert.ok(Math.abs(inner[key].y+outer.frame.y-outer[key].y)<1,key+' y '+JSON.stringify({outer,inner}));
    assert.ok(Math.abs(inner[key].width-outer[key].width)<1,key+' width');
    assert.ok(Math.abs(inner[key].height-outer[key].height)<1,key+' height');
  }
  assert.equal(await host('(() => {const b=document.querySelector("[data-canvas-path]");const r=b.getBoundingClientRect();return b.contains(document.elementFromPoint(r.x+40,r.y+r.height/2))})()'),true,'File list remains clickable outside iframe clip');
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x:Math.round(outer.dock.x+20),y:Math.round(outer.dock.y+20)});
  await delay(30);
  assert.equal(await host('(() => {const d=document.querySelector("[data-canvas-layers]").getBoundingClientRect();return document.elementFromPoint(d.x+20,d.y+20)?.tagName})()'),'IFRAME','Dock receives native input');
}
try {
  await win.loadFile(${JSON.stringify(path.join(output, 'test/canvas-dock-fixture.html'))},{query:{editor:${JSON.stringify(entry)}}});
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
  await waitFor(host,'!!document.querySelector("iframe")');
  await waitFor(canvas,'(() => {try{return !!window.openPencil?.getStore()}catch{return false}})()');
  await command('new');
  await waitFor(canvas,'!!window.openPencil.getStore().renderer');
  await delay(250);
  stage='initial dock';
  await assertGeometry();
  assert.equal(await host('document.querySelector("[role=separator]").getAttribute("aria-valuenow")'),'50');
  assert.equal(await canvas('[...document.querySelectorAll(".cheshi-panel-rail button")].every(b => b.getAttribute("aria-label") !== "Pages and layers")'),true);
  stage='native layer selection';
  await canvas('(() => {const s=window.openPencil.getStore();window.__firstStore=s;window.__shape=s.createShape("RECTANGLE",50,50,100,100);s.setDocumentSource("one.fig","fig",undefined,"designs/one.fig");s.select([])})()');
  await waitFor(canvas,'!!document.querySelector("[data-test-id=layers-item]")');
  await canvasClick('[data-test-id=layers-item]');
  assert.equal(await canvas('window.openPencil.getStore().state.selectedIds.has(window.__shape)'),true);
  stage='page add and switch';
  const originalPages = await canvas('window.openPencil.getStore().graph.getPages().length');
  await canvasClick('[data-test-id=pages-panel] button[aria-label="Add page"]');
  assert.equal(await canvas('window.openPencil.getStore().graph.getPages().length'),originalPages+1);
  await canvasClick('[data-test-id=pages-item]');
  assert.equal(await canvas('document.querySelectorAll("[data-test-id=layers-item]").length'),1);
  await command('save');
  stage='native split resize';
  const separator = await host('document.querySelector("[role=separator]").getBoundingClientRect().toJSON()');
  const start = {x:Math.round(separator.x+separator.width/2),y:Math.round(separator.y+separator.height/2)};
  win.webContents.sendInputEvent({type:'mouseMove',...start});
  win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...start});
  win.webContents.sendInputEvent({type:'mouseMove',x:start.x,y:start.y-110});
  win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:start.x,y:start.y-110});
  await delay(300);
  assert.ok(Number(await host('document.querySelector("[role=separator]").getAttribute("aria-valuenow")'))<45);
  await assertGeometry();
  stage='document switch';
  await command('new');
  await waitFor(canvas,'window.openPencil.getStore() !== window.__firstStore && !!window.openPencil.getStore().renderer');
  assert.equal(await canvas('document.querySelectorAll("[data-test-id=layers-item]").length'),0);
  await host('document.querySelector("[data-canvas-path]").click()');
  await waitFor(canvas,'window.openPencil.getStore() === window.__firstStore');
  assert.equal(await canvas('document.querySelectorAll("[data-test-id=layers-item]").length'),1);
  stage='independent scrolling';
  await canvas('(() => {const s=window.openPencil.getStore();for(let i=0;i<40;i++)s.createShape("RECTANGLE",i*5,200,10,10);s.select([])})()');
  await delay(100);
  const filePoint = await host('(() => {const e=document.querySelector(".fixture-sidebar section").parentElement;window.__fileScroll=e;const r=e.getBoundingClientRect();return {x:Math.round(r.x+80),y:Math.round(r.y+r.height/2)}})()');
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',...filePoint});
  await delay(80);
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseWheel',...filePoint,deltaY:180,deltaX:0});
  await delay(150);
  const fileScroll = await host('window.__fileScroll.scrollTop');
  assert.ok(fileScroll>0,'File list scrolls: '+JSON.stringify(await host('({height:window.__fileScroll.clientHeight,total:window.__fileScroll.scrollHeight,overflow:getComputedStyle(window.__fileScroll).overflow,tag:window.__fileScroll.tagName})')));
  assert.equal(await canvas('document.querySelector("[data-test-id=layers-scroll]").scrollTop'),0);
  const frameBounds = await host('document.querySelector("iframe").getBoundingClientRect().toJSON()');
  const layerBounds = await canvas('document.querySelector("[data-test-id=layers-scroll]").getBoundingClientRect().toJSON()');
  const layerPoint = {x:Math.round(frameBounds.x+layerBounds.x+80),y:Math.round(frameBounds.y+layerBounds.y+layerBounds.height/2)};
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',...layerPoint});
  await delay(80);
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseWheel',...layerPoint,deltaY:180,deltaX:0});
  await delay(150);
  assert.ok(await canvas('document.querySelector("[data-test-id=layers-scroll]").scrollTop>0'),'Layers scroll independently');
  assert.equal(await host('window.__fileScroll.scrollTop'),fileScroll);
  await host('window.__fileScroll.scrollTop=0');
  stage='Explorer tab scrolling and clicking beside an open Canvas';
  await hostClick('[role=tab][id$="-files"]');
  await delay(600);
  const explorerPoint = await host('(() => {const r=document.querySelector("[role=region][aria-label=Explorer]").getBoundingClientRect();return {x:Math.round(r.x+80),y:Math.round(r.y+120)}})()');
  await wheelAt(explorerPoint,0,180);
  assert.ok(await host('document.querySelector("[role=region][aria-label=Explorer]").scrollTop>0'),'Explorer scrolls while Canvas stays open');
  await hostClick('[data-fixture-row="Explorer-8"]');
  assert.equal(await host('document.querySelector("[data-fixture-row=Explorer-8]").getAttribute("aria-pressed")'),'true','Explorer rows accept native clicks');
  await wheelAt(explorerPoint,320,0);
  await waitFor(host,'document.querySelector("[role=tab][id$=chats]").getAttribute("aria-selected")==="true"');
  await wheelAt(explorerPoint,0,180);
  assert.ok(await host('document.querySelector("[role=region][aria-label=Sessions]").scrollTop>0'),'Session list scrolls after swiping');
  await hostClick('[role=tab][id$="-canvas"]');
  await delay(600);
  stage='Canvas file area swipes to Explorer';
  await wheelAt(filePoint,320,0);
  await waitFor(host,'document.querySelector("[role=tab][id$=files]").getAttribute("aria-selected")==="true"');
  await wheelAt(explorerPoint,-320,0);
  await waitFor(host,'document.querySelector("[role=tab][id$=canvas]").getAttribute("aria-selected")==="true"');
  await delay(200);
  await assertGeometry();
  stage='Canvas layer area swipes to Explorer';
  await wheelAt(layerPoint,320,0);
  await waitFor(host,'document.querySelector("[role=tab][id$=files]").getAttribute("aria-selected")==="true"');
  await wheelAt(explorerPoint,-320,0);
  await waitFor(host,'document.querySelector("[role=tab][id$=canvas]").getAttribute("aria-selected")==="true"');
  await delay(200);
  await assertGeometry();
  stage='Layer swipe reversal and small gesture packets';
  await swipePackets(layerPoint,[80,-80]);
  assert.equal(await host('document.querySelector("[role=tab][id$=canvas]").getAttribute("aria-selected")'),'true','Reversing a short swipe stays on Canvas');
  assert.equal(await host('document.querySelector("[data-sidebar-tab-viewport]").style.scrollSnapType'),'','Snap behavior is restored after reversal');
  await swipePackets(layerPoint,[35,35,35,35,35,35,35,35]);
  await waitFor(host,'document.querySelector("[role=tab][id$=files]").getAttribute("aria-selected")==="true"');
  await wheelAt(explorerPoint,-320,0);
  await waitFor(host,'document.querySelector("[role=tab][id$=canvas]").getAttribute("aria-selected")==="true"');
  await delay(200);
  await assertGeometry();
  stage='context menu outside a short dock';
  await host('(() => {const s=document.querySelector("[role=separator]");s.dispatchEvent(new KeyboardEvent("keydown",{key:"End",bubbles:true}));for(let i=0;i<2;i++)s.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowUp",bubbles:true}))})()');
  await delay(250);
  const menuFrame = await host('document.querySelector("iframe").getBoundingClientRect().toJSON()');
  await canvas('document.querySelector("[data-test-id=layers-scroll]").scrollTop=0');
  await delay(50);
  const layerRow = await canvas('document.querySelector("[data-test-id=layers-item]").getBoundingClientRect().toJSON()');
  const menuPoint = {x:Math.round(menuFrame.x+layerRow.x+40),y:Math.round(menuFrame.y+layerRow.y+2)};
  win.webContents.sendInputEvent({type:'mouseMove',...menuPoint});
  win.webContents.sendInputEvent({type:'mouseDown',button:'right',clickCount:1,...menuPoint});
  win.webContents.sendInputEvent({type:'mouseUp',button:'right',clickCount:1,...menuPoint});
  await waitFor(canvas,'!!document.querySelector("[role=menu][data-state=open]")');
  await delay(250);
  const menuBounds = await canvas('document.querySelector("[role=menu][data-state=open]").getBoundingClientRect().toJSON()');
  const dockTop = await host('document.querySelector("[data-canvas-layers]").getBoundingClientRect().top');
  assert.ok(menuBounds.y+menuFrame.y<dockTop,'Context menu extends above the dock: '+JSON.stringify({menuBounds,dockTop,menuFrame}));
  const menuHit = 'document.elementFromPoint('+Math.round(menuFrame.x+menuBounds.x+10)+','+Math.round(menuFrame.y+menuBounds.y+10)+')?.tagName';
  assert.equal(await host(menuHit),'IFRAME','Popup remains visible and clickable above the dock');
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});
  win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
  await waitFor(canvas,'!document.querySelector("[role=menu][data-state=open]")');
  await delay(100);
  assert.notEqual(await host(menuHit),'IFRAME','Closing the menu restores access to the file list');
  stage='visibility and window resize';
  await host('document.querySelector("[data-toggle-sidebar]").click()');
  await delay(250);
  assert.equal(await canvas('document.querySelector(".cheshi-docked-layers").getBoundingClientRect().width'),0);
  await host('document.querySelector("[data-toggle-sidebar]").click()');
  win.setContentSize(1100,780); await delay(300); await assertGeometry();
  await host('document.querySelector("[data-toggle-active]").click()');
  await delay(100);
  assert.equal(await host('getComputedStyle(document.querySelector("iframe")).visibility'),'hidden');
  await host('document.querySelector("[data-toggle-active]").click()');
  await delay(150); await assertGeometry();
  assert.equal(await canvas('window.openPencil.getStore() === window.__firstStore'),true);
  await host('document.querySelector("[data-unmount]").click()');
  assert.equal(await host('document.querySelector("iframe") === null'),true);
  assert.deepEqual(errors,[]);
  console.log('CANVAS_DOCK_OK');win.destroy();clearTimeout(timeout);app.exit(0);
} catch(error) { console.error(stage,error,errors);win.destroy();clearTimeout(timeout);app.exit(1); }
})();
`);
    const electron = createRequire(import.meta.url)('electron') as string;
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(electron, [main], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', data => { output += String(data); });
      child.stderr.on('data', data => { output += String(data); });
      child.on('error', reject); child.on('close', code => resolve({ code, output }));
    });
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /CANVAS_DOCK_OK/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
