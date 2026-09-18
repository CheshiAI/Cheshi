import { writeSync } from 'node:fs';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, Session, WebContentsView, WebContentsViewConstructorOptions } from 'electron';
import { AUTOPILOT_CHANNELS, parseAutopilotView, safeAutopilotUrl, parseAutopilotReportFormat } from '../shared/autopilot.ts';
import type { AutopilotViewRequest } from '../shared/autopilot.ts';
import { createAutopilotModel } from './autopilot-model.mts';
import type { AutopilotFetch } from './autopilot-model.mts';
import { AUTOPILOT_PAGE_SCRIPT, autopilotSectionScript, autopilotOperation, parseAutopilotPage } from './autopilot-page.mts';
import type { AutopilotPage } from './autopilot-model.mts';
import type { AutopilotSection } from './autopilot-document.mts';
import { AutopilotPageChangedError, createAutopilotRunner } from './autopilot-runner.mts';
import { performAutopilotInteraction } from './autopilot-interaction.mts';
import { executeAutopilotInput } from './autopilot-input.mts';
import { autopilotReport, saveAutopilotReportAutomatically } from './autopilot-report.mts';
import type { ResearchCoordinator } from './autopilot-codex.mts';

interface Options {
  window: BrowserWindow;
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>;
  session: Session;
  createView(options: WebContentsViewConstructorOptions): WebContentsView;
  getKey(): string | null;
  request?: AutopilotFetch;
  navigationTimeoutMs?: number;
  reportDirectory?: string;
  research?: ResearchCoordinator;
}

