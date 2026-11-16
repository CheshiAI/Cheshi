import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const electronPath = createRequire(import.meta.url)('electron') as string;
const adapterUrl = new URL('../lib/development-devtools.mts', import.meta.url).href;
const frameDocument = `<meta http-equiv="Content-Security-Policy" content="script-src 'none'"><p>Sandboxed document</p>`;
const displayScript = `(() => {
  const frame = document.createElement('iframe');
  frame.sandbox = 'allow-same-origin';
  frame.srcdoc = ${JSON.stringify(frameDocument)};
  document.getElementById('root').replaceChildren(frame);
})()`;

// Standalone hidden windows; no access to the user's running app or data.
test('development DevTools keeps sandboxed frames quiet across opening, reload and reopening', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cheshi-devtools-'));
  try {
    const htmlPath = path.join(directory, 'index.html');
    await writeFile(htmlPath, '<!doctype html><div id="root"></div>');
    const mainPath = path.join(directory, 'main.cjs');
    await writeFile(mainPath, `
const {app, BrowserWindow} = require('electron');
app.setPath('userData', ${JSON.stringify(path.join(directory, 'user-data'))});
app.commandLine.appendSwitch('disable-gpu');
const pause = () => new Promise(resolve => setTimeout(resolve, 200));
let stage = 'startup';
app.whenReady().then(async () => {
  app.dock?.hide();
  const {installDevelopmentDevTools} = await import(${JSON.stringify(adapterUrl)});
  const failures = [];
  const dispose = installDevelopmentDevTools(app, error => failures.push(String(error)));
  const owner = new BrowserWindow({show:false, webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  const blocked = [];
  owner.webContents.on('console-message', event => {
    if (event.message.includes('Blocked script execution')) blocked.push(event.message);
  });
  await owner.loadFile(${JSON.stringify(htmlPath)});
  const display = async () => {
    await owner.webContents.executeJavaScript(${JSON.stringify(displayScript)});
    await pause();
  };
  let tools;
  let openings = 0;
  const openTools = async () => {
    stage = 'opening DevTools '+(++openings);
    const opened = new Promise(resolve => owner.webContents.once('devtools-opened', resolve));
    owner.webContents.openDevTools({mode:'right',activate:false});
    await opened;
    tools = owner.webContents.devToolsWebContents;
    stage = 'DevTools ready';
    await pause();
    // A Performance-panel activation must not re-enable automatic injection.
    await tools.executeJavaScript("import('./models/live-metrics/live-metrics.js').then(module => module.LiveMetrics.instance().enable())");
  };
  const closeTools = async () => {
    stage = 'closing DevTools';
    if (owner.webContents.isDevToolsOpened()) {
      const closed = new Promise(resolve => owner.webContents.once('devtools-closed', resolve));
      owner.webContents.closeDevTools();
      await closed;
    }
  };
  await display();
  const beforeOpen = blocked.length;
  await openTools();
  await display();
  const firstOpen = blocked.length;
  stage = 'reloading owner';
  const ownerReloaded = new Promise(resolve => owner.webContents.once('did-finish-load', resolve));
  owner.webContents.reload();
  await ownerReloaded;
  await display();
  const afterOwnerReload = blocked.length;
  await closeTools();
  await openTools();
  await display();
  const reopened = blocked.length;
  stage = 'reloading DevTools';
  const toolsReloaded = new Promise(resolve => tools.once('did-finish-load', resolve));
  tools.reload();
  await toolsReloaded;
  await pause();
  await display();
  const afterToolsReload = blocked.length;
  const sandbox = await owner.webContents.executeJavaScript('document.querySelector("iframe").getAttribute("sandbox")');
  // Do not suppress actual security errors: an injected script must still be blocked.
  await owner.webContents.executeJavaScript('document.querySelector("iframe").srcdoc="<script>parent.compromised=true</script>"');
  await pause();
  const compromised = await owner.webContents.executeJavaScript('Object.hasOwn(window,"compromised")');
  process.stdout.write('DEVTOOLS_RESULT '+JSON.stringify({beforeOpen,firstOpen,afterToolsReload,afterOwnerReload,reopened,sandbox,compromised,attackBlocked:blocked.length>afterToolsReload,hidden:!owner.isVisible(),failures})+'\\n');
  await closeTools();
  owner.destroy(); dispose(); app.quit();
}).catch(error => { process.stderr.write(String(error.stack)); app.exit(1); });
setTimeout(() => { process.stderr.write('Timed out: '+stage); app.exit(2); }, 20000).unref();
`);
    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    const syntax = spawnSync(process.execPath, ['--check', mainPath], { encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
    const child = spawnSync(electronPath, [mainPath], { env: environment, encoding: 'utf8', timeout: 30000 });
    assert.equal(child.status, 0, child.error?.message || child.stderr || `Electron terminated with ${child.signal}`);
    const line = child.stdout.split('\n').find(value => value.startsWith('DEVTOOLS_RESULT '));
    assert.ok(line, child.stdout || child.stderr);
    assert.deepEqual(JSON.parse(line.slice('DEVTOOLS_RESULT '.length)), {
      beforeOpen: 0, firstOpen: 0, afterToolsReload: 0, afterOwnerReload: 0, reopened: 0,
      sandbox: 'allow-same-origin', compromised: false, attackBlocked: true, hidden: true, failures: [],
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
