import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const electron = createRequire(import.meta.url)('electron') as string;
const hostUrl = new URL('../lib/ghostty-surface-host.mts', import.meta.url).href;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

test('agent cleanup lets a destroyed Electron window finish workspace shutdown', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cheshi-agent-shutdown-'));
  try {
    const entry = path.join(directory, 'main.cjs');
    const moduleUrl = (name: string) => new URL(`../lib/${name}.mts`, import.meta.url).href;
    await writeFile(entry, `
const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict');
app.setPath('userData',${JSON.stringify(path.join(directory, 'user-data'))});
app.on('window-all-closed',()=>{});
process.on('uncaughtException',error=>{console.error(error);app.exit(1);});
app.whenReady().then(async()=>{
 app.dock?.hide();
 const {AgentTerminalManager}=await import(${JSON.stringify(moduleUrl('agent-management/terminal'))});
 const {registerAgentManagementIpc}=await import(${JSON.stringify(moduleUrl('agent-management/ipc'))});
 const {registerSettingsIpc}=await import(${JSON.stringify(moduleUrl('settings-ipc'))});
 const {registerNotificationEventsIpc}=await import(${JSON.stringify(moduleUrl('notification-events-ipc'))});
 const {registerIMessageIpc}=await import(${JSON.stringify(moduleUrl('imessage-ipc'))});
 const {registerDiscordIpc}=await import(${JSON.stringify(moduleUrl('discord-ipc'))});
 const {closeWorkspaceWindow}=await import(${JSON.stringify(moduleUrl('workspace-application'))});
 for(const hasTerminal of [false,true]){
  const window=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true}});
  await window.loadURL('about:blank');
  let hostCloses=0;
  const terminal=new AgentTerminalManager({window,workingDirectory:${JSON.stringify(directory)},
   engines:[{kind:'test',terminalCommand:async()=>'/usr/bin/true'}],
   createHost:()=>({available:true,sync(){},updatePane(){},setDark(){},setWindowVisible(){},close(){hostCloses++;}})});
  const handlers=new Map();
  const baseline=window.listenerCount('closed');
  const registration=registerAgentManagementIpc({window,terminal,service:{},
   ipc:{handle:(key,fn)=>handlers.set(key,fn),removeHandler:key=>handlers.delete(key)}});
  const shared={window,service:{subscribe:()=>()=>{}},
   ipc:{handle:(key,fn)=>handlers.set(key,fn),removeHandler:key=>handlers.delete(key)}};
  const registrations=[registerSettingsIpc(shared),registerNotificationEventsIpc(shared),
   registerIMessageIpc(shared),registerDiscordIpc({...shared,setup:async()=>''})];
  assert.equal(window.listenerCount('closed'),baseline+1);
  assert.equal(window.getMaxListeners(),10);
  if(hasTerminal)await terminal.open('test:one','worker');
  let completed=false;
  await closeWorkspaceWindow(window,()=>{completed=true;});
  assert.equal(completed,true);
  assert.equal(window.isDestroyed(),true);
  assert.equal(handlers.size,0);
  registration.dispose();terminal.dispose();
  for(const item of registrations)item.dispose();
  assert.equal(hostCloses,hasTerminal?1:0);
 }
 console.log('agent-window-shutdown-ok');app.exit(0);
}).catch(error=>{console.error(error);app.exit(1);});
`);
    const output = await new Promise<string>((resolve, reject) => {
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
      execFile(electron, [entry], { env, timeout: 20_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) reject(new Error(`${error.message}\n${stderr}`)); else resolve(stdout);
      });
    });
    assert.match(output, /agent-window-shutdown-ok/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('native container terminal command runs in a PTY instead of opening the host default shell', { skip: process.platform !== 'darwin' }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cheshi-container-terminal-'));
  try {
    const marker = path.join(directory, 'tty-result');
    const command = `/bin/sh -c ${quote('test -t 0 && test -t 1 && printf native-tty > "$1"')} sh ${quote(marker)}`;
    const entry = path.join(directory, 'main.cjs');
    await writeFile(entry, `
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs');
app.setPath('userData',${JSON.stringify(path.join(directory, 'user-data'))});
app.whenReady().then(async()=>{
 app.dock?.hide();
 const {GhosttySurfaceHost}=await import(${JSON.stringify(hostUrl)});
 const window=new BrowserWindow({show:false,width:600,height:400,webPreferences:{sandbox:true,contextIsolation:true}});
 await window.loadURL('about:blank');
 let failure='';
 const host=new GhosttySurfaceHost({owner:window,workingDirectory:${JSON.stringify(directory)},command:${JSON.stringify(command)},onError:e=>{failure=e.message;}});
 host.sync({paneIds:['test'],visiblePaneIds:['test'],activePaneId:'test',pageVisible:true});
 host.updatePane('test',{x:0,y:0,width:580,height:350},true);
 const deadline=Date.now()+8000;
 while(!fs.existsSync(${JSON.stringify(marker)})&&!failure&&Date.now()<deadline)await new Promise(r=>setTimeout(r,40));
 const passed=fs.existsSync(${JSON.stringify(marker)})&&fs.readFileSync(${JSON.stringify(marker)},'utf8')==='native-tty';
 host.close();window.destroy();
 if(!passed)throw Error(failure||'Native custom command did not produce its PTY marker');
 console.log('native-container-pty-ok');app.exit(0);
}).catch(e=>{console.error(e);app.exit(1);});
`);
    const output = await new Promise<string>((resolve, reject) => {
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
      execFile(electron, [entry], { env, timeout: 20_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) reject(new Error(`${error.message}\n${stderr}`)); else resolve(stdout);
      });
    });
    assert.match(output, /native-container-pty-ok/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
