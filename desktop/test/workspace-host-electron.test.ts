import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const electron = createRequire(import.meta.url)('electron') as string;
const hostModule = fileURLToPath(new URL('../lib/workspace-host.mts', import.meta.url));
const routerModule = fileURLToPath(new URL('../lib/workspace-ipc-router.mts', import.meta.url));
const surfaceModule = fileURLToPath(new URL('../lib/workspace-surface.mts', import.meta.url));
const applicationModule = fileURLToPath(new URL('../lib/workspace-application.mts', import.meta.url));

for (const activeRoot of ['/one', '/two']) {
  test(`destroying the native host disposes both workspaces without activating another tab (${activeRoot})`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'cheshi-workspace-shutdown-'));
    try {
      const script = path.join(directory, 'main.cjs');
      await writeFile(script, `
const {app,ipcMain,BrowserWindow}=require('electron');
const assert=require('node:assert/strict');
app.setPath('userData',${JSON.stringify(path.join(directory, 'user-data'))});
process.env.CODEGRAPH_DATA_ROOT=app.getPath('userData');
app.on('window-all-closed',()=>{});
process.on('uncaughtException',error=>{console.error(error.stack);app.exit(1)});
delete process.env.CHESHI_RENDERER_URL;
setTimeout(()=>{console.error('Shutdown test timed out');app.exit(1)},15000);
app.whenReady().then(async()=>{
  app.dock?.hide();
  const {WorkspaceHost}=await import(${JSON.stringify(hostModule)});
  const {WorkspaceIpcRouter}=await import(${JSON.stringify(routerModule)});
  const router=new WorkspaceIpcRouter(ipcMain),activations=[];
  const host=new WorkspaceHost(router.createScope(),undefined,root=>activations.push(root));
  const windows=[],closed=[];
  for(const root of ['/one','/two']){
    const scope=router.createScope();
    const window=host.createWindow({webPreferences:{sandbox:true}},scope,root);
    scope.addOwner(window.webContents);
    window.once('closed',()=>{closed.push(root);scope.dispose()});
    await window.loadURL('data:text/html,<p>Shutdown fixture</p>');
    windows.push(window);
  }
  windows[${activeRoot === '/one' ? 0 : 1}].show();
  const before=activations.slice();
  host.window.destroy();
  const end=Date.now()+3000;
  while(closed.length!==2){if(Date.now()>end)throw Error('Workspace disposal timed out');await new Promise(r=>setTimeout(r,20))}
  // Allow delayed load rejection and destroyed callbacks to finish as well.
  await new Promise(r=>setTimeout(r,100));
  assert.equal(host.window.isDestroyed(),true);
  assert.equal(windows.every(window=>window.isDestroyed()),true);
  assert.deepEqual(closed.sort(),['/one','/two']);
  assert.deepEqual(activations,before);
  assert.equal(BrowserWindow.getAllWindows().length,0);
  console.log('WORKSPACE_SHUTDOWN_OK');app.exit(0);
}).catch(error=>{console.error(error.stack);app.exit(1)});
`);
      const environment = { ...process.env };
      delete environment.ELECTRON_RUN_AS_NODE;
      const result = spawnSync(electron, [script], { env: environment, encoding: 'utf8', timeout: 20_000 });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /WORKSPACE_SHUTDOWN_OK/u);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}

