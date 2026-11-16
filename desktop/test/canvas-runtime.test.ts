import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build, createServer, mergeConfig, type ViteDevServer } from 'vite';
import viteConfig from './canvas-sdk.vite.config.ts';

// A hidden test window and isolated storage. Does not launch or control the development app.
const development = process.env.CHESHI_CANVAS_TEST_DEV === '1';
test(`${development ? 'development' : 'bundled'} OpenPencil renders offline, edits Korean text, saves through workers and reopens`, { timeout: 90000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cheshi-canvas-runtime-'));
  let developmentServer: ViteDevServer | undefined;
  try {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const output = path.join(directory, 'renderer');
    const config = mergeConfig(viteConfig, { configFile: false, root, base: development ? '/' : './', logLevel: 'error',
      publicDir: path.join(root, 'frontend/public'),
      cacheDir: path.join(directory, 'vite-cache'),
      server: { host: '127.0.0.1', port: 0 },
      optimizeDeps: { entries: [path.join(root, 'test/canvas-runtime-fixture.html')] },
      build: { outDir: output, rollupOptions: { input: path.join(root, 'test/canvas-runtime-fixture.html') } } });
    if (development) { developmentServer = await createServer(config); await developmentServer.listen(); }
    else {
      await build(config);
      const html = await readFile(path.join(output, 'test/canvas-runtime-fixture.html'), 'utf8');
      await writeFile(path.join(output, 'canvas-runtime-fixture.html'), html.replaceAll('../assets/', './assets/'));
    }
    const developmentOrigin = developmentServer?.resolvedUrls?.local[0]?.replace(/\/$/, '');
    const main = path.join(directory, 'main.mts');
    await writeFile(main, `
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
const { app, BrowserWindow, session } = createRequire(import.meta.url)('electron');
void (async () => {
app.setPath('userData', ${JSON.stringify(path.join(directory, 'user-data'))});
const timeout = setTimeout(() => { console.error('Canvas runtime timed out'); app.exit(1); }, 40000);
await app.whenReady();
app.dock?.hide();
const errors = [], external = [];
const server = createServer(async (request, response) => {
  try {
    const name = new URL(request.url, 'http://localhost').pathname;
    const file = path.join(${JSON.stringify(output)}, name);
    response.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm' : name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : name.endsWith('.html') ? 'text/html' : 'application/octet-stream');
    response.end(await readFile(file));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = ${JSON.stringify(developmentOrigin ?? null)} ?? 'http://127.0.0.1:' + server.address().port;
session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
  const remote = /^https?:/.test(details.url) && !details.url.startsWith(origin + '/');
  if (remote) external.push(details.url);
  callback({ cancel: remote });
});
const window = new BrowserWindow({ show: false, width: 1100, height: 800, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
window.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
const evaluate = expression => window.webContents.executeJavaScript(expression);
try {
  if (${development}) await window.loadURL(origin + '/test/canvas-runtime-fixture.html');
  else await window.loadFile(${JSON.stringify(path.join(output, 'canvas-runtime-fixture.html'))});
  let ready = false;
  for (let i = 0; i < 200; i++) {
    const state = await evaluate('window.canvasFixture && ({ready: canvasFixture.ready, error: canvasFixture.error})');
    if (state?.error) throw new Error(state.error);
    if (state?.ready) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  if (!ready) throw new Error('Canvas not ready: ' + errors.join('; '));
  const result = await evaluate(\`(async () => {
    try {
    const runtime = canvasFixture.runtime, editor = runtime.editor;
    editor.setPageColor({r: 0.9, g: 0.8, b: 0.7, a: 1});
    const cardId = editor.createShape('RECTANGLE', 500, 500, 160, 120);
    editor.updateNodeWithUndo(cardId, {fills: [{type: 'SOLID', color: {r: 1, g: 1, b: 1, a: 1}, opacity: 1, visible: true}]}, 'White card');
    const id = editor.createShape('TEXT', 40, 50, 280, 40);
    editor.updateNodeWithUndo(id, {text: '체시', fontFamily: 'Nanum Gothic'}, 'Korean text');
    editor.updateNodeWithUndo(id, {x: 90}, 'Move');
    editor.undoAction();
    const undone = editor.getNode(id).x;
    editor.redoAction();
    const redone = editor.getNode(id).x;
    editor.startTextEditing(id);
    await new Promise(resolve => setTimeout(resolve, 10));
    const input = document.querySelector('textarea[data-canvas-text-input]');
    const hiddenInput = input && getComputedStyle(input).position === 'fixed' && getComputedStyle(input).opacity === '0';
    const changesBeforeTyping = canvasFixture.changes;
    editor.updateTextEditNode(id, {text: '체시 디자인'});
    const typingDirty = canvasFixture.changes > changesBeforeTyping;
    const bytes = await runtime.serialize();
    runtime.fresh();
    await runtime.open(bytes);
    const node = [...editor.graph.getAllNodes()].find(node => node.type === 'TEXT');
    const settleUpdates = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await settleUpdates();
    const updatesBeforeSelection = canvasFixture.updates;
    const changesBeforeSelection = canvasFixture.changes;
    editor.select([node.id]);
    await settleUpdates();
    const selectionRefreshed = canvasFixture.updates > updatesBeforeSelection;
    const selectionStayedClean = canvasFixture.changes === changesBeforeSelection;
    const updatesBeforeTool = canvasFixture.updates;
    editor.setTool('RECTANGLE');
    await settleUpdates();
    const toolRefreshed = canvasFixture.updates > updatesBeforeTool;
    const provider = editor.renderer.getFontProvider();
    const font = editor.renderer.ck.Typeface.MakeFreeTypeFaceFromData(await (await fetch((location.protocol === 'file:' ? './' : '/') + 'canvas-fonts/NanumGothic-Regular.ttf')).arrayBuffer());
    const glyphs = Array.from(font.getGlyphIDs('체시 디자인')).filter(id => id !== 0).length;
    font.delete();
    const canvas = document.querySelector('canvas');
    const sampleBackground = () => {
      const width = canvas.clientWidth;
      const renderer = editor.renderer, ck = renderer.ck;
      const sharedFont = renderer.sizeFont ?? renderer.textFont;
      const originalFontSize = sharedFont.getSize();
      const canvasPrototype = Object.getPrototypeOf(renderer.surface.getCanvas());
      const drawText = canvasPrototype.drawText;
      const rulerFontSizes = [];
      canvasPrototype.drawText = function(text, x, y, paint, font) {
        if (paint === renderer.rulerTextPaint || paint === renderer.rulerLabelPaint) rulerFontSizes.push(font.getSize());
        return drawText.call(this, text, x, y, paint, font);
      };
      try { renderer.renderFromEditorState({...editor.state, panX: 0, panY: 0, zoom: 1}, editor.graph, editor.textEditor, width, 800); }
      finally { canvasPrototype.drawText = drawText; }
      const image = renderer.surface.makeImageSnapshot();
      const pixel = (x, y) => Array.from(image.readPixels(x * devicePixelRatio, y * devicePixelRatio, {
        width: 1, height: 1, colorType: ck.ColorType.RGBA_8888, alphaType: ck.AlphaType.Unpremul, colorSpace: ck.ColorSpace.SRGB,
      }));
      try { return {rulerFontSizes, sharedFontRestored: sharedFont.getSize() === originalFontSize,
        empty: pixel(width - 100, 700), card: pixel(580, 560),
        rulerTop: pixel(467, 3), rulerLeft: pixel(3, 267), rulerCorner: pixel(3, 3),
        topEdge: pixel(467, 15), belowRuler: pixel(467, 16),
        leftEdge: pixel(15, 267), beyondRuler: pixel(16, 267)}; }
      finally { image.delete(); }
    };
    const background = sampleBackground();
    const cachedBackground = sampleBackground();
    const pageColor = {...editor.state.pageColor};
    const graphBeforeResize = JSON.stringify([...editor.graph.getAllNodes()]);
    const viewBeforeSlide = { panX: editor.state.panX, panY: editor.state.panY, zoom: editor.state.zoom };
    const surfaceBeforeSlide = editor.renderer.surface;
    const updatesBeforeSlide = canvasFixture.updates;
    const sidebar = document.getElementById('sidebar');
    const panelFrames = [];
    const samplePanel = () => new Promise(resolve => {
      const start = performance.now();
      const sample = () => {
        panelFrames.push({css: canvas.getBoundingClientRect().width, buffer: canvas.width / devicePixelRatio,
          visible: document.getElementById('canvas').getBoundingClientRect().width});
        if (performance.now() - start < 300) requestAnimationFrame(sample);
        else resolve();
      };
      requestAnimationFrame(sample);
    });
    sidebar.style.width = '362px';
    await samplePanel();
    sidebar.style.width = '42px';
    await samplePanel();
    const panelStable = surfaceBeforeSlide === editor.renderer.surface
      && panelFrames.every(frame => Math.abs(frame.css - frame.buffer) <= 1 && frame.css === panelFrames[0].css)
      && Object.entries(viewBeforeSlide).every(([key, value]) => editor.state[key] === value);
    const panelAnimated = Math.max(...panelFrames.map(frame => frame.visible)) - Math.min(...panelFrames.map(frame => frame.visible)) > 300;
    const panelRefreshed = canvasFixture.updates > updatesBeforeSlide;
    const afterSlideBackground = sampleBackground();
    const oldSurface = editor.renderer.surface;
    document.getElementById('workspace').style.width = '1000px';
    for (let i = 0; i < 40 && oldSurface === editor.renderer.surface; i++) await new Promise(resolve => setTimeout(resolve, 25));
    const resized = oldSurface !== editor.renderer.surface;
    const resizedPixel = sampleBackground().empty;
    const documentUnchanged = graphBeforeResize === JSON.stringify([...editor.graph.getAllNodes()]);
    editor.setTool('SELECT');
    editor.select([]);
    Object.assign(editor.state, {panX: 0, panY: 0, zoom: 1, showRulers: true});
    const guideAxisAt = async (x, y) => {
      const rect = canvas.getBoundingClientRect();
      const event = (type, dx = 0, dy = 0) => canvas.dispatchEvent(new MouseEvent(type,
        {clientX: rect.x + x + dx, clientY: rect.y + y + dy, button: 0, buttons: type === 'mouseup' ? 0 : 1, bubbles: true}));
      event('mousedown'); event('mousemove', 40, 40);
      await settleUpdates();
      const axis = editor.state.guides.preview?.axis ?? null;
      event('mouseup', 40, 40);
      if (axis) editor.undoAction();
      return axis;
    };
    const rulerGuideAxes = [await guideAxisAt(15, 300), await guideAxisAt(16, 300),
      await guideAxisAt(300, 15), await guideAxisAt(300, 16)];
    return {undone, redone, text: node.text, x: node.x, bytes: bytes.length, glyphs, provider: !!provider, hiddenInput, typingDirty, selectionRefreshed, selectionStayedClean, toolRefreshed, canvas: !!canvas, changes: canvasFixture.changes, background, cachedBackground, afterSlideBackground, pageColor, resized, resizedPixel, documentUnchanged, panelStable, panelAnimated, panelRefreshed, rulerGuideAxes};
    } catch (error) { return { runtimeError: String(error), stack: error.stack }; }
  })()\`);
  console.log('CANVAS_RESULT ' + JSON.stringify({ ...result, errors, external }));
  window.destroy(); server.close(); clearTimeout(timeout); app.exit(0);
} catch (error) { console.error(error, errors); window.destroy(); server.close(); clearTimeout(timeout); app.exit(1); }
})();
`);
    const electron = createRequire(import.meta.url)('electron') as string;
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(electron, [main], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let text = '';
      child.stdout.on('data', data => { text += String(data); });
      child.stderr.on('data', data => { text += String(data); });
      child.on('error', reject); child.on('close', code => resolve({ code, output: text }));
    });
    assert.equal(result.code, 0, result.output);
    const line = result.output.split('\n').find(value => value.startsWith('CANVAS_RESULT '));
    assert.ok(line, result.output);
    const report = JSON.parse(line.slice('CANVAS_RESULT '.length));
    assert.equal(report.runtimeError, undefined, JSON.stringify(report));
    assert.equal(report.text, '체시 디자인');
    assert.equal(report.undone, 40); assert.equal(report.redone, 90); assert.equal(report.x, 90);
    assert.ok(report.bytes > 100); assert.ok(report.glyphs >= 5); assert.equal(report.provider, true);
    assert.deepEqual(report.external, []); assert.deepEqual(report.errors, []);
    assert.equal(report.canvas, true); assert.ok(report.changes > 0);
    assert.equal(report.hiddenInput, true, JSON.stringify(report));
    assert.equal(report.typingDirty, true, JSON.stringify(report));
    assert.equal(report.selectionRefreshed, true, JSON.stringify(report));
    assert.equal(report.selectionStayedClean, true, JSON.stringify(report));
    assert.equal(report.toolRefreshed, true, JSON.stringify(report));
    assert.ok(report.background.rulerFontSizes.length > 0, JSON.stringify(report));
    assert.ok(report.background.rulerFontSizes.every((size: number) => size === 9), JSON.stringify(report));
    assert.equal(report.background.sharedFontRestored, true, JSON.stringify(report));
    assert.equal(report.background.empty[3], 0, JSON.stringify(report));
    assert.deepEqual(report.background.card, [255, 255, 255, 255], JSON.stringify(report));
    assert.deepEqual(report.cachedBackground.card, report.background.card, JSON.stringify(report));
    assert.deepEqual(report.afterSlideBackground.card, report.background.card, JSON.stringify(report));
    for (const name of ['rulerTop', 'rulerLeft', 'rulerCorner']) {
      const actual = report.background[name];
      assert.equal(actual[3], 102, JSON.stringify(report));
      [41, 52, 61].forEach((value, channel) => assert.ok(Math.abs(actual[channel] - value) <= 2, JSON.stringify(report)));
    }
    for (const name of ['topEdge', 'leftEdge']) assert.equal(report.background[name][3], 102, JSON.stringify(report));
    for (const name of ['belowRuler', 'beyondRuler']) assert.equal(report.background[name][3], 0, JSON.stringify(report));
    assert.deepEqual(report.rulerGuideAxes, ['x', null, 'y', null], JSON.stringify(report));
    assert.equal(report.panelStable, true, JSON.stringify(report));
    assert.equal(report.panelAnimated, true, JSON.stringify(report));
    assert.equal(report.panelRefreshed, true, JSON.stringify(report));
    for (const [channel, expected] of Object.entries({ r: 0.9, g: 0.8, b: 0.7, a: 1 })) {
      assert.ok(Math.abs(report.pageColor[channel] - expected) < 0.000001, JSON.stringify(report));
    }
    assert.equal(report.resized, true, JSON.stringify(report));
    assert.equal(report.resizedPixel[3], 0, JSON.stringify(report));
    assert.equal(report.documentUnchanged, true, JSON.stringify(report));
  } finally { await developmentServer?.close(); await rm(directory, { recursive: true, force: true }); }
});
