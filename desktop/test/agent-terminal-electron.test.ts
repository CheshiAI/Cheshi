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