test('one real native host retains renderer drafts, background delivery, routing, and guarded close', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cheshi-workspace-host-'));
  const script = path.join(directory, 'main.cjs');
  const preload = path.join(directory, 'fixture-preload.cjs');
  try {
    await writeFile(preload, `const {contextBridge,ipcRenderer}=require('electron');
      contextBridge.exposeInMainWorld('fixture', {
        identity: () => ipcRenderer.invoke('fixture:identity'),
        denied: () => ipcRenderer.invoke('fixture:second-only'),
        reportModal: open => ipcRenderer.send('cheshi:workspace-host:modal', open),
        onEvent: callback => ipcRenderer.on('fixture:event', (_event,value) => callback(value)),
        onCommand: callback => ipcRenderer.on('cheshi:workspace-host:command', (_event,value) => callback(value)),
        onToast: callback => ipcRenderer.on('cheshi:workspace-host:status-toast', (_event,value) => callback(value)),
        onRailBlur: callback => ipcRenderer.on('cheshi:workspace-host:rail-blur', (_event,value) => callback(value))
      });`);
    await writeFile(script, `
const {app,ipcMain,BrowserWindow}=require('electron');
const assert=require('node:assert/strict');
app.setPath('userData',${JSON.stringify(path.join(directory, 'user-data'))});
process.env.CODEGRAPH_DATA_ROOT=app.getPath('userData');
app.on('window-all-closed',()=>{});
delete process.env.CHESHI_RENDERER_URL;
process.on('uncaughtException',error=>{console.error(error.stack);app.exit(1)});
const deadline=setTimeout(()=>{console.error('Host test timed out');app.exit(1)},25000);
app.whenReady().then(async()=>{
  app.dock?.hide();
  const {WorkspaceHost}=await import(${JSON.stringify(hostModule)});
  const {WorkspaceIpcRouter}=await import(${JSON.stringify(routerModule)});
  const {workspaceSurface, nativeWorkspaceWindow, workspaceNativeFrame}=await import(${JSON.stringify(surfaceModule)});
  const {closeWorkspaceWindow,registerWorkspaceWindowCloseConfirmation}=await import(${JSON.stringify(applicationModule)});
  const activations=[];
  const router=new WorkspaceIpcRouter(ipcMain),host=new WorkspaceHost(router.createScope(),undefined,root=>activations.push(root));
  const make=async(root)=>{
    const scope=router.createScope();
    const window=host.createWindow({webPreferences:{preload:${JSON.stringify(preload)},sandbox:true,contextIsolation:true}},scope,root);
    scope.addOwner(window.webContents);
    scope.ipc.handle('fixture:identity',()=>root);
    if(root==='/two') scope.ipc.handle('fixture:second-only',()=>true);
    window.once('closed',()=>scope.dispose());
    await window.loadURL('data:text/html,'+encodeURIComponent('<input aria-label="Draft"><div id="events"></div><script>window.ticks=0;setInterval(()=>window.ticks++,20);window.fixture.onEvent(value=>document.querySelector("#events").textContent+=value);window.addEventListener("beforeunload",event=>{if(document.querySelector("input").value){event.preventDefault();event.returnValue=""}})<\/script>'));
    return window;
  };
  const one=await make('/one'),two=await make('/two');
  const ids=[one.webContents.id,two.webContents.id];
  await one.webContents.executeJavaScript('void window.fixture.onCommand(value=>window.lastCommand=value)');
  for(const window of [one,two]) await window.webContents.executeJavaScript('window.railRegions=[];void window.fixture.onRailBlur(value=>window.railRegions.push(value))');
  one.show();
  const wait=async(fn)=>{const end=Date.now()+8000;while(!await fn()){if(Date.now()>end)throw Error('condition timeout');await new Promise(r=>setTimeout(r,30))}};
  await wait(()=>host.window.webContents.executeJavaScript('document.querySelectorAll("[role=tab]").length===2'));
  const modalState=()=>host.window.webContents.executeJavaScript('window.workspaceHost.state()');
  const dividerState=()=>host.window.webContents.executeJavaScript(\`(()=>{
    const rail=document.querySelector('[aria-label="Application navigation"]');
    const header=document.querySelector('[role="tablist"]').parentElement;
    return [rail,header].map((element,index)=>{
      const style=getComputedStyle(element),rect=element.getBoundingClientRect();
      return {color:index===0?style.borderRightColor:style.borderBottomColor,
        width:rect.width,height:rect.height};
    });
  })()\`);
  const normalDividers=await dividerState();
  await one.webContents.executeJavaScript('window.fixture.reportModal(true)');
  await wait(async()=> (await modalState()).entries.find(entry=>entry.id===ids[0]).modalOpen===true);
  await wait(()=>host.window.webContents.executeJavaScript('!!document.querySelector("[data-modal-open=true]")'));
  const chrome=await host.window.webContents.executeJavaScript(\`(()=>{
    const rail=document.querySelector('[aria-label="Application navigation"]');
    const header=document.querySelector('[role="tablist"]').parentElement;
    return [rail,header].map(element=>({inert:element.inert,dim:getComputedStyle(element,'::after').backgroundColor}));
  })()\`);
  assert.deepEqual(chrome,[{inert:true,dim:'rgba(0, 0, 0, 0.25)'},{inert:true,dim:'rgba(0, 0, 0, 0.25)'}]);
  assert.deepEqual(await dividerState(),normalDividers.map(divider=>({...divider,color:'rgba(0, 0, 0, 0)'})));
  await host.window.webContents.executeJavaScript('Promise.all([window.workspaceHost.activate('+ids[1]+'),window.workspaceHost.close('+ids[1]+'),window.workspaceHost.command({action:"navigate",view:"git"})])');
  assert.equal((await modalState()).activeId,ids[0]);
  assert.equal((await modalState()).entries.length,2);
  assert.equal(await one.webContents.executeJavaScript('window.lastCommand===undefined'),true);
  await one.webContents.executeJavaScript('window.fixture.reportModal("false")');
  await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal((await modalState()).entries.find(entry=>entry.id===ids[0]).modalOpen,true);
  await one.webContents.executeJavaScript('window.fixture.reportModal(false)');
  await wait(()=>host.window.webContents.executeJavaScript('!document.querySelector("[data-modal-open=true]")'));
  assert.deepEqual(await dividerState(),normalDividers);
  await two.webContents.executeJavaScript('window.fixture.reportModal(true)');
  await wait(async()=> (await modalState()).entries.find(entry=>entry.id===ids[1]).modalOpen===true);
  assert.equal(await host.window.webContents.executeJavaScript('!!document.querySelector("[data-modal-open=true]")'),false);
  two.show();
  await wait(()=>host.window.webContents.executeJavaScript('!!document.querySelector("[data-modal-open=true]")'));
  // A reload must release a stale modal even if the old renderer sends no cleanup.
  two.webContents.reload();
  await wait(async()=> (await modalState()).entries.find(entry=>entry.id===ids[1]).modalOpen===false);
  await wait(()=>two.webContents.executeJavaScript('document.querySelector("input")!==null'));
  await two.webContents.executeJavaScript('window.railRegions=[];void window.fixture.onRailBlur(value=>window.railRegions.push(value))');
  one.show();
  for(const surface of [one,two]) await surface.webContents.executeJavaScript('window.toasts=[];void window.fixture.onToast(value=>window.toasts.push(value))');
  const toast={id:1,variant:'success',title:'Keep awake enabled',description:'Your Mac will stay awake.'};
  const sendToast=()=>host.window.webContents.executeJavaScript('window.workspaceHost.showStatusToast('+JSON.stringify(toast)+')');
  assert.equal(await sendToast(),true);
  await wait(()=>one.webContents.executeJavaScript('window.toasts.length===1'));
  assert.equal(await two.webContents.executeJavaScript('window.toasts.length'),0);
  two.show();
  assert.equal(await sendToast(),true);
  await wait(()=>two.webContents.executeJavaScript('window.toasts.length===1'));
  assert.equal(await one.webContents.executeJavaScript('window.toasts.length'),1);
  assert.deepEqual(await two.webContents.executeJavaScript('window.toasts[0]'),toast);
  one.show();
  const colors=await host.window.webContents.executeJavaScript('window.workspaceHost.state().then(state=>state.entries.map(entry=>entry.iconColor))');
  assert.equal(new Set(colors).size,2);
  assert.equal(await host.window.webContents.executeJavaScript('document.querySelectorAll("[role=tab] > span:first-child > span[aria-hidden=true]").length'),2);
  const {workspaceProjectColors}=await import(${JSON.stringify(fileURLToPath(new URL('../../config/workspace-project-colors.mts', import.meta.url)))});
  assert.deepEqual(colors,workspaceProjectColors(app.getPath('userData'),['/one','/two']));
  assert.equal(BrowserWindow.getAllWindows().length,1);
  assert.equal(nativeWorkspaceWindow(one),host.window);
  assert.equal(await one.webContents.executeJavaScript('window.fixture.identity()'),'/one');
  assert.equal(await two.webContents.executeJavaScript('window.fixture.identity()'),'/two');
  assert.equal(await one.webContents.executeJavaScript('window.fixture.denied().then(()=>false,()=>true)'),true);
  // Resize only the visible workspace, skip duplicate bounds, and catch up a
  // retained renderer before revealing it without replacing its web contents.
  const initialFrame=workspaceSurface(one).view.getBounds();
  const hiddenFrame=workspaceSurface(two).view.getBounds();
  const zoomForLayout=host.window.webContents.getZoomFactor();
  const resizedFrame={...initialFrame,width:initialFrame.width-100};
  const sendLayout=async frame=>host.window.webContents.executeJavaScript('window.workspaceHost.layout('+JSON.stringify({
    x:frame.x/zoomForLayout,y:frame.y/zoomForLayout,width:frame.width/zoomForLayout,height:frame.height/zoomForLayout
  })+')');
  let resizeNotifications=0;
  const onResize=()=>resizeNotifications++;
  one.on('resize',onResize);
  await sendLayout(resizedFrame);
  assert.deepEqual(workspaceSurface(one).view.getBounds(),resizedFrame);
  assert.deepEqual(workspaceSurface(two).view.getBounds(),hiddenFrame);
  assert.equal(resizeNotifications,1);
  await sendLayout(resizedFrame);
  workspaceSurface(one).setBounds(resizedFrame);
  assert.equal(resizeNotifications,1);
  one.off('resize',onResize);
  two.show();
  assert.deepEqual(workspaceSurface(two).view.getBounds(),resizedFrame);
  await sendLayout(initialFrame);
  one.show();
  assert.deepEqual(workspaceSurface(one).view.getBounds(),initialFrame);
  // Native resizing must update the visible child before renderer IPC can run.
  // Reject queued viewport measurements from the previous window size.
  const originalBounds=host.window.getBounds();
  const originalContent=host.window.getContentBounds();
  const hiddenBeforeResize=workspaceSurface(two).view.getBounds();
  const assertNativeFrame=()=>{
    const bounds=host.window.getContentBounds(),frame=workspaceSurface(one).view.getBounds();
    assert.equal(frame.x+frame.width,bounds.width);
    assert.equal(frame.y+frame.height,bounds.height);
  };
  let nativeResizeEvents=0;
  const verifyNativeResize=()=>{assertNativeFrame();nativeResizeEvents++};
  host.window.on('resize',verifyNativeResize);
  host.window.setBounds({...originalBounds,width:originalBounds.width+120,height:originalBounds.height+80},false);
  assertNativeFrame();
  assert.ok(nativeResizeEvents>0);
  assert.deepEqual(workspaceSurface(two).view.getBounds(),hiddenBeforeResize);
  const stale={...initialFrame,viewport:{width:originalContent.width/zoomForLayout,height:originalContent.height/zoomForLayout}};
  await host.window.webContents.executeJavaScript('window.workspaceHost.layout('+JSON.stringify(stale)+')');
  assertNativeFrame();
  host.window.setBounds(originalBounds,false);
  assertNativeFrame();
  host.window.off('resize',verifyNativeResize);
  await wait(async()=>await host.window.webContents.executeJavaScript('innerWidth')===originalContent.width/zoomForLayout);
  // Focus/pointer transitions can still have a rail animation in flight.
  await host.window.webContents.executeJavaScript('window.dispatchEvent(new Event("resize"))');
  await new Promise(resolve=>setTimeout(resolve,100));
  const blurCount=await one.webContents.executeJavaScript('window.railRegions.length');
  await sendLayout(initialFrame);
  await sendLayout(initialFrame);
  assert.equal(await one.webContents.executeJavaScript('window.railRegions.length'),blurCount);
  // A label crossing the rail must be painted by the top native view, while
  // clicks on that continuation still reach the original navigation button.
  const hover=async()=>{
    const point=await host.window.webContents.executeJavaScript('(()=>{const r=document.querySelector("button[aria-label=Github]").getBoundingClientRect();return{x:r.x+20,y:r.y+20}})()');
    host.window.webContents.debugger.attach('1.3');
    try{await host.window.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',...point})}
    finally{host.window.webContents.debugger.detach()}
  };
  await hover();
  const overlay=()=>host.window.contentView.children.find(view=>view.webContents?.getTitle()==='Cheshi Rail Overlay');
  await wait(()=>overlay()?.getVisible());
  assert.equal(host.window.contentView.children.at(-1),overlay());
  assert.equal(overlay().getBounds().x,workspaceSurface(one).view.getBounds().x);
  assert.equal(await overlay().webContents.executeJavaScript('document.getElementById("label").textContent'),'Github');
  await wait(()=>one.webContents.executeJavaScript('window.railRegions.at(-1)!=null'));
  const region=await one.webContents.executeJavaScript('window.railRegions.at(-1)');
  const button=await host.window.webContents.executeJavaScript('(()=>{const r=document.querySelector("button[aria-label=Github]").getBoundingClientRect();return{x:r.x,y:r.y}})()');
  const frame=workspaceSurface(one).view.getBounds(),zoom=host.window.webContents.getZoomFactor();
  assert.equal(region.x,button.x*zoom-frame.x);
  assert.equal(region.y,button.y*zoom-frame.y);
  assert.equal(await two.webContents.executeJavaScript('window.railRegions.length'),0);
  const railBackground=await host.window.webContents.executeJavaScript('getComputedStyle(document.querySelector("button[aria-label=Github]")).backgroundColor');
  assert.equal(railBackground,'rgba(41, 52, 61, 0.8)');
  assert.equal(await overlay().webContents.executeJavaScript('getComputedStyle(document.getElementById("button")).backgroundColor'),railBackground);
  overlay().webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x:5,y:15});
  overlay().webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:5,y:15});
  await wait(async()=>await one.webContents.executeJavaScript('window.lastCommand?.view==="git"'));
  await wait(()=>!overlay().getVisible());
  await wait(()=>one.webContents.executeJavaScript('window.railRegions.at(-1)===null'));
  // New views must cross the native host's command allowlist, not only the React rail.
  await host.window.webContents.executeJavaScript('window.workspaceHost.command({action:"navigate",view:"canvas"})');
  await wait(()=>one.webContents.executeJavaScript('window.lastCommand?.view==="canvas"'));
  assert.equal(await host.window.webContents.executeJavaScript('window.workspaceHost.command({action:"navigate",view:"unknown-view"}).then(()=>false,()=>true)'),true);
  // App re-entry restores the last focused native-host button. It must not
  // reopen a label when the pointer is in the workspace instead of the rail.
  host.window.webContents.sendInputEvent({type:'mouseMove',x:600,y:300});
  host.window.blur();
  await wait(()=>!host.window.isFocused());
  host.window.focus();
  host.window.webContents.focus();
  await wait(()=>host.window.isFocused());
  await new Promise(resolve=>setTimeout(resolve,150));
  assert.equal(await host.window.webContents.executeJavaScript('document.querySelectorAll("[data-rail-expanded]").length'),0,
    'Restoring app focus must not expand a rail button');
  assert.equal(overlay().getVisible(),false);
  await hover();await wait(()=>overlay().getVisible());
  overlay().webContents.sendInputEvent({type:'mouseLeave',x:100,y:100});
  await wait(()=>!overlay().getVisible());
  assert.equal(await host.window.webContents.executeJavaScript('document.querySelectorAll("[data-rail-expanded]").length'),0);
  await wait(()=>one.webContents.executeJavaScript('window.railRegions.at(-1)===null'));
  // Different renderer zoom factors must retain the same physical mask footprint.
  one.webContents.setZoomFactor(1.25);
  await hover();await wait(()=>overlay().getVisible());
  await wait(()=>one.webContents.executeJavaScript('window.railRegions.at(-1)!=null'));
  const scaled=await one.webContents.executeJavaScript('window.railRegions.at(-1)');
  assert.equal(scaled.x,region.x/1.25);assert.equal(scaled.y,region.y/1.25);
  two.show();
  await wait(()=>!overlay().getVisible());
  await wait(()=>one.webContents.executeJavaScript('window.railRegions.at(-1)===null'));
  assert.equal(await two.webContents.executeJavaScript('window.railRegions.some(value=>value!==null)'),false);
  one.webContents.setZoomFactor(1);one.show();
  const click=async(contents,selector)=>{
    host.window.focus();
    const point=await contents.executeJavaScript('(()=>{const r=document.querySelector('+JSON.stringify(selector)+').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()');
    contents.debugger.attach('1.3');
    try {
      await contents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});
      await contents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});
    }finally{contents.debugger.detach()}
  };
  await click(one.webContents,'input');
  one.webContents.debugger.attach('1.3');
  await one.webContents.debugger.sendCommand('Input.insertText',{text:'retained draft'});
  one.webContents.debugger.detach();
  const before=await one.webContents.executeJavaScript('window.ticks');
  await click(host.window.webContents,'[role=tab][title="/two"]');
  await wait(()=>two.isVisible()&&!one.isVisible());
  one.webContents.send('fixture:event','session-complete');
  two.webContents.send('fixture:event','worker-progress');
  await wait(async()=>await one.webContents.executeJavaScript('window.ticks')>before+2);
  await click(host.window.webContents,'[role=tab][title="/one"]');
  await wait(()=>one.isVisible()&&!two.isVisible());
  assert.equal(await one.webContents.executeJavaScript('document.querySelector("input").value'),'retained draft');
  assert.equal(await one.webContents.executeJavaScript('document.querySelector("#events").textContent'),'session-complete');
  assert.equal(await two.webContents.executeJavaScript('document.querySelector("#events").textContent'),'worker-progress');
  assert.deepEqual([one.webContents.id,two.webContents.id],ids);
  // Native visibility changes before React commits the host's selected tab.
  await wait(()=>host.window.webContents.executeJavaScript('document.querySelector("[role=tab][aria-selected=true]")?.title === "/one"'));
  const key=async(key,code)=>{
    const contents=host.window.webContents;
    contents.debugger.attach('1.3');
    try{
      await contents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key,code:key,windowsVirtualKeyCode:code});
      await contents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key,code:key,windowsVirtualKeyCode:code});
    }finally{contents.debugger.detach()}
  };
  await key('ArrowRight',39);
  await wait(async()=>two.isVisible()&&await host.window.webContents.executeJavaScript('document.querySelector("[role=tab][aria-selected=true]")?.title === "/two"'));
  assert.equal(await host.window.webContents.executeJavaScript('document.activeElement.getAttribute("title")'),'/two');
  await key('ArrowLeft',37);
  await wait(async()=>one.isVisible()&&await host.window.webContents.executeJavaScript('document.querySelector("[role=tab][aria-selected=true]")?.title === "/one"'));
  assert.equal(await host.window.webContents.executeJavaScript('document.activeElement.getAttribute("title")'),'/one');
  assert.equal(activations.at(-1),'/one');
  const bounds=workspaceSurface(one).view.getBounds();
  assert.deepEqual(workspaceNativeFrame(one,{x:2,y:3,width:100,height:80}),{x:bounds.x+2,y:bounds.y+3,width:100,height:80});
  let choice=0,confirmations=0;
  registerWorkspaceWindowCloseConfirmation(one,{showMessageBoxSync(parent){assert.equal(parent,host.window);confirmations++;return choice}});
  let canceled=false;try{await closeWorkspaceWindow(one)}catch(error){canceled=/unsaved files/.test(error.message)}
  assert.equal(canceled,true);assert.equal(one.isDestroyed(),false);
  choice=1;await closeWorkspaceWindow(one);
  assert.equal(confirmations,2);assert.equal(one.isDestroyed(),true);assert.equal(two.isDestroyed(),false);
  assert.equal(BrowserWindow.getAllWindows().length,1);
  await closeWorkspaceWindow(two);
  assert.equal(host.window.isDestroyed(),true);
  clearTimeout(deadline);console.log('WORKSPACE_HOST_OK');app.exit(0);
}).catch(error=>{console.error(error.stack);app.exit(1)});
`);
    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(electron, [script], { env: environment, encoding: 'utf8', timeout: 35_000 });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /WORKSPACE_HOST_OK/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
