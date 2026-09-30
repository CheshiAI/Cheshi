import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { contentSecurityPolicy } from '../frontend/vite.config.ts';

const require = createRequire(import.meta.url);
const electronPath = require('electron') as string;
const rendererPath = fileURLToPath(new URL('./apple-mail-html-renderer.tsx', import.meta.url));

// Independent hidden test window, never the user's Cheshi window or Apple Mail.
test('HTML mail preserves formatting and isolates scripts, resources, links and image consent in Chromium', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cheshi-mail-html-'));
  try {
    const bundlePath = path.join(directory, 'apple-mail-html-renderer.js');
    const build = spawnSync('bun', ['build', rendererPath, '--target=browser', '--format=iife', '--outdir', directory], { encoding: 'utf8' });
    assert.equal(build.status, 0, build.stderr);
    const renderer = await readFile(bundlePath, 'utf8');
    const htmlPath = path.join(directory, 'index.html');
    await writeFile(htmlPath, `<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy('')}">
      <link rel="stylesheet" href="apple-mail-html-renderer.css">
      <style>:root{--space-default:16px;--sidebar-width:320px}*{box-sizing:border-box}#root{width:1200px;height:700px}</style>
      <h1 id="host-title">Host</h1><div id="root"></div>`);
    const mainPath = path.join(directory, 'main.cjs');
    await writeFile(mainPath, `
const { app, BrowserWindow } = require('electron');
app.setPath('userData', ${JSON.stringify(path.join(directory, 'user-data'))});
app.commandLine.appendSwitch('disable-gpu');
app.whenReady().then(async () => {
  app.dock?.hide();
  const window = new BrowserWindow({ show:false, width:1400, height:900, webPreferences:{ contextIsolation:true, nodeIntegration:false, sandbox:true } });
  const requests = [], links = [];
  // Serve deterministic raster bytes without contacting an external server.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=', 'base64');
  window.webContents.session.protocol.handle('https', request => {
    requests.push(request.url);
    return new Response(png, {headers:{'Content-Type':'image/png','Cache-Control':'no-store'}});
  });
  await window.loadFile(${JSON.stringify(htmlPath)});
  window.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*','file://*/*']}, (details, callback) => {
    requests.push(details.url);
    callback({cancel:!['https://mail-fixture.invalid/image.png','https://mail-fixture.invalid/background.png'].includes(details.url)});
  });
  window.webContents.setWindowOpenHandler(({url}) => { links.push(url); return {action:'deny'}; });
  await window.webContents.executeJavaScript(${JSON.stringify(renderer)});
  const prepared = await window.webContents.executeJavaScript('mailChecks.prepare()');
  const blocked = requests.splice(0);
  const allowed = await window.webContents.executeJavaScript('mailChecks.allowImages()');
  const loaded = requests.splice(0);
  const switched = await window.webContents.executeJavaScript('mailChecks.switchMessage()');
  const afterSwitch = requests.splice(0);
  const reselected = await window.webContents.executeJavaScript('mailChecks.reselectMessage()');
  process.stdout.write('MAIL_HTML_RESULT ' + JSON.stringify({prepared,blocked,allowed,loaded,switched,afterSwitch,reselected,links}) + '\\n');
  window.destroy(); app.quit();
}).catch(error => { process.stderr.write(String(error.stack)); app.exit(1); });
setTimeout(() => app.exit(2), 20000).unref();
`);
    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    const child = spawnSync(electronPath, [mainPath], { env: environment, encoding: 'utf8', timeout: 30000, maxBuffer: 2_000_000 });
    assert.equal(child.status, 0, child.error?.message || child.stderr || `Electron terminated with ${child.signal}`);
    const line = child.stdout.split('\n').find(value => value.startsWith('MAIL_HTML_RESULT '));
    assert.ok(line, child.stdout || child.stderr);
    const result = JSON.parse(line.slice('MAIL_HTML_RESULT '.length));
    assert.deepEqual(result.prepared.formatting, { title: 'Newsletter', padding: '16', margin: 'margin:24px', active: 0,
      links: 1, refresh: false, cid: true, unsafeLinks: [null, null, null, null, null], remote: true });
    assert.deepEqual(result.prepared.display, { title: 'Newsletter', font: '37px', background: 'rgb(238, 238, 255)', loadedImage: 1,
      sandbox: 'allow-same-origin', button: 'Load images', hostFont: '32px' });
    assert.equal(result.prepared.compromised, false);
    assert.deepEqual(result.blocked, []);
    assert.equal(result.allowed.button, null);
    assert.equal(result.allowed.source, 'https://mail-fixture.invalid/image.png');
    assert.equal(result.allowed.naturalWidth, 1);
    assert.deepEqual([...new Set(result.loaded)].sort(), ['https://mail-fixture.invalid/background.png', 'https://mail-fixture.invalid/image.png']);
    assert.deepEqual(result.switched, { button: 'Load images', remoteSources: 0 });
    assert.deepEqual(result.afterSwitch, []);
    assert.deepEqual(result.reselected.first, { button: null, naturalWidth: 1 });
    assert.deepEqual(result.reselected.repeated, { button: null, remoteSources: 1 });
    for (const widths of [result.allowed.widths, result.reselected.narrow]) {
      assert.ok(Math.abs(widths.article - widths.frame) <= 1, JSON.stringify(widths));
      assert.ok(Math.abs(widths.available - widths.layout) <= 1, JSON.stringify(widths));
      assert.equal(widths.logo, 160);
      assert.equal(widths.columns, 240);
      assert.equal(widths.overflow, false);
    }
    assert.ok(result.allowed.widths.layout > 600);
    assert.ok(result.reselected.narrow.layout < 600);
    assert.deepEqual(result.links, ['https://example.test/docs']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
