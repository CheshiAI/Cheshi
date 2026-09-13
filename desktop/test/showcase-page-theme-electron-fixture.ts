import assert from 'node:assert/strict';
import { app, BrowserWindow, session } from 'electron';
import { pageBackgroundCss, pageBackgroundScript } from '../lib/showcase-page-theme.mts';

const userData = process.env.CHESHI_THEME_TEST_USER_DATA;
assert.ok(userData, 'Use the regression test runner to provide isolated user data.');
app.setPath('userData', userData);
app.commandLine.appendSwitch('disable-gpu');

const html = `<!doctype html><style>
html, body { background: white; color: black; }
#right { background: white; }
.active + #sibling, #paintParent.blue { background-color: rgb(20, 80, 160); }
.unused:has(.active) { color: red; }
#left:has(:is(.active, .ready))::before, #right:has(.active)::after { background: black; }
</style><body>
<section id="left">
  <div id="group"><span id="trigger">Trigger</span><div id="sibling">Sibling</div></div>
  <div id="stableParent"><div id="stableGroup"><span id="stableText">Stable</span></div></div>
  <div id="paintParent"><div id="inheritGroup"><span id="inheritedText">Inherited</span></div></div>
  <div id="control" role="button"><span id="controlText">Control</span></div>
  <div id="moved"><div id="deep"><span id="leaf">Move me</span></div></div>
</section><section id="right">Unrelated</section></body>`;

async function run() {
  await app.whenReady();
  app.dock?.hide();
  const isolated = session.fromPartition('showcase-theme-regression');
  await isolated.protocol.handle('https', () => new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  }));
  const window = new BrowserWindow({ show: false, webPreferences: {
    session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
  } });
  const execute = (code: string) => window.webContents.executeJavaScriptInIsolatedWorld(1001, [{ code }]);
  try {
    await window.loadURL('https://cheshi-theme.test/');
    await execute(`globalThis.themeReads = [];
      const nativeGetComputedStyle = globalThis.getComputedStyle;
      globalThis.getComputedStyle = (element, ...args) => {
        themeReads.push(element.id || element.tagName);
        return nativeGetComputedStyle(element, ...args);
      }; undefined;`);
    assert.equal(await execute('document.hidden'), false, 'Hidden test window must allow scheduled updates.');
    await execute(pageBackgroundScript('#1E2025'));
    const css = await window.webContents.insertCSS(pageBackgroundCss('#1E2025'), { cssOrigin: 'user' });
    const snapshot = () => execute(`({
      body: nativeGetComputedStyle(document.body).backgroundColor,
      sibling: nativeGetComputedStyle(document.getElementById('sibling')).backgroundColor,
      siblingText: nativeGetComputedStyle(document.getElementById('sibling')).color,
      stableText: nativeGetComputedStyle(document.getElementById('stableText')).color,
      inheritedText: nativeGetComputedStyle(document.getElementById('inheritedText')).color,
      leaf: nativeGetComputedStyle(document.getElementById('leaf')).color,
      right: nativeGetComputedStyle(document.getElementById('right')).backgroundColor,
      measuring: document.documentElement.hasAttribute('data-cheshi-page-measuring'),
      reads: [...themeReads],
    })`);
    const change = async (code: string) => {
      await execute(`themeReads.length = 0; ${code}`);
      await execute('new Promise(resolve => setTimeout(resolve, 350))');
      return snapshot();
    };

    let result = await snapshot();
    assert.equal(result.body, 'rgb(30, 32, 37)');
    assert.equal(result.stableText, 'rgb(255, 255, 255)');
    assert.equal(result.reads.includes('controlText'), false);
    assert.equal(result.measuring, false);

    result = await change("document.getElementById('trigger').className = 'active'");
    assert.equal(result.sibling, 'rgb(20, 80, 160)');
    assert.equal(result.siblingText, 'rgb(0, 0, 0)');
    assert.equal(result.reads.includes('right'), false);
    assert.equal(result.measuring, false);

    result = await change("document.getElementById('stableText').className = 'updated'");
    assert.equal(result.stableText, 'rgb(255, 255, 255)');
    assert.equal(result.reads.includes('stableParent'), false);
    assert.equal(result.measuring, false);

    result = await change(`const anchor = document.createElement('div'); anchor.className = 'unused';
      document.getElementById('group').append(anchor);`);
    assert.equal(result.reads.includes('right'), true);
    result = await change("document.querySelector('.unused').remove()");
    assert.equal(result.reads.includes('right'), false);

    result = await change("document.getElementById('paintParent').className = 'blue'");
    assert.equal(result.inheritedText, 'rgb(0, 0, 0)');
    result = await change("document.getElementById('control').append(document.getElementById('moved'))");
    assert.equal(result.leaf, 'rgb(0, 0, 0)');
    result = await change("document.getElementById('leaf').className = 'updated'");
    assert.equal(result.leaf, 'rgb(0, 0, 0)');

    result = await change(`const style = document.createElement('style');
      style.textContent = '#left:has(.active)::before, body:has(#trigger.active) #right { background-color: rgb(20, 80, 160); }';
      document.getElementById('group').append(style);`);
    assert.equal(result.right, 'rgb(20, 80, 160)');
    assert.equal(result.reads.includes('right'), true);
    assert.equal(result.measuring, false);
    result = await change("document.getElementById('trigger').className = ''");
    assert.equal(result.right, 'rgb(30, 32, 37)');
    assert.equal(result.reads.includes('right'), true);

    assert.equal(await execute(`document.documentElement.setAttribute('data-cheshi-page-measuring', '');
      const originalBackground = nativeGetComputedStyle(document.body).backgroundColor;
      document.documentElement.removeAttribute('data-cheshi-page-measuring'); originalBackground;`), 'rgb(255, 255, 255)');
    await execute(pageBackgroundScript(null));
    await window.webContents.removeInsertedCSS(css);
    assert.equal(await execute("document.querySelectorAll('[data-cheshi-page-background], [data-cheshi-page-foreground]').length"), 0);
    assert.equal((await snapshot()).measuring, false);
    process.stdout.write('SHOWCASE_THEME_RESULT passed\n');
  } finally {
    window.destroy();
    isolated.protocol.unhandle('https');
  }
}

void run().then(() => app.quit(), error => {
  process.stderr.write(`${String(error.stack ?? error)}\n`);
  app.exit(1);
});
setTimeout(() => app.exit(2), 15_000).unref();
