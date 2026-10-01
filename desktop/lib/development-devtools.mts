import type { App, WebContents } from 'electron';

// Electron 41's DevTools inject live metrics into every frame, including frames
// that deliberately forbid scripts. Run inside DevTools before its models start.
// Keep this internal API adapter isolated and covered by an actual Electron test.
export const DISABLE_DEVTOOLS_LIVE_METRICS = `
(async () => {
  if (!location.href.startsWith('devtools://devtools/bundled/')) return;
  const { LiveMetrics } = await import('./models/live-metrics/live-metrics.js');
  if (typeof LiveMetrics?.prototype?.enable !== 'function'
      || typeof LiveMetrics.prototype.disable !== 'function') {
    throw new Error('Unsupported DevTools live metrics API');
  }
  LiveMetrics.prototype.enable = async function () {};
  await LiveMetrics.instance().disable();
})()
`;

/** Only development DevTools documents are changed; inspected pages keep their sandbox/CSP. */
export function installDevelopmentDevTools(
  app: Pick<App, 'isPackaged' | 'on' | 'off'>,
  onError: (error: unknown) => void = error => {
    process.stderr.write(`[cheshi] Could not disable DevTools live metrics: ${String(error)}\n`);
  },
) {
  if (app.isPackaged) return () => {};
  const active = new Map<WebContents, () => void>();
  const created = (_event: unknown, contents: WebContents) => {
    const ready = () => {
      if (contents.isDestroyed() || !contents.getURL().startsWith('devtools://devtools/bundled/')) return;
      void contents.executeJavaScript(DISABLE_DEVTOOLS_LIVE_METRICS).catch(error => {
        if (active.has(contents) && !contents.isDestroyed()) onError(error);
      });
    };
    const detach = () => {
      contents.off('dom-ready', ready);
      contents.off('destroyed', detach);
      active.delete(contents);
    };
    active.set(contents, detach);
    contents.on('dom-ready', ready);
    contents.once('destroyed', detach);
  };
  const dispose = () => {
    app.off('web-contents-created', created);
    app.off('will-quit', dispose);
    for (const detach of active.values()) detach();
  };
  app.on('web-contents-created', created);
  app.on('will-quit', dispose);
  return dispose;
}
