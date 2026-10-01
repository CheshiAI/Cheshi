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
  const reply = await window.webContents.executeJavaScript('mailChecks.prepareReply()');
  await window.webContents.insertText('Inline reply text');
  const editedReply = await window.webContents.executeJavaScript('mailChecks.finishReply()');
  const colors = await window.webContents.executeJavaScript('mailChecks.colorDefaults()');
  const fonts = await window.webContents.executeJavaScript('mailChecks.fontSizes()');
  const spacing = await window.webContents.executeJavaScript('mailChecks.readBodyPadding()');
  process.stdout.write('MAIL_HTML_RESULT ' + JSON.stringify({prepared,blocked,allowed,loaded,switched,afterSwitch,reselected,links,reply,editedReply,colors,fonts,spacing}) + '\\n');
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
    assert.equal(result.editedReply.typed, 'Inline reply text');
    assert.equal(result.editedReply.retained, 'Inline reply text');
    assert.equal(result.editedReply.bold, '700');
    assert.equal(result.editedReply.deleted, true);
    assert.deepEqual(result.editedReply.payload, { text: true, title: 'Edited original', bold: true, quote: true, image: true, editable: false });
    assert.deepEqual(result.fonts, {
      before: ['12px', '12px', '12px', '12px', '12px', '24px', '12px', '37px'],
      after: ['12px', '12px', '12px', '12px', '12px', '24px', '12px', '37px'],
      points: ['9pt', '9pt', '9pt', '9pt', '9pt', '9pt'], bare: '9pt', unchanged: true,
      freshDefault: '12px', plainDefault: '12px',
    });
    assert.equal(result.spacing.length, 4);
    for (const spacing of result.spacing) {
      assert.equal(spacing.after.reply.left - spacing.before.reply.left, 16);
      assert.equal(spacing.before.reply.width - spacing.after.reply.width, 32);
      assert.equal(spacing.after.reply.font, spacing.before.reply.font);
      assert.equal(spacing.after.reply.color, spacing.before.reply.color);
      assert.deepEqual(spacing.after.quote, spacing.before.quote);
      assert.deepEqual(spacing.after.nested, spacing.before.nested);
      assert.equal(spacing.quoteUnchanged, true);
      assert.equal(spacing.overflow, false);
    }
    assert.deepEqual(result.colors.cases, [
      { name: 'missing', color: 'rgb(24, 33, 42)', background: 'rgb(255, 255, 255)', sample: 'rgb(192, 32, 48)' },
      { name: 'stylesheet', color: 'rgb(36, 104, 172)', background: 'rgb(244, 229, 154)', sample: 'rgb(36, 104, 172)' },
      { name: 'inline', color: 'rgb(171, 205, 239)', background: 'rgb(18, 52, 86)', sample: 'rgb(192, 32, 48)' },
      { name: 'root', color: 'rgb(238, 238, 238)', background: 'rgb(32, 48, 64)', sample: 'rgb(238, 238, 238)' },
      { name: 'legacy', color: 'rgb(101, 67, 33)', background: 'rgb(254, 220, 186)', sample: 'rgb(101, 67, 33)' },
      { name: 'plain', color: 'rgb(24, 33, 42)', background: 'rgb(255, 255, 255)', sample: 'rgb(24, 33, 42)' },
    ]);
    assert.equal(result.colors.references.length, 5);
    for (const reference of result.colors.references) {
      assert.equal(reference.width, 0, reference.name);
      assert.equal(reference.height, 0, reference.name);
      assert.equal(reference.color, 'rgb(24, 33, 42)', reference.name);
      assert.equal(reference.stable, true, reference.name);
    }
    for (const layout of [result.reply, result.editedReply.narrow]) {
      assert.ok(Math.abs(layout.width - layout.available) <= 1, JSON.stringify(layout));
      assert.equal(layout.below, true);
      assert.equal(layout.focused, true);
      assert.equal(layout.modal, false);
      assert.equal(layout.originalTitle, layout === result.reply ? 'Newsletter' : 'Edited original');
      assert.equal(layout.consent, true);
      assert.equal(layout.overflow, false);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