export function createAutopilotBrowser(options: Options) {
  const diagnosticEnabled = !!process.env.CHESHI_DEV_STARTED_AT && process.env.CHESHI_AUTOPILOT_DEBUG === '1';
  const diagnostic = (stage: string, details: Record<string, string | number | boolean> = {}) => {
    if (!diagnosticEnabled) return;
    // Synchronous output preserves the last boundary before a native process crash.
    // Callers supply only stage names and counts, never page content or credentials.
    try { writeSync(2, `[cheshi] Autopilot ${JSON.stringify({ time: Date.now(), stage, ...details })}\n`); }
    catch { /* A closed diagnostic stream must not change browser behavior. */ }
  };
  const owner = options.window.webContents;
  let view: WebContentsView | undefined;
  let viewport: AutopilotViewRequest | null = null;
  let disposed = false;
  const channels: string[] = [];
  let exporting = false;
  let interactionSignal: AbortSignal | null = null;
  let activeLoad: { signal: AbortSignal; fail(error: Error): void } | null = null;
  const cancelLoad = () => { if (view && !view.webContents.isDestroyed()) view.webContents.stop(); };
  const runner = createAutopilotRunner({
    research: options.research,
    configured: () => !!options.getKey(), cancelLoad,
    decide: async input => {
      const key = options.getKey();
      if (!key) throw new Error('The TypeSafe API key is unavailable.');
      diagnostic('model:start');
      const result = await createAutopilotModel(key, options.request)(input);
      diagnostic('model:done', { completed: result.completed, interaction: result.interaction?.kind ?? 'none' });
      return result;
    },
    load, readSection,
    read: (signal, page) => page?.section ? readSection(page, page.section, signal) : readPage(signal),
    async interact(page, action, signal, onDispatched) {
      diagnostic('interaction:start', { kind: action.kind });
      interactionSignal = signal;
      try {
        const evaluate = async (code: string, signal: AbortSignal) => {
          diagnostic('interaction:evaluate:start');
          const result = await autopilotOperation(ensureView().webContents.executeJavaScriptInIsolatedWorld(1002,
            [{ code }], true), signal);
          diagnostic('interaction:evaluate:done');
          return result;
        };
        const result = await performAutopilotInteraction({ read: readPage, evaluate,
          execute: (page, action, signal, dispatched) => executeAutopilotInput({
            debugger: ensureView().webContents.debugger, evaluate,
          }, page, action, signal, dispatched),
          loading: () => ensureView().webContents.isLoadingMainFrame(),
        }, page, action, signal, onDispatched);
        diagnostic('interaction:done');
        return result;
      } finally { if (interactionSignal === signal) interactionSignal = null; }
    },
    async follow(page, link, signal) {
      const current = await readPage(signal);
      assertCurrentLink(current, page.url, link.url);
      signal.throwIfAborted();
      return load(link.url, signal);
    },
    onState(state) {
      diagnostic('state', { phase: state.phase, steps: state.steps.length });
      if (!disposed && !owner.isDestroyed()) owner.send(AUTOPILOT_CHANNELS.state, state);
    },
  });

  const denyDownload = (event: Electron.Event) => event.preventDefault();
  options.session.setPermissionCheckHandler(() => { diagnostic('permission:check'); return false; });
  options.session.setPermissionRequestHandler((_contents, _permission, callback) => {
    diagnostic('permission:request');
    callback(false);
    diagnostic('permission:response');
  });
  options.session.on('will-download', denyDownload);

  function ensureView() {
    if (view) return view;
    diagnostic('view:create:start');
    view = options.createView({ webPreferences: { session: options.session, sandbox: true,
      contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webviewTag: false } });
    view.setVisible(false);
    options.window.contentView.addChildView(view);
    diagnostic('view:create:done');
    if (diagnosticEnabled) {
      view.webContents.on('did-start-loading', () => diagnostic('webcontents:did-start-loading'));
      view.webContents.on('dom-ready', () => diagnostic('webcontents:dom-ready'));
      view.webContents.on('did-finish-load', () => diagnostic('webcontents:did-finish-load'));
      view.webContents.on('did-stop-loading', () => diagnostic('webcontents:did-stop-loading'));
      view.webContents.on('did-fail-load', () => diagnostic('webcontents:did-fail-load'));
      view.webContents.on('render-process-gone', () => diagnostic('webcontents:render-process-gone'));
      view.webContents.on('unresponsive', () => diagnostic('webcontents:unresponsive'));
      view.webContents.on('destroyed', () => diagnostic('webcontents:destroyed'));
    }
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    // A loading page may replace its initial navigation (for example YouTube's first visit).
    // Keep that transition inside the same bounded, runner-owned operation.
    view.webContents.on('will-navigate', event => {
      const running = (interactionSignal && !interactionSignal.aborted) || (activeLoad && !activeLoad.signal.aborted);
      const safe = !!safeAutopilotUrl(event.url);
      diagnostic('navigation:requested', { running: !!running, safe });
      if (!running || !safe) {
        event.preventDefault();
        activeLoad?.fail(new Error('The page requested a blocked navigation.'));
      }
    });
    view.webContents.on('will-redirect', event => {
      diagnostic('navigation:redirect', { safe: !!safeAutopilotUrl(event.url) });
      if (!safeAutopilotUrl(event.url)) {
        event.preventDefault();
        activeLoad?.fail(new Error('The page requested a blocked redirect.'));
      }
    });
    view.webContents.on('will-attach-webview', event => event.preventDefault());
    layout();
    return view;
  }

  async function readPage(signal: AbortSignal, code = AUTOPILOT_PAGE_SCRIPT) {
    signal.throwIfAborted();
    const contents = ensureView().webContents;
    diagnostic('read:evaluate:start');
    const result: unknown = await autopilotOperation(contents.executeJavaScriptInIsolatedWorld(1002,
      [{ code }]), signal);
    diagnostic('read:evaluate:done');
    signal.throwIfAborted();
    const page = parseAutopilotPage(result);
    diagnostic('read:parsed', { links: page.links.length, controls: page.controls?.length ?? 0 });
    return page;
  }

  async function readSection(page: AutopilotPage, section: AutopilotSection, signal: AbortSignal) {
    const current = await readPage(signal, autopilotSectionScript(page, section));
    if (current.url !== page.url || current.documentVersion !== page.documentVersion || current.section?.id !== section.id) {
      throw new AutopilotPageChangedError(current);
    }
    return current;
  }

  async function load(url: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const contents = ensureView().webContents;
    const abort = () => { if (!contents.isDestroyed()) contents.stop(); };
    let complete: () => void = () => {};
    let fail: (error: Error) => void = () => {};
    const loaded = new Promise<void>((resolve, reject) => { complete = resolve; fail = reject; });
    const currentLoad = { signal, fail };
    activeLoad = currentLoad;
    let documentFinished = false;
    const finished = () => {
      documentFinished = true;
      if (!contents.isLoadingMainFrame()) complete();
    };
    // Electron may still report loading inside did-finish-load and clear it just
    // before did-stop-loading. A stopped load alone is not evidence of success.
    const stopped = () => { if (documentFinished) finished(); };
    const failed = (_event: Electron.Event, code: number, _description: string, _url: string, mainFrame: boolean) => {
      // Subframe failures and a superseded navigation do not fail the current main document.
      if (mainFrame && code !== -3) fail(new Error('The main page failed to load.'));
    };
    const destroyed = () => fail(new Error('The browser was closed while loading.'));
    const crashed = () => fail(new Error('The browser process exited while loading.'));
    contents.on('did-finish-load', finished);
    contents.on('did-stop-loading', stopped);
    contents.on('did-fail-load', failed);
    contents.on('did-fail-provisional-load', failed);
    contents.on('destroyed', destroyed);
    contents.on('render-process-gone', crashed);
    signal.addEventListener('abort', abort, { once: true });
    // Attach rejection handling before loadURL: navigation events can fire synchronously.
    const pending = autopilotOperation(loaded, signal, options.navigationTimeoutMs);
    try {
      diagnostic('load:start');
      void Promise.resolve().then(() => {
        signal.throwIfAborted();
        return contents.loadURL(url);
      }).then(finished, (error: unknown) => {
        if (activeLoad !== currentLoad || signal.aborted) return;
        if (isAbortedNavigation(error)) {
          diagnostic('load:awaiting-replacement');
          return;
        }
        fail(new Error('The main page failed to load.'));
      });
      await pending;
      diagnostic('load:done');
      return await readPage(signal);
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      diagnostic('load:failed', { aborted: signal.aborted,
        code: typeof code === 'string' && /^ERR_[A-Z_]+$/.test(code) ? code : 'unknown' });
      signal.throwIfAborted();
      // Only clean up a still-pending load after a real failure or timeout. Never stop
      // synchronously in response to ERR_ABORTED while Chromium replaces a navigation.
      if (!contents.isDestroyed() && contents.isLoadingMainFrame()) contents.stop();
      throw new Error('Could not load or read this page. Check the start URL and try again.');
    } finally {
      if (activeLoad === currentLoad) activeLoad = null;
      complete();
      signal.removeEventListener('abort', abort);
      contents.off('did-finish-load', finished);
      contents.off('did-stop-loading', stopped);
      contents.off('did-fail-load', failed);
      contents.off('did-fail-provisional-load', failed);
      contents.off('destroyed', destroyed);
      contents.off('render-process-gone', crashed);
    }
  }

  function layout() {
    if (!view || disposed || options.window.isDestroyed()) return;
    if (!viewport?.visible) { view.setVisible(false); return; }
    const [width = 0, height = 0] = options.window.getContentSize();
    const zoom = owner.getZoomFactor();
    const bounds = viewport.bounds;
    const x = Math.max(0, Math.min(width, Math.round(bounds.x * zoom)));
    const y = Math.max(0, Math.min(height, Math.round(bounds.y * zoom)));
    const right = Math.max(x, Math.min(width, Math.round((bounds.x + bounds.width) * zoom)));
    const bottom = Math.max(y, Math.min(height, Math.round((bounds.y + bounds.height) * zoom)));
    view.setBounds({ x, y, width: right - x, height: bottom - y });
    view.setVisible(right > x && bottom > y);
  }

  function assertOwner(event: IpcMainInvokeEvent) {
    if (disposed || event.sender !== owner || event.senderFrame !== owner.mainFrame) {
      throw new Error('Autopilot is only available to its workspace window.');
    }
  }
  const hide = () => { viewport = null; runner.stop(); layout(); };
  owner.on('did-start-loading', hide);
  options.window.on('resize', layout);
  options.window.on('closed', dispose);
  const handle = (channel: string, listener: Parameters<IpcMain['handle']>[1]) => {
    try { options.ipc.handle(channel, listener); channels.push(channel); }
    catch (error) { dispose(); throw error; }
  };
  handle(AUTOPILOT_CHANNELS.get, event => { assertOwner(event); return runner.snapshot(); });
  handle(AUTOPILOT_CHANNELS.start, (event, value: unknown) => { assertOwner(event); return runner.start(value); });
  handle(AUTOPILOT_CHANNELS.stop, event => { assertOwner(event); return runner.stop(); });
  handle(AUTOPILOT_CHANNELS.export, async (event, value: unknown) => {
    assertOwner(event);
    if (exporting) throw new Error('A report save is already in progress.');
    const format = parseAutopilotReportFormat(value);
    if (!options.reportDirectory) throw new Error('Automatic report saving is unavailable.');
    const content = autopilotReport(runner.snapshot(), format);
    exporting = true;
    try {
      await saveAutopilotReportAutomatically(content, format, options.reportDirectory);
      return true;
    } finally { exporting = false; }
  });
  handle(AUTOPILOT_CHANNELS.view, (event, value: unknown) => {
    assertOwner(event);
    viewport = parseAutopilotView(value);
    layout();
  });

  function dispose() {
    if (disposed) return;
    diagnostic('dispose');
    disposed = true;
    runner.dispose();
    owner.off('did-start-loading', hide);
    options.window.off('resize', layout);
    options.window.off('closed', dispose);
    for (const channel of channels) options.ipc.removeHandler(channel);
    options.session.off('will-download', denyDownload);
    if (view) {
      if (!options.window.isDestroyed()) options.window.contentView.removeChildView(view);
      if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
    }
  }
  return { dispose };
}

function isAbortedNavigation(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'ERR_ABORTED';
}

function assertCurrentLink(page: ReturnType<typeof parseAutopilotPage>, expectedUrl: string, link: string): void {
  if (page.url !== expectedUrl || !page.links.some(candidate => candidate.url === link)) {
    throw new AutopilotPageChangedError(page);
  }
}
