import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('Canvas tab closing uses host confirmation and preserves drafts on cancel or save failure', { timeout: 60000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cheshi-canvas-close-'));
  const entry = fileURLToPath(new URL('../frontend/public/open-pencil/index.html', import.meta.url));
  const main = path.join(directory, 'main.mts');
  try {
    await writeFile(main, `
import { createRequire } from 'node:module';
const { app, BrowserWindow, session } = createRequire(import.meta.url)('electron');
void (async () => {
  app.setPath('userData', ${JSON.stringify(path.join(directory, 'profile'))});
  await app.whenReady(); app.dock?.hide();
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({cancel:/^https?:|^wss?:/.test(details.url)}));
  const errors = [];
  const win = new BrowserWindow({show:false,width:1200,height:800,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
  win.webContents.on('console-message', event => {
    if (event.level === 'error' || event.level === 'warning') errors.push(event.message);
  });
  const deadline = setTimeout(() => { console.error('Canvas close timeout', errors); app.exit(2); }, 45000);
  try {
    await win.loadFile(${JSON.stringify(entry)});
    const report = await win.webContents.executeJavaScript(\`(async () => {
      const settle = () => new Promise(resolve => setTimeout(resolve, 80));
      async function until(predicate) {
        for(let i=0;i<200;i++) { if(predicate()) return; await new Promise(resolve=>setTimeout(resolve,25)); }
        throw Error('Canvas close condition timed out');
      }
      await until(() => {try{return !!window.openPencil?.getStore()}catch{return false}});
      let sequence=50000, choice='cancel', failSave=false, confirmations=0, saves=0, savePaths=0, savedBytes=0;
      let promptName='', legacyDialog=false;
      const channel='cheshi:open-pencil:v1';
      function respond(id, payload, error) { window.postMessage({channel,type:'response',id,payload,error},'*'); }
      window.addEventListener('message', event => {
        const message=event.data;
        if(message?.channel!==channel||message.type!=='request') return;
        if(message.method==='confirm-close') {
          confirmations++; promptName=message.payload.documentName;
          legacyDialog ||= !!document.querySelector('[role="alertdialog"]');
          respond(message.id,choice);
        } else if(message.method==='save') {
          saves++; savedBytes=message.payload.data.length;
          if(failSave) respond(message.id,undefined,'Disk write failed');
          else respond(message.id,{path:message.payload.path,revision:'saved'});
        } else if(message.method==='save-path') {
          savePaths++; respond(message.id,null);
        }
      });
      const command = method => new Promise((resolve,reject) => {
        const id=++sequence;
        const timer=setTimeout(()=>reject(Error('Command timed out')),10000);
        function receive(event) {
          const message=event.data;
          if(message?.channel!==channel||message.type!=='result'||message.id!==id) return;
          clearTimeout(timer);window.removeEventListener('message',receive);
          if(message.error) reject(Error(message.error)); else resolve();
        }
        window.addEventListener('message',receive);
        window.postMessage({channel,type:'command',id,method},'*');
      });
      await command('new');
      await until(()=>!!window.openPencil.getStore().renderer);
      const store=window.openPencil.getStore();
      const shape=store.createShape('RECTANGLE',10,20,30,40);
      store.setDocumentSource('close-test.fig','fig',undefined,'close-test.fig');
      store.state.documentName='Close test';
      store.updateNodeWithUndo(shape,{x:90},'Keep draft');
      const tabCount=()=>document.querySelectorAll('[data-test-id="tabbar-tab"]').length;
      const draftIntact=()=>window.openPencil.getStore()===store&&store.hasUnsavedChanges()
        &&store.graph.getNode(shape).x===90&&tabCount()===1;
      async function close(next) {
        choice=next;const before=confirmations;
        document.querySelector('[data-test-id="tabbar-close"][data-active]').click();
        await until(()=>confirmations===before+1);await settle();
      }
      await close('cancel');
      const cancelKeepsDraft=draftIntact()&&saves===0&&promptName==='Close test';
      await close('invalid');
      const invalidKeepsDraft=draftIntact()&&saves===0;
      failSave=true;
      await close('save');await until(()=>saves===1);await settle();
      const failureKeepsDraft=draftIntact();
      failSave=false;
      await close('save');await until(()=>tabCount()===0);
      const saveCloses=saves===2&&savedBytes>100;
      await command('new');await until(()=>!!window.openPencil.getStore().renderer);
      const unsaved=window.openPencil.getStore();
      unsaved.createShape('RECTANGLE',5,5,20,20);
      await close('save');await until(()=>savePaths===1);await settle();
      const savePathCancelKeepsDraft=window.openPencil.getStore()===unsaved&&unsaved.hasUnsavedChanges()&&tabCount()===1&&saves===2;
      await close('discard');await until(()=>tabCount()===0);
      const discardClosesWithoutSave=saves===2;
      return {cancelKeepsDraft,invalidKeepsDraft,failureKeepsDraft,saveCloses,savePathCancelKeepsDraft,discardClosesWithoutSave,legacyDialog};
    })()\`);
    console.log('CANVAS_CLOSE_RESULT '+JSON.stringify({...report,errors}));
    clearTimeout(deadline);win.destroy();app.exit(0);
  } catch(error) {console.error(error,errors);clearTimeout(deadline);win.destroy();app.exit(1);}
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
    const line = result.output.split('\n').find(value => value.startsWith('CANVAS_CLOSE_RESULT '));
    assert.ok(line, result.output);
    const report = JSON.parse(line.slice('CANVAS_CLOSE_RESULT '.length));
    assert.deepEqual(report.errors, [], JSON.stringify(report));
    assert.equal(report.legacyDialog, false);
    for (const key of ['cancelKeepsDraft', 'invalidKeepsDraft', 'failureKeepsDraft', 'saveCloses', 'savePathCancelKeepsDraft', 'discardClosesWithoutSave']) {
      assert.equal(report[key], true, `${key}: ${JSON.stringify(report)}`);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
