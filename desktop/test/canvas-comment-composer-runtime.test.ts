import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('Canvas comment drafts use shared controls, grow for multiline text, and cancel without posting', { timeout: 60000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cheshi-comment-composer-'));
  const main = path.join(directory, 'main.mts');
  const entry = fileURLToPath(new URL('../frontend/public/open-pencil/index.html', import.meta.url));
  const screenshot = process.env.CHESHI_COMMENT_COMPOSER_SCREENSHOT;
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
win.webContents.on('console-message', event => {if(event.level==='error')errors.push(event.message);});
const timeout=setTimeout(()=>{console.error('Comment composer timeout',errors);app.exit(2);},45000);
const evaluate=expression=>win.webContents.executeJavaScript(expression);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(expression) {
  for(let i=0;i<200;i++){if(await evaluate(expression))return;await delay(25);}
  throw Error('Timed out: '+expression);
}
async function click(x,y) {
  win.webContents.sendInputEvent({type:'mouseMove',x,y});
  win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x,y});
  win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x,y});
  await delay(100);
}
async function key(keyCode,modifiers=[]) {
  win.webContents.sendInputEvent({type:'keyDown',keyCode,modifiers});
  if(keyCode==='Return')win.webContents.sendInputEvent({type:'char',keyCode:'\\r',modifiers});
  win.webContents.sendInputEvent({type:'keyUp',keyCode,modifiers});
  await delay(80);
}
try {
  await win.loadFile(${JSON.stringify(entry)});
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
  await waitFor('(() => {try{return !!window.openPencil?.getStore()}catch{return false}})()');
  await evaluate("window.postMessage({channel:'cheshi:open-pencil:v1',type:'command',id:90002,method:'new'},'*')");
  await waitFor('!!window.openPencil.getStore().renderer');
  // A white test canvas exposes transparent controls without opening any user file.
  await evaluate("document.querySelector('.cheshi-canvas').style.backgroundColor='#fff'");
  await click(700,300); await key('C');
  await waitFor('window.openPencil.getStore().state.activeTool==="COMMENT"');
  await click(700,350);
  await waitFor('!!document.querySelector(".cheshi-comment-draft textarea")');
  await waitFor('document.getAnimations().every(animation=>animation.playState!=="running")');
  const initial=await evaluate(\`(() => {
    const card=document.querySelector('.cheshi-comment-draft'),field=card.querySelector('form');
    const input=field.querySelector('textarea'),button=field.querySelector('button');
    const css=e=>getComputedStyle(e),r=input.getBoundingClientRect(),b=button.getBoundingClientRect();
    return {background:css(card).backgroundColor,shadow:css(card).boxShadow,border:css(card).borderTopWidth,
      pinBackground:css(document.querySelector('[data-slot=comment-pin][data-draft]')).backgroundColor,
      fieldVariant:field.dataset.variant,fieldBackground:css(field).backgroundColor,fieldHeight:field.getBoundingClientRect().height,
      inputHeight:r.height,outline:css(input).outlineStyle,focused:document.activeElement===input,
      buttonWidth:b.width,buttonHeight:b.height,buttonRadius:css(button).borderTopLeftRadius,
      disabled:button.disabled,center:Math.abs(r.y+r.height/2-b.y-b.height/2)};
  })()\`);
  assert.notEqual(initial.background,'rgba(0, 0, 0, 0)');
  assert.equal(initial.shadow,'none');assert.equal(initial.border,'1px');
  assert.equal(initial.fieldVariant,'standard');assert.notEqual(initial.fieldBackground,'rgba(0, 0, 0, 0)');
  assert.equal(initial.outline,'none');assert.equal(initial.focused,true);assert.equal(initial.disabled,true);
  assert.equal(initial.buttonWidth,22);assert.equal(initial.buttonHeight,22);assert.equal(initial.buttonRadius,'50%');
  assert.ok(initial.center<1,'Single-line input and send button must align: '+initial.center);
  await key('Return');
  assert.equal(await evaluate('document.querySelectorAll("[data-slot=comment-pin]:not([data-draft])").length'),0);
  assert.equal(await evaluate('!!document.querySelector(".cheshi-comment-draft")'),true);
  await win.webContents.debugger.sendCommand('Input.insertText',{text:'First line'});
  await key('Return',['shift']);
  await win.webContents.debugger.sendCommand('Input.insertText',{text:'Second line'});
  await waitFor('document.querySelector(".cheshi-comment-draft textarea").value==="First line"+String.fromCharCode(10)+"Second line"');
  await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const multiline=await evaluate(\`(() => {
    const form=document.querySelector('.cheshi-comment-draft form'),input=form.querySelector('textarea'),button=form.querySelector('button');
    return {height:input.getBoundingClientRect().height,disabled:button.disabled,clipped:input.scrollHeight>input.clientHeight+1,
      bottom:Math.abs(input.getBoundingClientRect().bottom-button.getBoundingClientRect().bottom)};
  })()\`);
  assert.ok(multiline.height>initial.inputHeight,'The textarea grows for a second line');
  assert.equal(multiline.clipped,false,'Both lines remain visible');
  assert.equal(multiline.disabled,false);assert.ok(multiline.bottom<1,'Multiline send button stays at the last line');
  const sendPoint=await evaluate('(() => {const r=document.querySelector(".cheshi-comment-draft button").getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');
  win.webContents.sendInputEvent({type:'mouseMove',...sendPoint});
  await waitFor('[...document.querySelectorAll("[role=tooltip]")].some(e=>e.textContent.trim()==="Send")');
  await waitFor('document.getAnimations().every(animation=>animation.playState!=="running")');
  const tooltipState=await evaluate(\`(() => {
    const tip=[...document.querySelectorAll('[role=tooltip]')].find(e=>e.textContent.trim()==='Send');
    const card=document.querySelector('.cheshi-comment-draft'),r=tip.getBoundingClientRect(),c=card.getBoundingClientRect();
    return {above:Number(getComputedStyle(tip).zIndex)>Number(getComputedStyle(card).zIndex),
      overlapping:r.left<c.right&&r.right>c.left&&r.top<c.bottom&&r.bottom>c.top,
      insideViewport:r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight};
  })()\`);
  assert.deepEqual({pinBackground:initial.pinBackground,...tooltipState},
    {pinBackground:'rgba(41, 52, 61, 0.4)',above:true,overlapping:true,insideViewport:true});
  if(${JSON.stringify(screenshot ?? null)})await writeFile(${JSON.stringify(screenshot ?? '')},(await win.webContents.capturePage()).toPNG());
  await key('Escape');
  await waitFor('!document.querySelector(".cheshi-comment-draft")');
  assert.equal(await evaluate('document.querySelectorAll("[data-slot=comment-pin]").length'),0);
  assert.deepEqual(errors,[]);
  console.log('CANVAS_COMMENT_COMPOSER_OK');win.destroy();clearTimeout(timeout);app.exit(0);
} catch(error){console.error(error,errors);win.destroy();clearTimeout(timeout);app.exit(1);}
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
    assert.match(result.output, /CANVAS_COMMENT_COMPOSER_OK/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
