/** Wait for committed workspace content, then give Chromium two paint opportunities. */
export function installRendererReadiness(
  view: Pick<Window, 'addEventListener' | 'requestAnimationFrame' | 'setTimeout'>,
  document: Pick<Document, 'readyState' | 'documentElement'>,
  notify: (theme: 'dark' | 'light') => void,
  retainedSurface = false,
): void {
  let domReady = document.readyState !== 'loading';
  let contentReady = false;
  let scheduled = false;
  const schedule = () => {
    if (!domReady || !contentReady || scheduled) return;
    scheduled = true;
    // A retained view is deliberately not drawn until activation. Waiting for a
    // paint here would deadlock its first activation; committed content suffices.
    if (retainedSurface) {
      view.setTimeout(() => notify(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'), 0);
      return;
    }
    view.requestAnimationFrame(() => {
      view.requestAnimationFrame(() => {
        view.setTimeout(() => {
          notify(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
        }, 0);
      });
    });
  };
  view.addEventListener('DOMContentLoaded', () => { domReady = true; schedule(); }, { once: true });
  view.addEventListener('cheshi:workspace-content-ready', () => { contentReady = true; schedule(); }, { once: true });
}
