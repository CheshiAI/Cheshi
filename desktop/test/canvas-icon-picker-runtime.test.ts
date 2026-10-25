import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('Canvas icon picker keeps one popup surface, a searchable grid, and working close controls', { timeout: 60000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cheshi-icon-picker-'));
  const main = path.join(directory, 'main.mts');
  const entry = fileURLToPath(new URL('../frontend/public/open-pencil/index.html', import.meta.url));
  const screenshot = process.env.CHESHI_ICON_PICKER_SCREENSHOT;
  try {
    await writeFile(main, `
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const { app, BrowserWindow, session } = createRequire(${JSON.stringify(import.meta.url)})('electron');
void (async () => {
app.setPath('userData', ${JSON.stringify(path.join(directory, 'profile'))});
await app.whenReady(); app.dock?.hide();
session.defaultSession.webRequest.onBeforeRequest((details, done) => done({cancel:/^https?:|^wss?:/.test(details.url)}));
const win = new BrowserWindow({show:false,width:1280,height:900,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
const errors = [];
win.webContents.on('console-message', event => { if(event.level === 'error') errors.push(event.message); });
const timeout = setTimeout(() => {console.error('Icon picker timeout',errors); app.exit(2);},45000);
const evaluate = expression => win.webContents.executeJavaScript(expression);
const delay = ms => new Promise(resolve => setTimeout(resolve,ms));
async function waitFor(expression) {
  for(let i=0;i<200;i++) {if(await evaluate(expression)) return; await delay(25);}
  const state=await evaluate('({requests:window.__iconRequests,value:document.querySelector(".cheshi-icon-search input")?.value,items:document.querySelectorAll(".cheshi-icon-picker [role=option]").length,text:document.querySelector(".cheshi-icon-picker")?.textContent})');
  throw Error('Timed out: '+expression+' '+JSON.stringify(state));
}
async function click(selector) {
  const point = await evaluate('(() => {const e=document.querySelector('+JSON.stringify(selector)+');const r=e.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;if(!e.contains(document.elementFromPoint(x,y)))throw Error("Control is obscured");return {x:Math.round(x),y:Math.round(y)}})()');
  win.webContents.sendInputEvent({type:'mouseMove',...point});
  win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});
  win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});
  await delay(100);
}
try {
  await win.loadURL('about:blank');
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Page.enable');
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
  // Only the icon API is replaced; no network or user document is used.
  await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument',{source:\`(() => {
    window.__iconRequests=[];
    const originalFetch=window.fetch.bind(window);
    const icons=Object.fromEntries(Array.from({length:16},(_,i)=>['square'+i,{body:'<path fill="currentColor" d="M2 2h20v20H2z"/>'}]));
    window.fetch=async (input,options) => {
      const url=new URL(typeof input==='string'?input:input.url??String(input),location.href);
      if(url.hostname!=='api.iconify.design')return originalFetch(input,options);
      window.__iconRequests.push(url.pathname);
      const collection={name:'Test icons',total:16,license:{title:'MIT'}};
      const data=url.pathname==='/search'?{icons:Object.keys(icons).map(name=>'test:'+name),total:16,collections:{test:collection}}:
        url.pathname==='/collections'?{test:collection}:url.pathname==='/collection'?{uncategorized:Object.keys(icons)}:
        {prefix:'test',width:24,height:24,icons};
      return new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
    };
  })()\`});
  await win.loadFile(${JSON.stringify(entry)});
  await waitFor('(() => {try{return !!window.openPencil?.getStore()}catch{return false}})()');
  await evaluate(\`window.postMessage({channel:'cheshi:open-pencil:v1',type:'command',id:90001,method:'new'},'*')\`);
  await waitFor(\`!!document.querySelector('button[aria-label="Insert icon"]')\`);
  await click('button[aria-label="Insert icon"]');
  await waitFor('!!document.querySelector(".cheshi-icon-picker input")');
  await delay(250);
  const empty = await evaluate(\`(() => {
    const popup=document.querySelector('.cheshi-icon-picker'),list=popup.querySelector('[role=listbox]');
    const field=popup.querySelector('.cheshi-icon-search'),close=popup.querySelector('button[aria-label=Close]');
    const css=e=>getComputedStyle(e);
    const center=e=>{const r=e.getBoundingClientRect();return r.y+r.height/2};
    return {popupBackground:css(popup).backgroundColor,listBackground:css(list).backgroundColor,
      listBorder:css(list).borderTopWidth,listRadius:css(list).borderTopLeftRadius,
      titleColor:css(popup.querySelector('h3')).color,textColor:css(popup).color,
      fieldHeight:field.getBoundingClientRect().height,fieldOutline:css(field).outlineStyle,
      searchCenter:Math.abs(center(field.querySelector('input'))-center(field.querySelector('svg'))),
      setCenter:Math.abs(center(field.querySelector('input'))-center(field.querySelector('button'))),
      closeWidth:close.getBoundingClientRect().width,closeHeight:close.getBoundingClientRect().height,
      closeRadius:css(close).borderTopLeftRadius,focused:popup.contains(document.activeElement)};
  })()\`);
  assert.notEqual(empty.popupBackground,'rgba(0, 0, 0, 0)');
  assert.equal(empty.listBackground,'rgba(0, 0, 0, 0)');
  assert.equal(empty.listBorder,'0px'); assert.equal(empty.listRadius,'0px');
  assert.equal(empty.titleColor,empty.textColor); assert.equal(empty.fieldHeight,32);
  assert.ok(empty.searchCenter<1,'Search icon must align with the input');
  assert.ok(empty.setCenter<1,'Icon set button must align with the input: '+empty.setCenter);
  assert.equal(empty.closeWidth,22); assert.equal(empty.closeHeight,22); assert.equal(empty.closeRadius,'50%');
  assert.equal(empty.focused,true);
  await click('.cheshi-icon-search input');
  await win.webContents.debugger.sendCommand('Input.insertText',{text:'square'});
  await waitFor('document.querySelectorAll(".cheshi-icon-picker [role=option]").length===16');
  const grid = await evaluate(\`(() => {
    const items=[...document.querySelectorAll('.cheshi-icon-picker [role=option]')];
    const group=items[0].parentElement,first=items[0].getBoundingClientRect(),second=items[1].getBoundingClientRect(),next=items[8].getBoundingClientRect();
    return {display:getComputedStyle(group).display,columns:getComputedStyle(group).gridTemplateColumns.split(' ').length,
      sameRow:Math.abs(first.y-second.y)<1,nextRow:next.y>first.y,square:Math.abs(first.width-first.height)<1};
  })()\`);
  assert.deepEqual(grid,{display:'grid',columns:8,sameRow:true,nextRow:true,square:true});
  if(${JSON.stringify(screenshot ?? null)})await writeFile(${JSON.stringify(screenshot ?? '')},(await win.webContents.capturePage()).toPNG());
  await click('.cheshi-icon-picker button[aria-haspopup=listbox]');
  await waitFor('[...document.querySelectorAll("[role=listbox]")].some(e=>!e.closest(".cheshi-icon-picker"))');
  await waitFor('document.getAnimations().every(animation=>animation.playState!=="running")');
  const setSearch=await evaluate(\`(() => {
    const input=document.querySelector('input[placeholder="Search icon sets..."]'),field=input.parentElement;
    const icon=field.querySelector('svg'),r=input.getBoundingClientRect(),i=icon.getBoundingClientRect();
    return {height:field.getBoundingClientRect().height,center:Math.abs(r.y+r.height/2-i.y-i.height/2),
      variant:field.dataset.variant,border:getComputedStyle(field).borderTopWidth,outline:getComputedStyle(input).outlineStyle};
  })()\`);
  assert.equal(setSearch.height,32); assert.equal(setSearch.variant,'standard');
  assert.ok(setSearch.center<1,'Icon set search icon must align with the input');
  assert.equal(setSearch.border,'0px'); assert.equal(setSearch.outline,'none');
  if(${JSON.stringify(screenshot ?? null)})await writeFile(${JSON.stringify(screenshot?.replace(/\.png$/, '-sets.png') ?? '')},(await win.webContents.capturePage()).toPNG());
  assert.equal(await evaluate(\`getComputedStyle([...document.querySelectorAll('[role=listbox]')].find(e=>!e.closest('.cheshi-icon-picker'))).borderTopWidth\`),'1px');
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});
  win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
  await delay(150);
  await click('.cheshi-icon-picker button[aria-label=Close]');
  await waitFor('!document.querySelector(".cheshi-icon-picker")');
  await click('button[aria-label="Insert icon"]');
  await waitFor('!!document.querySelector(".cheshi-icon-picker")');
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});
  win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
  await waitFor('!document.querySelector(".cheshi-icon-picker")');
  assert.deepEqual(errors,[]);
  console.log('CANVAS_ICON_PICKER_OK'); win.destroy(); clearTimeout(timeout); app.exit(0);
} catch(error) {console.error(error,errors); win.destroy(); clearTimeout(timeout); app.exit(1);}
})();
`);
    const electron = createRequire(import.meta.url)('electron') as string;
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(electron, [main], { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 50000 });
      let output = '';
      child.stdout.on('data', data => { output += String(data); });
      child.stderr.on('data', data => { output += String(data); });
      child.on('error', reject); child.on('close', code => resolve({ code, output }));
    });
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /CANVAS_ICON_PICKER_OK/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
