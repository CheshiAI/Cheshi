import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { joinCollabRoom } from '../frontend/open-pencil/editor/local-collaboration.ts';

test('local Canvas rejects collaboration before creating a connection', () => {
  assert.throws(() => joinCollabRoom('a'.repeat(32)), /collaboration is disabled/);
});

// Exercise the actual original-editor bundle, its workers, and the host save
// adapter in an isolated Electron profile. Never load a user's document here.
test('original editor runs offline, preserves document features, and has a clean console', { timeout: 90000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cheshi-original-canvas-'));
  const entry = fileURLToPath(new URL('../frontend/public/open-pencil/index.html', import.meta.url));
  const main = path.join(directory, 'main.mts');
  try {
    await writeFile(main, `
import { createRequire } from 'node:module';
const { app, BrowserWindow, session } = createRequire(import.meta.url)('electron');
void (async () => {
  app.setPath('userData', ${JSON.stringify(path.join(directory, 'profile'))});
  app.on('window-all-closed', () => {});
  const timeout = setTimeout(async () => {
    console.error('Original Canvas timeout', await win.webContents.executeJavaScript('window.__testStage'), errors);
    app.exit(2);
  }, 60000);
  await app.whenReady(); app.dock?.hide();
  const errors = [], external = [];
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const remote = /^https?:|^wss?:/.test(details.url);
    if (remote) external.push(new URL(details.url).hostname);
    callback({cancel:remote});
  });
  function createWindow() {
    let stage = 'startup';
    const window = new BrowserWindow({show:false,width:1200,height:800,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
    window.webContents.on('console-message', event => {
      if (event.message.startsWith('CANVAS_STAGE ')) stage = event.message.slice('CANVAS_STAGE '.length);
      if (event.level === 'error' || event.level === 'warning') errors.push(stage + ': ' + event.message);
    });
    return window;
  }
  let win = createWindow();
  const evaluate = expression => win.webContents.executeJavaScript(expression);
  try {
    await win.loadFile(${JSON.stringify(entry)});
    // The hidden test window needs document focus for native focus/blur events.
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', {enabled:true});
    async function initializeDocument() {
    let ready = false;
    for (let i = 0; i < 200; i++) {
      ready = await evaluate('(() => {try{return !!window.openPencil?.getStore()}catch{return false}})()');
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!ready) throw Error('Original editor did not initialize: ' + errors.join('; '));
    const initialHomeEmpty = await evaluate(\`!document.querySelector('[data-test-id="tabbar-tab"], [data-test-id="home-new-document"], [data-test-id="properties-panel"]')\`);
    await evaluate(\`(() => {
      let sequence = 70000;
      window.addEventListener('message', event => {
        if (event.data?.channel === 'cheshi:open-pencil:v1' && event.data.type === 'state') window.__testHostState = event.data.payload;
      });
      window.__canvasTestCommand = (method, payload) => new Promise((resolve, reject) => {
        const id = ++sequence;
        console.info('CANVAS_STAGE ' + method + ' ' + id);
        const timer = setTimeout(() => { window.removeEventListener('message', receive); reject(Error('Bridge timeout')); }, 10000);
        function receive(event) {
          if (event.data?.channel !== 'cheshi:open-pencil:v1' || event.data.type !== 'result' || event.data.id !== id) return;
          clearTimeout(timer); window.removeEventListener('message', receive);
          if (event.data.error) reject(Error(event.data.error)); else resolve();
        }
        window.addEventListener('message', receive);
        window.postMessage({channel:'cheshi:open-pencil:v1',type:'command',id,method,payload}, '*');
      });
      return window.__canvasTestCommand('new');
    })()\`);
    for (let i = 0; i < 200; i++) {
      ready = await evaluate('!!window.openPencil.getStore().renderer');
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!ready) throw Error('New canvas did not initialize');
    // Match the host: the file/page sidebar sits outside the editor's viewport.
    await evaluate('window.postMessage({channel:"cheshi:open-pencil:v1",type:"layout",payload:{editor:{x:320,y:0,width:innerWidth-320,height:innerHeight},layers:{x:0,y:400,width:320,height:innerHeight-400}}},"*")');
    await new Promise(resolve => setTimeout(resolve, 100));
    return initialHomeEmpty;
    }
    const initialHomeEmpty = await initializeDocument();
    const sidePanelLayout = await evaluate(\`(async () => {
      const store = window.openPencil.getStore();
      const stage = document.querySelector('.cheshi-stage');
      const canvas = document.querySelector('.cheshi-canvas');
      const panel = document.querySelector('.cheshi-panel-content');
      const rail = document.querySelector('.cheshi-panel-rail');
      const original = rail.querySelector('[aria-expanded="true"]');
      const design = rail.querySelector('[data-test-id="canvas-design-trigger"]');
      const layers = document.querySelector('.cheshi-docked-layers');
      const settle = () => new Promise(resolve => setTimeout(resolve, 300));
      if (original) { original.click(); await settle(); }
      const closedWidth = canvas.getBoundingClientRect().width;
      const zoom = store.state.zoom;
      design.click(); await settle();
      const filePanelContents = !rail.querySelector('[aria-label="Pages and layers"]') && !!layers.querySelector('[data-test-id="canvas-file-heading"]')
        && !!layers.querySelector('[data-test-id="pages-panel"]')
        && !!layers.querySelector('[data-test-id="layers-tree"]')
        && !layers.querySelector('[data-test-id="left-panel-assets-tab"], [data-test-id="left-panel-layers-tab"]')
        && layers.getBoundingClientRect().right <= canvas.getBoundingClientRect().left;
      const bounds = canvas.getBoundingClientRect();
      const panelBounds = panel.getBoundingClientRect();
      const toolbar = canvas.querySelector('[data-test-id="toolbar"]').getBoundingClientRect();
      const panelReservesSpace = Math.abs(closedWidth - bounds.width - panelBounds.width) < 1;
      const panelDoesNotOverlap = Math.abs(bounds.right - panelBounds.left) < 1;
      const toolbarCentered = Math.abs((toolbar.left + toolbar.right - bounds.left - bounds.right) / 2) < 1;
      const canvasResized = Math.abs(store.getViewportSize().width - bounds.width) < 1;
      store.state.showUI = false; await settle();
      const hiddenPanelReleasesSpace = Math.abs(canvas.getBoundingClientRect().width - stage.getBoundingClientRect().width) < 1;
      store.state.showUI = true; await settle();
      panel.querySelector('[data-test-id="canvas-properties-close"]').click(); await settle();
      const panelCloseRestoresCanvas = Math.abs(canvas.getBoundingClientRect().width - closedWidth) < 1 && store.state.zoom === zoom;
      const designCloseRestoresFocus = document.activeElement === design && design.getAttribute('aria-expanded') === 'false';
      if (original) { original.click(); await settle(); }
      return {filePanelContents,designCloseRestoresFocus,panelReservesSpace,panelDoesNotOverlap,toolbarCentered,canvasResized,hiddenPanelReleasesSpace,panelCloseRestoresCanvas};
    })()\`);
    const canvasBlur = await evaluate(\`(async () => {
      const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await settle();
      const source = document.querySelector('.cheshi-canvas-scene');
      const toolbar = document.querySelector('[data-test-id="toolbar"]');
      const filter = document.getElementById(source.getAttribute('data-regional-blur-source'));
      const mask = () => decodeURIComponent(filter?.querySelector('feImage')?.getAttribute('href')?.split(',').slice(1).join(',') ?? '');
      const visibleMenus = () => [...document.querySelectorAll('[role="menu"]')].filter(menu => menu.getBoundingClientRect().width > 0 && menu.dataset.state !== 'closed');
      const toolbarBlur = !!filter && filter.querySelector('feGaussianBlur')?.getAttribute('stdDeviation') === '16'
        && toolbar.dataset.regionalBlurSurface === 'true' && !source.contains(toolbar)
        && getComputedStyle(toolbar).filter === 'none' && getComputedStyle(toolbar).backdropFilter === 'none'
        && mask().includes('<path');
      const trigger = [...document.querySelectorAll('.cheshi-menu-trigger')].find(button => button.textContent.trim() === 'File');
      trigger.focus();
      trigger.dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowDown',bubbles:true}));
      await settle();
      const menu = visibleMenus()[0];
      // Reka animates menu entry. Inspect its settled surface after animationend
      // has also allowed the geometry controller to update the SVG mask.
      await Promise.allSettled((menu?.getAnimations({subtree:true}) ?? []).map(animation => animation.finished));
      await settle();
      const menuBlur = !!menu && menu.dataset.regionalBlurSurface === 'true' && !source.contains(menu)
        && getComputedStyle(menu).filter === 'none' && getComputedStyle(menu).backgroundColor === 'rgba(0, 0, 0, 0.9)'
        && (mask().match(/<path /g)?.length ?? 0) >= 2;
      const submenuTrigger = [...(menu?.querySelectorAll('[role="menuitem"]') ?? [])].find(item => item.textContent.includes('Export selection'));
      if (submenuTrigger) {
        submenuTrigger.focus();
        submenuTrigger.dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowRight',bubbles:true}));
        await settle();
        await Promise.allSettled(visibleMenus().flatMap(menu => menu.getAnimations({subtree:true}).map(animation => animation.finished)));
        await settle();
      }
      const submenuBlur = visibleMenus().length >= 2 && visibleMenus().every(menu => menu.dataset.regionalBlurSurface === 'true')
        && (mask().match(/<path /g)?.length ?? 0) >= 3;
      for (let i = 0; i < 3 && visibleMenus().length; i++) {
        document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true}));
        await settle();
      }
      const menuBlurCleaned = visibleMenus().length === 0 && (mask().match(/<path /g)?.length ?? 0) === 1;
      return {toolbarBlur,menuBlur,submenuBlur,menuBlurCleaned};
    })()\`);
    const lazyHistory = await evaluate(\`(async () => {
      const initiallyOpen = document.querySelector('.cheshi-panel-rail [aria-expanded="true"]');
      const historyDeferred = !document.querySelector('[aria-label="Canvas history panel"]')
        && !performance.getEntriesByType('resource').some(entry => /CanvasHistoryPanel-.*\\\\.js/.test(entry.name));
      const button = document.querySelector('[aria-label="Version history"]');
      button.click();
      for (let i = 0; i < 100 && !document.querySelector('[aria-label="Canvas history panel"]'); i++) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const panel = document.querySelector('[aria-label="Canvas history panel"]');
      const historyLoaded = !!panel && panel.textContent.includes('Save this canvas');
      button.click(); await new Promise(resolve => setTimeout(resolve, 50));
      button.click(); await new Promise(resolve => setTimeout(resolve, 50));
      const historyRetained = !!panel && document.querySelector('[aria-label="Canvas history panel"]') === panel;
      button.click();
      initiallyOpen?.click();
      return {historyDeferred,historyLoaded,historyRetained};
    })()\`);
    const report = await evaluate(\`(async () => {
      const s = window.openPencil.getStore();
      const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await settle();
      const canvasSurface = document.querySelector('.cheshi-canvas');
      const surfaces = new Set(document.querySelectorAll('.cheshi-menu, .cheshi-menu > div, [data-slot="tab-bar"], .cheshi-panel-rail, .cheshi-panel-content'));
      for (const canvas of canvasSurface.querySelectorAll('canvas')) {
        for (let element = canvas; element; element = element.parentElement) surfaces.add(element);
      }
      const opaqueSurfaces = [...surfaces].filter(element => getComputedStyle(element).backgroundColor !== 'rgba(0, 0, 0, 0)')
        .map(element => ({tag:element.tagName,className:element.className,color:getComputedStyle(element).backgroundColor}));
      if (opaqueSurfaces.length) throw Error('Opaque canvas surfaces: ' + JSON.stringify(opaqueSurfaces));
      const canvasGridPreserved = getComputedStyle(canvasSurface.querySelector('.cheshi-canvas-scene')).backgroundImage.includes('radial-gradient');
      const preparation = s.preparationController.begin({kind:'document-open',subject:'loading-test.fig'});
      let tabProgressPreserved = true;
      let noPreparationOverlay = true;
      let preparationBlocksInput = true;
      try {
        for (const phase of ['reading', 'decoding', 'preparing-render']) {
          preparation.update({phase});
          await settle();
          noPreparationOverlay &&= !document.querySelector('[data-test-id="canvas-loading"]');
          tabProgressPreserved &&= !!document.querySelector('[data-test-id="tabbar-tab"] [role="progressbar"][aria-label="Preparing document"]');
          preparationBlocksInput &&= document.querySelector('[data-test-id="canvas-area"]').inert;
        }
      } finally { preparation.complete(); }
      await settle();
      const preparationCleared = s.state.preparation === null
        && !document.querySelector('[data-test-id="canvas-area"]').inert
        && !document.querySelector('[data-test-id="tabbar-tab"] [role="progressbar"]');
      const firstPage = s.state.currentPageId;
      const localOnly = !document.querySelector('[data-test-id="collab-share-button"], [data-test-id="collab-avatars"]');
      const noLogo = !document.querySelector('[data-test-id="app-logo"]');
      const noHeaderToggle = !document.querySelector('[data-test-id="app-toggle-ui"]');
      const settingsOnRail = !!document.querySelector('.cheshi-panel-rail [data-test-id="app-settings-trigger"]')
        && !document.querySelector('.cheshi-menu [data-test-id="app-settings-trigger"]');
      const noDocumentNameField = !document.querySelector('[data-test-id="app-document-name"], [data-test-id="app-document-name-input"], [data-test-id="app-document-name-clear"]');
      const canvasTabIcon = !!document.querySelector('[data-test-id="tabbar-tab"] [data-test-id="canvas-tab-icon"] svg');
      const noAI = !document.querySelector('[data-test-id="properties-tab-ai"]');
      window.dispatchEvent(new KeyboardEvent('keydown',{key:'j',code:'KeyJ',metaKey:true,bubbles:true}));
      await settle();
      const noAIShortcut = document.querySelector('[data-test-id="canvas-design-content"]').style.display !== 'none';
      const preparedSettingsSidebar = document.querySelector('[data-test-id="toolbar-settings-sidebar"]');
      document.querySelector('[data-test-id="app-settings-trigger"]').click(); await settle();
      const settingsSidebar = document.querySelector('[data-test-id="toolbar-settings-sidebar"]');
      const settingsPreparedBeforeOpen = preparedSettingsSidebar === settingsSidebar;
      const settingsFocusWithoutScroll = document.activeElement === settingsSidebar.querySelector('button')
        && settingsSidebar.closest('.cheshi-panel-stage').scrollLeft === 0;
      const toolbarOnly = !!settingsSidebar.querySelector('[data-test-id="toolbar-layout"]')
        && !settingsSidebar.querySelector('[role="tab"], [data-test-id="settings-ai-panel"]');
      const settingsInline = !!settingsSidebar.closest('.cheshi-panel-content')
        && !document.querySelector('[data-test-id="app-settings-dialog"], [role="dialog"][aria-modal="true"]');
      const toolbarOrder = () => [...document.querySelectorAll('[data-test-id="toolbar-layout"] [data-entry]')].map(e => e.dataset.entry);
      const originalOrder = toolbarOrder();
      const ellipseSwitch = () => document.querySelector('[data-entry="ELLIPSE"] [role="switch"]');
      ellipseSwitch().click(); await settle();
      const toolbarHidden = ellipseSwitch().getAttribute('aria-checked') === 'false';
      document.querySelector('[data-test-id="toolbar-settings-close"]').click(); await settle();
      const panelContent = settingsSidebar.closest('.cheshi-panel-content');
      const settingsRetainedOnClose = settingsSidebar.isConnected
        && getComputedStyle(settingsSidebar.parentElement).display !== 'none'
        && panelContent.inert && panelContent.getAttribute('aria-hidden') === 'true'
        && panelContent.parentElement.dataset.open === 'false';
      document.querySelector('[data-test-id="app-settings-trigger"]').click(); await settle();
      const settingsRapidReopen = document.querySelector('[data-test-id="toolbar-settings-sidebar"]') === settingsSidebar
        && !panelContent.inert && !panelContent.hasAttribute('aria-hidden')
        && panelContent.parentElement.dataset.open === 'true';
      const toolbarPersisted = ellipseSwitch().getAttribute('aria-checked') === 'false'
        && JSON.parse(localStorage.getItem('open-pencil:preferences:v1')).toolbar.hidden.includes('ELLIPSE');
      const grip = document.querySelector('[data-entry="ELLIPSE"] [aria-keyshortcuts]');
      grip.focus(); grip.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',code:'ArrowUp',bubbles:true})); await settle();
      const toolbarReordered = toolbarOrder().indexOf('ELLIPSE') === originalOrder.indexOf('ELLIPSE') - 1;
      [...settingsSidebar.querySelectorAll('button')]
        .find(button => button.textContent.includes('Reset to default')).click(); await settle();
      const toolbarReset = JSON.stringify(toolbarOrder()) === JSON.stringify(originalOrder)
        && ellipseSwitch().getAttribute('aria-checked') === 'true';
      document.querySelector('[data-test-id="canvas-design-trigger"]').click(); await settle();
      const settingsRetainedAcrossPanels = document.querySelector('[data-test-id="toolbar-settings-sidebar"]') === settingsSidebar
        && getComputedStyle(settingsSidebar.parentElement).display === 'none';
      document.querySelector('[data-test-id="app-settings-trigger"]').click(); await settle();
      document.querySelector('[data-test-id="toolbar-settings-close"]').click(); await settle();
      window.dispatchEvent(new KeyboardEvent('keydown',{key:',',code:'Comma',metaKey:true,bubbles:true}));
      await settle();
      const settingsShortcut = document.querySelector('[data-test-id="app-settings-trigger"]').getAttribute('aria-expanded') === 'true'
        && !!document.querySelector('[data-test-id="toolbar-settings-sidebar"]');
      document.querySelector('[data-test-id="toolbar-settings-close"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
      await settle();
      const settingsEscape = panelContent.inert && panelContent.parentElement.dataset.open === 'false'
        && document.activeElement === document.querySelector('[data-test-id="app-settings-trigger"]');
      window.__testStage = 'editing';
      const a = s.createShape('RECTANGLE', 50, 80, 120, 80);
      const b = s.createShape('ELLIPSE', 200, 80, 80, 80);
      s.updateNodeWithUndo(a, {name:'Test card',opacity:.75,cornerRadius:12}, 'Style');
      s.updateNodeWithUndo(a, {x:70}, 'Move');
      s.undoAction(); const undone = s.graph.getNode(a).x;
      s.redoAction(); const redone = s.graph.getNode(a).x;
      s.select([a,b]); s.groupSelected();
      const group = [...s.state.selectedIds][0];
      const grouped = s.graph.getNode(group).type === 'GROUP' && s.graph.getNode(group).childIds.length === 2;
      s.ungroupSelected();
      s.select([a,b]); s.wrapInAutoLayout();
      const layout = [...s.state.selectedIds][0];
      const autoLayout = s.graph.getNode(layout).layoutMode !== 'NONE' && s.graph.getNode(layout).childIds.length === 2;
      s.createComponentFromSelection();
      const component = [...s.state.selectedIds][0];
      const instance = s.createInstanceFromComponent(component, 450, 80);
      const components = s.graph.getNode(component).type === 'COMPONENT' && s.graph.getNode(instance).type === 'INSTANCE';
      const text = s.createShape('TEXT', 50, 250, 300, 50);
      s.updateNodeWithUndo(text, {text:'체시 테스트 디자인',fontFamily:'Nanum Gothic',fontSize:24}, 'Text');
      s.select([text]); s.duplicateSelected();
      const duplicate = [...s.state.selectedIds][0];
      const duplicated = duplicate !== text && s.graph.getNode(duplicate).text === '체시 테스트 디자인';
      s.deleteSelected(); s.undoAction();
      const deletionUndo = !!s.graph.getNode(duplicate);
      s.updateNodeWithUndo(duplicate, {visible:false,locked:true}, 'Layer state');
      const secondPage = s.addPage('Test page 2');
      window.__testStage = 'second page';
      await s.switchPage(secondPage);
      s.createShape('FRAME', 0, 0, 320, 640);
      window.__testStage = 'first page';
      await s.switchPage(firstPage);
      s.select([component]); s.startPlay(); await settle();
      const preview = s.state.play !== null;
      s.stopPlay();
      let saved;
      const responder = event => {
        const message=event.data;
        if (message?.channel !== 'cheshi:open-pencil:v1' || message.type !== 'request') return;
        if (message.method !== 'save') return;
        window.__testStage = 'save response: ' + event.origin;
        saved = new Uint8Array(message.payload.data);
        window.postMessage({channel:message.channel,type:'response',id:message.id,payload:{path:'test.fig',revision:'test'}}, '*');
      };
      window.addEventListener('message',responder);
      let savedClean;
      window.__testStage = 'save';
      try { await s.saveFigFileToPath('test.fig'); savedClean = !s.hasUnsavedChanges(); }
      finally {window.removeEventListener('message',responder);}
      if (!saved?.length) throw Error('No document bytes reached the host save adapter');
      window.__versionRestoreBytes = saved;
      s.updateNodeWithUndo(text,{text:'Changed after save'},'Change');
      window.__testStage = 'reopen';
      await s.openFigFile(new File([saved],'test.fig'));
      await s.switchPage(firstPage);
      await settle();
      const nodes = [...s.graph.getAllNodes()];
      const propertiesButton = document.querySelector('[data-test-id="canvas-design-trigger"]');
      propertiesButton.click(); await settle();
      const designButton = document.querySelector('[data-test-id="canvas-design-trigger"]');
      const lintButton = document.querySelector('[data-test-id="canvas-lint-trigger"]');
      const propertiesEditor = document.querySelector('[data-test-id="properties-panel"]');
      const localPropertiesOnly = !!designButton && !!lintButton
        && !propertiesEditor.querySelector('[role="tablist"]');
      const noCodePanel = !document.querySelector('[data-test-id="code-panel-root"], [data-test-id="properties-tab-code"]');
      const previousTool = s.state.activeTool;
      s.state.activeTool = 'COMMENT';
      lintButton.click(); await settle();
      const lintContent = document.querySelector('[data-test-id="canvas-lint-content"]');
      const lintActive = lintButton.getAttribute('aria-expanded') === 'true'
        && lintContent.style.display !== 'none'
        && lintContent.getBoundingClientRect().height > 0
        && !!document.querySelector('[data-test-id="canvas-lint-heading"]');
      s.state.activeTool = previousTool;
      document.querySelector('[data-test-id="canvas-properties-close"]').click(); await settle();
      const lintClosed = lintButton.getAttribute('aria-expanded') === 'false' && document.activeElement === lintButton;
      lintButton.click(); await settle();
      const lintRetained = document.querySelector('[data-test-id="canvas-lint-content"]') === lintContent;
      designButton.click(); await settle();
      const designActive = designButton.getAttribute('aria-expanded') === 'true'
        && lintButton.getAttribute('aria-expanded') === 'false'
        && lintContent.style.display === 'none'
        && !!document.querySelector('[data-test-id="canvas-design-heading"]')
        && document.querySelector('[data-test-id="properties-panel"]') === propertiesEditor;
      const closeProperties = document.querySelector('[data-test-id="canvas-properties-close"]');
      closeProperties.focus();
      closeProperties.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
      await settle();
      const escapeFocus = document.activeElement === propertiesButton && propertiesButton.getAttribute('aria-expanded') === 'false';
      return {canvasGridPreserved,noPreparationOverlay,tabProgressPreserved,preparationBlocksInput,preparationCleared,
        noLogo,noHeaderToggle,settingsOnRail,noDocumentNameField,
        settingsPreparedBeforeOpen,settingsFocusWithoutScroll,settingsRetainedAcrossPanels,
        canvasTabIcon,noAI,noAIShortcut,toolbarOnly,settingsInline,settingsShortcut,settingsEscape,settingsRetainedOnClose,settingsRapidReopen,toolbarHidden,toolbarPersisted,toolbarReordered,toolbarReset,
        localOnly,localPropertiesOnly,noCodePanel,lintActive,lintClosed,lintRetained,designActive,
        undone,redone,grouped,autoLayout,components,duplicated,deletionUndo,preview,savedClean,escapeFocus,
        bytes:saved.length,pages:s.graph.getPages().length,
        korean:nodes.some(n=>n.type==='TEXT'&&n.text==='체시 테스트 디자인'),
        artworkFontPreserved:nodes.some(n=>n.type==='TEXT'&&n.text==='체시 테스트 디자인'&&n.fontSize===24),
        componentRestored:nodes.some(n=>n.type==='COMPONENT'),
        instanceRestored:nodes.some(n=>n.type==='INSTANCE'),
        layerStateRestored:nodes.some(n=>n.type==='TEXT'&&!n.visible&&n.locked),
        menus:[...document.querySelectorAll('[role="menubar"]')][0]?.textContent,
        canvases:[...document.querySelectorAll('canvas')].map(c=>({width:c.width,height:c.height,cssWidth:c.clientWidth,cssHeight:c.clientHeight})),
        panelCount:document.querySelectorAll('[data-test-id="properties-panel"]').length};
    })()\`);
    const exports = [];
    for (const format of ['png', 'svg', 'pptx']) {
      const download = new Promise((resolve, reject) => {
        const deadline = setTimeout(() => reject(Error('Export timed out: ' + format)), 10000);
        win.webContents.session.once('will-download', (_event, item) => {
          item.setSavePath(${JSON.stringify(directory)} + '/export.' + format);
          item.once('done', (_event, state) => {
            clearTimeout(deadline);
            if (state === 'completed') resolve({format,bytes:item.getTotalBytes()});
            else reject(Error('Export failed: ' + state));
          });
        });
      });
      await evaluate(\`(async()=>{const s=window.openPencil.getStore();const n=[...s.graph.getAllNodes()].find(n=>n.type==='COMPONENT');s.select([n.id]);await s.exportSelection(1,'\${format}');})()\`);
      exports.push(await download);
    }
    const versionBridge = await evaluate(\`(async () => {
      const command = window.__canvasTestCommand;
      const store = window.openPencil.getStore();
      store.setDocumentSource('test.fig', 'fig', undefined, 'test.fig');
      const beforeCount = document.querySelectorAll('[data-test-id="tabbar-tab"]').length;
      const layer = [...store.graph.getAllNodes()].find(node => node.type === 'TEXT');
      store.updateNodeWithUndo(layer.id, {text: 'Unsaved work'}, 'Edit');
      await command('renamed', {previousPath:'test.fig',path:'renamed.fig'});
      const renameKeepsDraft = window.openPencil.getStore() === store && store.hasUnsavedChanges()
        && store.getDocumentFilePath() === 'renamed.fig' && store.getSourceIdentity().path === 'renamed.fig'
        && store.graph.getNode(layer.id).text === 'Unsaved work';
      let blocked = false;
      try { await command('assert-clean'); } catch (error) { blocked = String(error).includes('Save open canvas changes'); }
      store.undoAction();
      await command('assert-clean');
      await command('reload', {path:'renamed.fig',data:window.__versionRestoreBytes});
      const restored = window.openPencil.getStore();
      const restoreReport = {renameKeepsDraft,restoreBlocksUnsaved:blocked, restoreReplacesTab:document.querySelectorAll('[data-test-id="tabbar-tab"]').length === beforeCount,
        restoreLoadsVersion:restored !== store && !restored.hasUnsavedChanges() && restored.getDocumentFilePath() === 'renamed.fig'
          && [...restored.graph.getAllNodes()].some(node => node.type === 'TEXT' && node.text === '체시 테스트 디자인')};
      const refreshLayer = [...restored.graph.getAllNodes()].find(node => node.type === 'TEXT');
      restored.updateNodeWithUndo(refreshLayer.id, {text:'Keep local draft'}, 'Draft');
      let refreshBlocksDraft = false;
      try { await command('refresh', {path:'renamed.fig',data:window.__versionRestoreBytes}); }
      catch (error) { refreshBlocksDraft = String(error).includes('Your edits have been kept'); }
      refreshBlocksDraft &&= window.openPencil.getStore() === restored
        && restored.graph.getNode(refreshLayer.id).text === 'Keep local draft' && restored.hasUnsavedChanges();
      restored.undoAction();
      // Model the saved snapshot still shown in the tab while disk has newer bytes.
      restored.updateNodeWithUndo(refreshLayer.id, {text:'Older saved snapshot'}, 'Old snapshot');
      restored.setDocumentSource('renamed.fig', 'fig', undefined, 'renamed.fig');
      await command('new');
      const otherDraft = window.openPencil.getStore();
      const draftShape = otherDraft.createShape('RECTANGLE', 10, 20, 30, 40);
      await command('open', {path:'renamed.fig',data:window.__versionRestoreBytes});
      const tabsBeforeRefresh = document.querySelectorAll('[data-test-id="tabbar-tab"]').length;
      const pageId = restored.graph.getPages()[1].id;
      await restored.switchPage(pageId);
      Object.assign(restored.state, {zoom:0.73, panX:123, panY:-87});
      let refreshFailureKeepsDocument = false;
      try { await command('refresh', {path:'renamed.fig',data:new Uint8Array([0,1,2])}); }
      catch { refreshFailureKeepsDocument = window.openPencil.getStore() === restored
        && restored.state.currentPageId === pageId
        && document.querySelectorAll('[data-test-id="tabbar-tab"]').length === tabsBeforeRefresh; }
      await command('refresh', {path:'renamed.fig',data:window.__versionRestoreBytes});
      const refreshed = window.openPencil.getStore();
      const refreshPreservesView = refreshed !== restored && refreshed.state.currentPageId === pageId
        && refreshed.state.zoom === 0.73 && refreshed.state.panX === 123 && refreshed.state.panY === -87;
      const refreshKeepsOtherDraft = otherDraft.hasUnsavedChanges() && !!otherDraft.graph.getNode(draftShape)
        && document.querySelectorAll('[data-test-id="tabbar-tab"]').length === tabsBeforeRefresh;
      const refreshLoadsFile = !refreshed.hasUnsavedChanges() && refreshed.getDocumentFilePath() === 'renamed.fig';
      await refreshed.switchPage(refreshed.graph.getPages()[0].id);
      const refreshLoadsNewContent = [...refreshed.graph.getAllNodes()].some(node => node.type === 'TEXT' && node.text === '체시 테스트 디자인')
        && ![...refreshed.graph.getAllNodes()].some(node => node.text === 'Older saved snapshot');
      otherDraft.undoAction();
      await command('new');
      let emptyBytes;
      const capture = event => {
        const message = event.data;
        if (message?.channel !== 'cheshi:open-pencil:v1' || message.type !== 'request' || message.method !== 'save') return;
        emptyBytes = new Uint8Array(message.payload.data);
        window.postMessage({channel:message.channel,type:'response',id:message.id,payload:{path:'empty.fig',revision:'empty'}}, '*');
      };
      window.addEventListener('message', capture);
      try { await window.openPencil.getStore().saveFigFileToPath('empty.fig'); }
      finally { window.removeEventListener('message', capture); }
      await command('new');
      const placeholder = window.openPencil.getStore();
      await command('open', {path:'reopened-empty.fig',data:emptyBytes});
      const reopened = window.openPencil.getStore();
      const emptyFileStaysOpen = reopened === placeholder
        && reopened.getDocumentFilePath() === 'reopened-empty.fig' && !reopened.hasUnsavedChanges()
        && reopened.graph.getPages().every(page => page.childIds.length === 0)
        && !document.querySelector('[data-test-id="home-new-document"]');
      const emptyPageId = reopened.state.currentPageId;
      await command('refresh', {path:'reopened-empty.fig',data:emptyBytes});
      const emptyRefreshed = window.openPencil.getStore();
      const refreshReplacesEmptyDocument = emptyRefreshed !== reopened && emptyRefreshed.state.currentPageId === emptyPageId;
      // New documents share initial page IDs. Add a page absent from the incoming
      // graph so this exercises removal rather than an existing-page refresh.
      const incomingPageIds = new Set(refreshed.graph.getPages().map(page => page.id));
      let removedPage = emptyRefreshed.graph.addPage('Removed page');
      while (incomingPageIds.has(removedPage.id)) removedPage = emptyRefreshed.graph.addPage('Removed page');
      await emptyRefreshed.switchPage(removedPage.id);
      emptyRefreshed.setDocumentSource('reopened-empty.fig', 'fig', undefined, 'reopened-empty.fig');
      await command('refresh', {path:'reopened-empty.fig',data:window.__versionRestoreBytes});
      const replacedPages = window.openPencil.getStore();
      const refreshHandlesRemovedPage = !replacedPages.graph.getPages().some(page => page.id === removedPage.id)
        && replacedPages.state.currentPageId === replacedPages.graph.getPages()[0].id;
      return {...restoreReport, refreshBlocksDraft, refreshFailureKeepsDocument, refreshPreservesView, refreshKeepsOtherDraft, refreshLoadsFile,
        refreshLoadsNewContent, refreshReplacesEmptyDocument, refreshHandlesRemovedPage, emptyFileStaysOpen};
    })()\`);
    // Give the home/tab scenario its own renderer and GPU contexts instead of
    // retaining the previous feature scenarios' CanvasKit views across navigation.
    win.destroy();
    win = createWindow();
    await win.loadFile(${JSON.stringify(entry)});
    await initializeDocument();
    const homeFlow = await evaluate(\`(async () => {
      const settle = () => new Promise(resolve => setTimeout(resolve, 50));
      const before = document.querySelectorAll('[data-test-id="tabbar-tab"]').length;
      const tabAddRemoved = !document.querySelector('[data-test-id="tabbar-new"]');
      const previous = window.openPencil.getStore();
      const shape = previous.createShape('RECTANGLE',10,20,30,40);
      previous.setDocumentSource('existing.fig','fig',undefined,'existing.fig');
      previous.updateNodeWithUndo(shape,{x:90},'Keep draft');
      let createdBytes;
      const respond = event => {
        const m=event.data;
        if(m?.channel!=='cheshi:open-pencil:v1'||m.type!=='request'||m.method!=='save') return;
        if(m.payload.path==='collision.fig') window.postMessage({channel:m.channel,type:'response',id:m.id,error:'File already exists.'},'*');
        else {
          createdBytes=m.payload.data;
          window.postMessage({channel:m.channel,type:'response',id:m.id,payload:{path:m.payload.path,revision:'created'}},'*');
        }
      };
      window.addEventListener('message',respond);
      let failureReported=false;
      try {
        try { await window.__canvasTestCommand('create',{path:'collision.fig'}); }
        catch(error) { failureReported=String(error).includes('File already exists'); }
        await settle();
        const failedCreatePreservesDraft=failureReported && window.openPencil.getStore()===previous
          && previous.graph.getNode(shape).x===90 && previous.hasUnsavedChanges()
          && document.querySelectorAll('[data-test-id="tabbar-tab"]').length===before;
        await window.__canvasTestCommand('create',{path:'created.fig'}); await settle();
        const created=window.openPencil.getStore();
        const createSavesNewFile=created!==previous && created.getDocumentFilePath()==='created.fig'
          && !created.hasUnsavedChanges() && createdBytes?.length>100
          && previous.graph.getNode(shape).x===90 && previous.hasUnsavedChanges();
        window.__createChecks={failedCreatePreservesDraft,createSavesNewFile};
      } finally { window.removeEventListener('message',respond); }
      previous.undoAction();
      const beforeNew=document.querySelectorAll('[data-test-id="tabbar-tab"]').length;
      await window.__canvasTestCommand('new');
      await settle();
      const newTabCreatesCanvas = document.querySelectorAll('[data-test-id="tabbar-tab"]').length === beforeNew + 1
        && window.__testHostState?.hasDocument === true && !!document.querySelector('[data-test-id="properties-panel"]');
      for (let i = 0; i < 20; i++) {
        const close = document.querySelector('[data-test-id="tabbar-close"][data-active]');
        if (!close) break;
        if (window.openPencil.getStore().hasUnsavedChanges()) throw Error('Unexpected unsaved test document');
        close.click(); await settle();
      }
      const lastCloseShowsEmpty = window.__testHostState?.hasDocument === false
        && !document.querySelector('[data-test-id="tabbar-tab"], [data-test-id="home-new-document"], [data-test-id="properties-panel"]');
      let emptySaveBlocked = false;
      try { await window.__canvasTestCommand('save'); } catch (error) { emptySaveBlocked = String(error).includes('Select or create'); }
      await window.__canvasTestCommand('new'); await settle();
      const newFromEmptyReusesTab = document.querySelectorAll('[data-test-id="tabbar-tab"]').length === 1
        && window.__testHostState?.hasDocument === true;
      let closedContextsReleased = true;
      for (let cycle = 0; cycle < 12; cycle++) {
        const contexts = [...document.querySelectorAll('.cheshi-canvas-scene canvas')]
          .map(canvas => canvas.getContext('webgl2') ?? canvas.getContext('webgl')).filter(Boolean);
        if (!contexts.length) throw Error('Missing WebGL context before closing the test canvas');
        document.querySelector('[data-test-id="tabbar-close"][data-active]').click();
        await settle();
        closedContextsReleased &&= contexts.every(context => context.isContextLost());
        await window.__canvasTestCommand('new'); await settle();
      }
      return {...window.__createChecks,tabAddRemoved,newTabCreatesCanvas,lastCloseShowsEmpty,emptySaveBlocked,newFromEmptyReusesTab,closedContextsReleased};
    })()\`);
    await new Promise(resolve=>setTimeout(resolve,300));
    console.log('ORIGINAL_CANVAS_RESULT '+JSON.stringify({...report,...sidePanelLayout,...canvasBlur,...lazyHistory,...versionBridge,...homeFlow,initialHomeEmpty,exports,errors,external}));
    win.destroy(); clearTimeout(timeout); app.exit(0);
  } catch (error) { console.error(error,errors); win.destroy(); clearTimeout(timeout); app.exit(1); }
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
    const line = result.output.split('\n').find(value => value.startsWith('ORIGINAL_CANVAS_RESULT '));
    assert.ok(line, result.output);
    const report = JSON.parse(line.slice('ORIGINAL_CANVAS_RESULT '.length));
    assert.deepEqual(report.errors, [], JSON.stringify(report));
    assert.deepEqual(report.external, [], JSON.stringify(report));
    assert.equal(report.undone, 50); assert.equal(report.redone, 70);
    for (const key of ['canvasGridPreserved', 'noPreparationOverlay', 'tabProgressPreserved', 'preparationBlocksInput', 'preparationCleared',
      'historyDeferred', 'historyLoaded', 'historyRetained',
      'toolbarBlur', 'menuBlur', 'submenuBlur', 'menuBlurCleaned',
      'filePanelContents', 'designCloseRestoresFocus',
      'panelReservesSpace', 'panelDoesNotOverlap', 'toolbarCentered', 'canvasResized', 'hiddenPanelReleasesSpace', 'panelCloseRestoresCanvas',
      'noLogo', 'noHeaderToggle', 'settingsOnRail', 'artworkFontPreserved', 'noDocumentNameField',
      'settingsPreparedBeforeOpen', 'settingsFocusWithoutScroll', 'settingsRetainedAcrossPanels',
      'canvasTabIcon', 'noAI', 'noAIShortcut', 'toolbarOnly', 'settingsInline', 'settingsShortcut', 'settingsEscape', 'settingsRetainedOnClose', 'settingsRapidReopen', 'toolbarHidden', 'toolbarPersisted', 'toolbarReordered', 'toolbarReset',
      'localOnly', 'localPropertiesOnly', 'noCodePanel', 'lintActive', 'lintClosed', 'lintRetained', 'designActive', 'renameKeepsDraft', 'emptyFileStaysOpen', 'restoreBlocksUnsaved', 'restoreReplacesTab', 'restoreLoadsVersion',
      'refreshBlocksDraft', 'refreshFailureKeepsDocument', 'refreshPreservesView', 'refreshKeepsOtherDraft', 'refreshLoadsFile',
      'refreshLoadsNewContent', 'refreshReplacesEmptyDocument', 'refreshHandlesRemovedPage',
      'initialHomeEmpty', 'tabAddRemoved', 'failedCreatePreservesDraft', 'createSavesNewFile', 'newTabCreatesCanvas', 'lastCloseShowsEmpty', 'emptySaveBlocked', 'newFromEmptyReusesTab', 'closedContextsReleased',
      'grouped', 'autoLayout', 'components', 'duplicated', 'deletionUndo', 'preview', 'savedClean', 'escapeFocus', 'korean', 'componentRestored', 'instanceRestored', 'layerStateRestored']) {
      assert.equal(report[key], true, `${key}: ${JSON.stringify(report)}`);
    }
    assert.ok(report.bytes > 100); assert.equal(report.pages, 2);
    assert.deepEqual(report.exports.map((entry: { format: string }) => entry.format), ['png', 'svg', 'pptx']);
    assert.equal((await readFile(path.join(directory, 'export.png'))).subarray(1, 4).toString(), 'PNG');
    assert.match(await readFile(path.join(directory, 'export.svg'), 'utf8'), /<svg\b/);
    assert.equal((await readFile(path.join(directory, 'export.pptx'))).subarray(0, 2).toString(), 'PK');
    assert.equal(report.panelCount, 1);
    for (const menu of ['File', 'Edit', 'View', 'Object', 'Text', 'Arrange']) assert.ok(report.menus.includes(menu));
    assert.equal(report.canvases.length, 2);
    for (const canvas of report.canvases) {
      assert.ok(canvas.cssWidth > 500 && canvas.cssWidth < 1200, JSON.stringify(canvas));
      assert.ok(canvas.width <= canvas.cssWidth * 3, JSON.stringify(canvas));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
