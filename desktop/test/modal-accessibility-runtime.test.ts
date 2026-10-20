import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink as createSymbolicLink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const source = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

test('native modal nesting and editor list replacement preserve the accessibility tree', { timeout: 60000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cheshi-modal-accessibility-'));
  try {
    await mkdir(path.join(directory, 'node_modules'));
    await createSymbolicLink(path.dirname(require.resolve('react/package.json')), path.join(directory, 'node_modules/react'), 'dir');
    const entry = path.join(directory, 'fixture.jsx');
    await writeFile(entry, `
import React from ${JSON.stringify(require.resolve('react'))};
import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
import {flushSync} from ${JSON.stringify(require.resolve('react-dom'))};
import {Modal} from ${JSON.stringify(source('../frontend/src/shared/ui/Modal.tsx'))};
import {WorkspaceEditorAssistPanel} from ${JSON.stringify(source('../frontend/src/features/editor/WorkspaceEditorAssistPanel.tsx'))};
import ${JSON.stringify(source('../frontend/src/shared/styles/tokens.css'))};
const root=createRoot(document.getElementById('app'));
const noop=()=>{};
const states=[
  {kind:'actions',loading:false,error:null,actions:Array.from({length:12},(_,i)=>({title:'Action '+i,kind:'refactor',disabledReason:'Not available'}))},
  {kind:'references',locations:Array.from({length:12},(_,i)=>({path:'file'+i+'.ts',range:{start:{line:i,character:0},end:{line:i,character:1}}})),selectedIndex:0,preview:null,previewLoading:false},
  {kind:'edit-preview',title:'Rename symbol',applying:false,files:[{path:'test.ts',edits:[{line:1,before:'old',after:'new'}]}]},
  {kind:'actions',loading:true,error:null,actions:[]},
];
window.setFixture=(index,depth=0)=>{
  flushSync(()=>root.render(<>
    <button id="trigger">Open modal</button>
    <ul>{Array.from({length:6},(_,i)=><li key={index+':'+i}>Background item {i}</li>)}</ul>
    <WorkspaceEditorAssistPanel state={states[index%states.length]} onApplyEdit={noop} onChooseAction={noop} onClose={noop}
      onOpenReference={noop} onRenameChange={noop} onRenameSubmit={noop} onSelectReference={noop}/>
    {depth>=1&&<Modal title="First" onClose={noop}><ul><li>First dialog item</li></ul><input autoFocus defaultValue="Draft"/></Modal>}
    {depth>=2&&<Modal title="Second" onClose={noop}><ul><li>Second dialog item</li></ul><button autoFocus>Done</button></Modal>}
  </>));
};
window.setFixture(0);
`);
    const build = spawnSync('bun', ['build', entry, '--outdir', directory, '--target', 'browser',
      '--define', 'process.env.NODE_ENV="production"'], { encoding: 'utf8', timeout: 20000 });
    assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);
    const html = path.join(directory, 'index.html');
    await writeFile(html, `<html><head><link rel="stylesheet" href="./fixture.css"><style>
body{margin:0}.workspace-editor-assist-bounds{position:fixed;inset:100px 20px 20px}
.workspace-editor-assist-portal{position:fixed;overflow:auto}
</style></head><body><div id="app"></div><script src="./fixture.js"></script></body></html>`);
    const main = path.join(directory, 'main.cjs');
    await writeFile(main, `
const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict');
app.setPath('userData',${JSON.stringify(path.join(directory, 'profile'))});
app.commandLine.appendSwitch('force-renderer-accessibility');
setTimeout(()=>{console.error('Accessibility test timeout');app.exit(2)},40000);
app.whenReady().then(async()=>{
  app.dock?.hide();
  app.setAccessibilitySupportEnabled(true);
  const win=new BrowserWindow({show:false,width:1100,height:800,webPreferences:{backgroundThrottling:false}});
  const errors=[];
  win.webContents.on('render-process-gone',(_event,details)=>errors.push(JSON.stringify(details)));
  win.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message)});
  await win.loadFile(${JSON.stringify(html)});
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Accessibility.enable');
  const evaluate=expression=>win.webContents.executeJavaScript(expression);
  const settle=()=>new Promise(resolve=>setTimeout(resolve,20));
  let lists=0,snapshots=0;
  for(let index=0;index<12;index++){
    await evaluate('window.setFixture('+index+',0);document.getElementById("trigger").focus()');
    await settle();
    for(const depth of [0,1,2,1,0]){
      await evaluate('window.setFixture('+index+','+depth+')');
      await settle();
      const tree=await win.webContents.debugger.sendCommand('Accessibility.getFullAXTree');
      snapshots++;
      const ids=new Set(tree.nodes.map(node=>node.nodeId));
      for(const node of tree.nodes){
        if(node.role?.value==='listitem'){
          lists++;
          assert.ok(node.parentId&&ids.has(node.parentId),'A list item lost its accessibility parent');
        }
      }
      if(depth){
        const style=await evaluate(\`(()=>{
          const dialogs=[...document.querySelectorAll('dialog')];
          const top=dialogs.find(d=>d.dataset.modalBlurTop==='true');
          const panel=top.querySelector('header').parentElement;
          return {count:dialogs.length,color:getComputedStyle(top,'::backdrop').backgroundColor,
            surface:getComputedStyle(panel).backgroundColor,
            opacity:[top,top.firstElementChild,panel,panel.querySelector('h2')].map(element=>getComputedStyle(element).opacity),
            backgroundFilter:getComputedStyle(document.getElementById('app')).filter,
            modalFilters:document.querySelectorAll('[id^="modal-scene-blur-"]').length,
            focused:top.contains(document.activeElement),
            lower:dialogs.filter(d=>d!==top).map(d=>getComputedStyle(d,'::backdrop').backgroundColor)};
        })()\`);
        assert.equal(style.count,depth);
        assert.equal(style.color,'rgba(0, 0, 0, 0.25)');
        assert.equal(style.surface,'rgba(0, 0, 0, 0.9)');
        assert.deepEqual(style.opacity,['1','1','1','1']);
        assert.equal(style.backgroundFilter,'none');
        assert.equal(style.modalFilters,0);
        assert.equal(style.focused,true);
        assert.ok(style.lower.every(color=>color==='rgba(0, 0, 0, 0)'));
      } else {
        assert.equal(await evaluate('document.activeElement===document.getElementById("trigger")'),true);
      }
    }
  }
  assert.ok(lists>100);
  assert.deepEqual(errors,[]);
  win.destroy();
  console.log('MODAL_ACCESSIBILITY_OK '+JSON.stringify({snapshots,lists}));
  app.exit(0);
}).catch(error=>{console.error(error.stack);app.exit(1)});
`);
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(require('electron') as string, [main], { env, encoding: 'utf8', timeout: 45000 });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.doesNotMatch(result.stderr, /IsMissingParent|Missing parent:|ax_object\.cc/u);
    assert.match(result.stdout, /MODAL_ACCESSIBILITY_OK/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
