import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('Canvas panel reserves space without moving or flashing artwork during real clicks', { timeout: 90_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cheshi-panel-motion-'));
  const entry = fileURLToPath(new URL('../frontend/public/open-pencil/index.html', import.meta.url));
  const main = path.join(directory, 'main.mts');
  const evidence = process.env.CHESHI_PANEL_MOTION_EVIDENCE ?? '';
  try {
    if (evidence) await mkdir(evidence, { recursive: true });
    await writeFile(main, `
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
const {app,BrowserWindow,session}=createRequire(${JSON.stringify(import.meta.url)})('electron');
void (async()=>{
app.setPath('userData',${JSON.stringify(path.join(directory, 'profile'))});
await app.whenReady();app.dock?.hide();
session.defaultSession.webRequest.onBeforeRequest((details,done)=>done({cancel:/^https?:|^wss?:/.test(details.url)}));
const win=new BrowserWindow({show:false,width:1200,height:800,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
const errors=[];
win.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message)});
const timeout=setTimeout(()=>{console.error('Panel motion timeout');app.exit(2)},60000);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const evaluate=expression=>win.webContents.executeJavaScript(expression);
async function waitFor(expression){
  for(let i=0;i<200;i++){if(await evaluate(expression))return;await delay(25)}
  throw Error('Condition timed out: '+expression);
}
async function click(label){
  const selector='.cheshi-panel-rail button[aria-label="'+label+'"]';
  const point=await evaluate('(() => {const b=document.querySelector('+JSON.stringify(selector)+');const r=b.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;if(!b.contains(document.elementFromPoint(x,y)))throw Error("Obscured rail button");return {x:Math.round(x),y:Math.round(y)}})()');
  win.webContents.sendInputEvent({type:'mouseMove',...point});
  win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});
  win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});
}
function marker(image){
  const {width,height}=image.getSize(),pixels=image.toBitmap();
  let left=width,top=height,right=-1,bottom=-1,count=0;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const i=(y*width+x)*4;
    if(pixels[i]>250&&pixels[i+1]>250&&pixels[i+2]>250&&pixels[i+3]>250){
      left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);count++;
    }
  }
  return {left,top,right,bottom,count};
}
const evidence=${JSON.stringify(evidence)};
let captureId=0;
const summary=[];
try{
  await win.loadFile(${JSON.stringify(entry)});
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
  await waitFor('(() => {try{return !!window.openPencil?.getStore()}catch{return false}})()');
  await evaluate('window.postMessage({channel:"cheshi:open-pencil:v1",type:"command",id:1,method:"new"},"*")');
  await waitFor('!!window.openPencil.getStore().renderer && document.querySelector(".cheshi-canvas-scene")?.dataset.preparing==="false"');
  // A white marker distinguishes artwork from chrome and exposes frame scaling,
  // translation and blank frames. All changes live in this disposable profile.
  await evaluate(\`(()=>{const s=window.openPencil.getStore();
    const id=s.createShape('RECTANGLE',420,100,100,120);
    s.updateNodeWithUndo(id,{fills:[{type:'SOLID',color:{r:1,g:1,b:1,a:1},opacity:1,visible:true}]},'Fixture');
    s.select([]);s.state.zoom=1;s.state.panX=0;s.state.panY=0;s.requestRender();
  })()\`);
  if(evidence)await mkdir(evidence,{recursive:true});
  for(const width of [1200,900]){
    win.setContentSize(width,760);await delay(350);
    const initial=marker(await win.webContents.capturePage());
    assert.ok(initial.count>10000,'Marker must be painted before input');
    for(let cycle=0;cycle<3;cycle++)for(const opening of [true,false]){
      const label=['Pages and layers','Design','Lint'][cycle];
      await evaluate(\`(()=>{
        const s=window.openPencil.getStore();const c=document.querySelector('.cheshi-canvas');
        window.__motion={frames:[],resizes:[],view:[s.state.zoom,s.state.panX,s.state.panY],until:performance.now()+500};
        const observer=new ResizeObserver(entries=>{
          for(const {target} of entries){
            window.__motion.resizes.push({css:target.clientWidth,backing:target.width/devicePixelRatio});
          }
        });
        c.querySelectorAll('canvas').forEach(canvas=>observer.observe(canvas));
        function sample(){const m=window.__motion;if(!m)return;
          const r=c.getBoundingClientRect();m.frames.push({width:r.width,x:r.x,y:r.y,view:[s.state.zoom,s.state.panX,s.state.panY]});
          if(performance.now()<m.until)requestAnimationFrame(sample);else observer.disconnect();
        }requestAnimationFrame(sample);
      })()\`);
      await click(label);
      const pixels=[];const deadline=Date.now()+450;
      do{
        const image=await win.webContents.capturePage();pixels.push(marker(image));
        if(evidence&&cycle===0)await writeFile(evidence+'/'+String(captureId++).padStart(3,'0')+'.png',image.toPNG());
        await delay(16);
      }while(Date.now()<deadline);
      await delay(70);
      const result=await evaluate(\`(()=>{
        const m=window.__motion,c=document.querySelector('.cheshi-canvas').getBoundingClientRect(),
          p=document.querySelector('.cheshi-panel-content').getBoundingClientRect(),
          rail=document.querySelector('.cheshi-panel-rail').getBoundingClientRect(),
          tool=document.querySelector('[data-test-id="toolbar"]').getBoundingClientRect();
        return {frames:m.frames,resizes:m.resizes,view:m.view,canvas:c.toJSON(),panel:p.toJSON(),rail:rail.toJSON(),
          open:document.querySelector('.cheshi-panel-stage').getAttribute('data-open')==='true',
          toolbarCentered:Math.abs((tool.left+tool.right-c.left-c.right)/2)<1};
      })()\`);
      assert.equal(result.open,opening,'Real click must toggle the panel');
      assert.ok(result.frames.length>=8,'Capture enough animation frames');
      for(const f of result.frames){
        assert.deepEqual(f.view,result.view,'Opening a panel must not pan or zoom artwork');
        assert.equal(f.x,result.canvas.x);assert.equal(f.y,result.canvas.y);
      }
      let reversals=0;
      for(let i=1;i<result.frames.length;i++){
        const delta=result.frames[i].width-result.frames[i-1].width;
        if(opening?delta>.1:delta<-.1)reversals++;
      }
      const maxDrift=Math.max(...pixels.flatMap(p=>['left','top','right','bottom'].map(k=>Math.abs(p[k]-initial[k]))));
      const minPaint=Math.min(...pixels.map(p=>p.count/initial.count));
      const maxBackingMismatch=Math.max(...result.resizes.map(r=>Math.abs(r.css-r.backing)));
      summary.push({width,label,cycle,opening,frames:result.frames.length,captures:pixels.length,maxDrift,minPaint,reversals,maxBackingMismatch});
      console.log('PANEL_MOTION_SAMPLE '+JSON.stringify(summary.at(-1)));
      assert.equal(reversals,0,'Viewport width must not oscillate');
      assert.ok(minPaint>.97,'Artwork must not flash blank during the transition');
      assert.ok(maxDrift<=2,'Artwork must not shift/scale more than one CSS pixel');
      assert.ok(result.resizes.length>2,'Observe both raster layers throughout the transition');
      assert.ok(maxBackingMismatch<1,'Raster backing must match layout before paint');
      assert.ok(result.toolbarCentered,'Toolbar must stay centered in the remaining canvas');
      if(opening)assert.ok(Math.abs(result.canvas.right-result.panel.left)<1,'Panel must reserve space instead of overlaying artwork');
      else assert.ok(Math.abs(result.canvas.right-result.rail.left)<1,'Closed panel must release its space');
    }
  }
  assert.deepEqual(errors,[]);
  console.log('PANEL_MOTION_OK '+JSON.stringify({samples:summary.length,errors:errors.length}));
  win.destroy();clearTimeout(timeout);app.exit(0);
}catch(error){console.error(error,errors);win.destroy();clearTimeout(timeout);app.exit(1)}
})();
`);
    execFileSync(process.execPath, ['--check', main], { stdio: 'pipe' });
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const electron = createRequire(import.meta.url)('electron') as string;
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(electron, [main, '--force-device-scale-factor=2'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', data => { output += String(data); });
      child.stderr.on('data', data => { output += String(data); });
      child.on('error', reject); child.on('close', code => resolve({ code, output }));
    });
    if (evidence) await writeFile(path.join(evidence, 'result.log'), result.output);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /PANEL_MOTION_OK/);
    console.log(result.output.split('\n').filter(line => line.startsWith('PANEL_MOTION')).join('\n'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
