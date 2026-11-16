import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const source = (relative: string) => new URL(relative, import.meta.url).href;

test('project shutdown cancels real IPC without an Electron handler error or a successful write', { timeout: 45000 }, async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'cheshi-project-shutdown-electron-')));
  try {
    const root = path.join(directory, 'root');
    await mkdir(root);
    const main = path.join(directory, 'main.cjs');
    await writeFile(main, `
const {app,BrowserWindow,ipcMain,clipboard,shell}=require('electron');
const assert=require('node:assert/strict');
app.setPath('userData',${JSON.stringify(path.join(directory, 'profile'))});
setTimeout(()=>{console.error('Shutdown test timeout');app.exit(2)},30000);
app.whenReady().then(async()=>{
  app.dock?.hide();
  const {WorkspaceIpcRouter}=await import(${JSON.stringify(source('../lib/workspace-ipc-router.mts'))});
  const {createWorkspaceProjects}=await import(${JSON.stringify(source('../lib/workspace-project-runtime.mts'))});
  const router=new WorkspaceIpcRouter(ipcMain),scope=router.createScope();
  const win=new BrowserWindow({show:false,webPreferences:{
    preload:${JSON.stringify(fileURLToPath(new URL('../runtime/preload.cjs', import.meta.url)))},
    contextIsolation:true,sandbox:true
  }});
  scope.addOwner(win.webContents);
  scope.ipc.on('cheshi:get-workspace-metadata',event=>{
    event.returnValue={workspaceName:'Fixture',workspaceRoot:${JSON.stringify(root)}};
  });
  let cancelNext=false,dispatched=0,writes=0,checks=0;
  const projects=createWorkspaceProjects({
    root:${JSON.stringify(root)},dataRoot:${JSON.stringify(path.join(directory, 'data'))},
    clipboard,shell,languageOptions:{settingsPath:${JSON.stringify(path.join(directory, 'languages.json'))},clientInfo:{name:'test',version:'1'}},
    assertSender(event){
      checks++;
      assert.equal(event.sender,win.webContents);
      assert.equal(event.senderFrame,win.webContents.mainFrame);
    },
    assertIdle(){},chooseDirectory:async()=>null,emit(){},
    ipc:{handle(channel,handler){
      scope.ipc.handle(channel,(event,...args)=>{
        const result=handler(event,...args);
        if(cancelNext&&channel==='cheshi:workspace-projects:invoke'){
          cancelNext=false;
          projects.stopAccepting();
        }
        return result;
      });
    }}
  });
  projects.ipc.handle('cheshi:get-git-snapshot',event=>{
    dispatched++;assert.equal(event.sender,win.webContents);return {available:false};
  });
  projects.ipc.handle('cheshi:write-workspace-file',()=>{writes++;return {saved:true};});
  await win.loadURL('data:text/html,<html><body>Shutdown fixture</body></html>');
  const evaluate=expression=>win.webContents.executeJavaScript(expression);
  assert.deepEqual(await evaluate("window.cheshiDesktop.workspaceProjects.invoke('primary','cheshi:get-git-snapshot',[])"),{available:false});
  assert.equal(dispatched,1);
  cancelNext=true;
  const canceled=await evaluate(\`(async()=>{
    const results=[];
    for(const operation of [
      ()=>window.cheshiDesktop.workspaceProjects.invoke('primary','cheshi:get-git-snapshot',[]),
      ()=>window.cheshiDesktop.workspaceProjects.list(),
      ()=>window.cheshiDesktop.writeWorkspaceFile({path:'draft.txt',content:'unsaved text',expectedRevision:'original'})
    ]){
      try{await operation();results.push('unexpected success')}
      catch(error){results.push(error.message)}
    }
    return results;
  })()\`);
  assert.deepEqual(canceled,Array(3).fill('The workspace has closed.'));
  assert.equal(dispatched,1);assert.equal(writes,0);assert.equal(checks,2);
  await projects.dispose();
  scope.dispose();win.destroy();
  console.log('PROJECT_SHUTDOWN_OK');
  app.exit(0);
}).catch(error=>{console.error(error.stack);app.exit(1)});
`);
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(require('electron') as string, [main], { env, encoding: 'utf8', timeout: 35000 });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /PROJECT_SHUTDOWN_OK/u);
    assert.doesNotMatch(result.stderr, /Error occurred in handler|workspace has closed|not the active Cheshi window/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
