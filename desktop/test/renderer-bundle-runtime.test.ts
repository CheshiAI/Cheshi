import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build, createLogger, mergeConfig } from 'vite';
import viteConfig from '../frontend/vite.config.ts';

test('production renderer chunks stay within budget and initialize together in Electron', { timeout: 90_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cheshi-renderer-bundle-'));
  const output = path.join(directory, 'renderer');
  try {
    const warnings: string[] = [];
    const logger = createLogger('warn');
    const result = await build(mergeConfig(viteConfig, {
      configFile: false, root: fileURLToPath(new URL('../frontend', import.meta.url)),
      publicDir: false, logLevel: 'warn', cacheDir: path.join(directory, 'cache'),
      customLogger: { ...logger, warn(message: string) { warnings.push(message); logger.warn(message); } },
      build: { outDir: output },
    }));
    assert.deepEqual(warnings, [], 'Production builds must not introduce dependency or chunk warnings');
    assert.ok('output' in result);
    for (const chunk of result.output) {
      if (chunk.type === 'chunk') assert.ok(Buffer.byteLength(chunk.code) <= 500_000,
        `${chunk.fileName} exceeds the renderer's 500 kB chunk budget`);
    }
    const main = path.join(directory, 'main.mts');
    await writeFile(main, `
import { createRequire } from 'node:module';
const { app, BrowserWindow, session } = createRequire(import.meta.url)('electron');
void (async () => {
  app.setPath('userData', ${JSON.stringify(path.join(directory, 'profile'))});
  const deadline = setTimeout(() => app.exit(2), 20000);
  await app.whenReady(); app.dock?.hide();
  session.defaultSession.webRequest.onBeforeRequest((details, done) =>
    done({cancel:/^https?:|^wss?:/.test(details.url)}));
  const window = new BrowserWindow({show:false, width:1200, height:800,
    webPreferences:{sandbox:true, contextIsolation:true, backgroundThrottling:false}});
  const errors = [];
  window.webContents.on('console-message', event => {
    if(event.level === 'error') errors.push(event.message);
  });
  try {
    await window.loadFile(${JSON.stringify(path.join(output, 'index.html'))});
    let ready = false;
    for(let i=0; i<200; i++) {
      ready = await window.webContents.executeJavaScript("!!document.querySelector('.app-layout')");
      if(ready || errors.length) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if(!ready || errors.length) throw Error('Renderer initialization failed: '+JSON.stringify({ready,errors}));
    console.log('RENDERER_CHUNKS_READY');
    window.destroy(); clearTimeout(deadline); app.exit(0);
  } catch(error) {
    console.error(error); window.destroy(); clearTimeout(deadline); app.exit(1);
  }
})().catch(error => { console.error(error); app.exit(1); });
`);
    const electron = createRequire(import.meta.url)('electron') as string;
    const child = spawn(electron, [main], {
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', data => { log += String(data); });
    child.stderr.on('data', data => { log += String(data); });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 30000);
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject); child.once('exit', resolve);
      });
      assert.equal(code, 0, log);
      assert.match(log, /RENDERER_CHUNKS_READY/);
    } finally { clearTimeout(timeout); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
