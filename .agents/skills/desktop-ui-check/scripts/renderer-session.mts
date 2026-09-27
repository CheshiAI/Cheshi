import type { WebContents } from 'electron';

export interface DesktopUI {
  key: string;
  evaluate<T = unknown>(expression: string): Promise<T>;
  click(selector: string): Promise<void>;
  cdp(method: string, params?: Record<string, unknown>): Promise<unknown>;
  waitFor(expression: string): Promise<void>;
  cleanup(expression: string): void;
}

export interface SessionOptions { key: string; timeoutMs: number }
export interface SessionResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  runtimeExceptions: number;
  cleanupErrors: string[];
}

/** Serialized into Electron. Keep runtime dependencies inside this function. */
export async function runRendererSession(options: SessionOptions, scenarioSource: string): Promise<SessionResult> {
  const requireMain = (process as unknown as { mainModule: { require: NodeRequire } }).mainModule.require.bind(
    (process as unknown as { mainModule: { require: NodeRequire } }).mainModule);
  const electron = requireMain('electron') as typeof import('electron');
  const candidates = electron.BrowserWindow.getAllWindows().filter(window => {
    const url = window.webContents.getURL();
    return /^http:\/\/127\.0\.0\.1:\d+\/(?:\?.*)?$/.test(url) && !window.isDestroyed();
  });
  if (candidates.length !== 1) throw new Error(`Expected one workspace development window; found ${candidates.length}`);
  const contents: WebContents = candidates[0]!.webContents;
  if (contents.isDevToolsOpened() || contents.debugger.isAttached()) throw new Error('Renderer debugger is already in use; leave it untouched');
  const globals = globalThis as unknown as Record<string, unknown>;
  const abort = new AbortController();
  globals[options.key] = abort;
  const cleanup: string[] = [];
  let finished = false;
  let attached = false;
  let runtimeExceptions = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const check = () => {
    if (finished || abort.signal.aborted) throw new Error('UI check cancelled or timed out');
    if (contents.isDestroyed()) throw new Error('Workspace renderer closed');
  };
  const limited = async <T,>(operation: Promise<T>, milliseconds: number): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([operation, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Renderer operation timed out')), milliseconds);
      })]);
    } finally { clearTimeout(timer); }
  };
  const onMessage = (_event: unknown, method: string) => { if (method === 'Runtime.exceptionThrown') runtimeExceptions++; };
  const attach = async () => {
    check();
    if (attached) return;
    if (contents.debugger.isAttached()) throw new Error('Renderer debugger was attached by another client');
    contents.debugger.attach('1.3');
    attached = true;
    await limited(contents.debugger.sendCommand('Runtime.enable'), 3000);
    contents.debugger.on('message', onMessage);
  };
  const execute = async <T,>(expression: string): Promise<T> => {
    const outcome = await limited(contents.executeJavaScript(`(async () => {
      try { return {ok:true, value:await (\n${expression}\n)}; }
      catch(error) { return {ok:false, error:error instanceof Error ? error.message : String(error)}; }
    })()`), 5000) as { ok: boolean; value: T; error?: string };
    if (!outcome.ok) throw new Error(outcome.error ?? 'Renderer expression failed');
    return outcome.value;
  };
  const evaluate = async <T,>(expression: string): Promise<T> => {
    check();
    const result = await execute<T>(expression);
    check();
    return result;
  };
  const ui: DesktopUI = {
    key: options.key,
    evaluate,
    cleanup(expression) { check(); cleanup.push(expression); },
    async cdp(method, params = {}) {
      await attach();
      check();
      return await limited(contents.debugger.sendCommand(method, params), 5000);
    },
    async click(selector) {
      const position = await evaluate<{ x: number; y: number }>(`(() => {
        const matches = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(el =>
          !el.closest('[hidden], [inert]') && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
        if (matches.length !== 1) throw Error('Expected exactly one visible click target');
        const el = matches[0];
        if (el.matches(':disabled, [aria-disabled="true"]')) throw Error('Click target disabled');
        const r = el.getBoundingClientRect(); const x = r.x + r.width / 2, y = r.y + r.height / 2;
        const hit = document.elementFromPoint(x, y);
        if (!hit || !el.contains(hit)) throw Error('Click target obscured');
        return {x, y};
      })()`);
      await ui.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', ...position });
      await ui.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...position });
      // Release even if cancellation arrives between press and release.
      await limited(contents.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseReleased', button: 'left', clickCount: 1, ...position,
      }), 3000);
    },
    async waitFor(expression) {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (await evaluate(expression) === true) return;
        await new Promise(resolve => setTimeout(resolve, 40));
      }
      throw new Error('UI condition did not become true within 5 seconds');
    },
  };
  const report: SessionResult = { ok: false, runtimeExceptions: 0, cleanupErrors: [] };
  try {
    await attach();
    const cancelled = new Promise<never>((_, reject) => {
      abort.signal.addEventListener('abort', () => reject(new Error('UI check cancelled or timed out')), { once: true });
      timeout = setTimeout(() => abort.abort(), options.timeoutMs);
    });
    const scenario = (0, eval)(`(${scenarioSource})`) as (ui: DesktopUI) => Promise<unknown>;
    report.result = await Promise.race([scenario(ui), cancelled]);
    report.ok = true;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  } finally {
    finished = true;
    clearTimeout(timeout);
    for (const expression of cleanup.reverse()) {
      try { await execute(expression); }
      catch (error) { report.cleanupErrors.push(error instanceof Error ? error.message : String(error)); }
    }
    if (attached && !contents.isDestroyed()) {
      contents.debugger.removeListener('message', onMessage);
      if (contents.debugger.isAttached()) contents.debugger.detach();
    }
    delete globals[options.key];
  }
  report.runtimeExceptions = runtimeExceptions;
  report.ok &&= runtimeExceptions === 0 && report.cleanupErrors.length === 0;
  return report;
}

export async function inspectPanes(ui: DesktopUI) {
  return await ui.evaluate(`(() => {
    const panes = selector => [...document.querySelectorAll(selector)].map(el => {
      const r = el.getBoundingClientRect();
      return {id: el.dataset.workspacePane ?? el.dataset.editorPane,
        visible: !el.closest('[hidden]') && r.width > 0 && r.height > 0,
        x:r.x, y:r.y, width:r.width, height:r.height};
    });
    return {workspace:panes('[data-workspace-pane]'), editor:panes('[data-editor-pane]')};
  })()`);
}
