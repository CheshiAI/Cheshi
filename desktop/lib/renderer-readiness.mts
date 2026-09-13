/** Wait for committed workspace content, then give Chromium two paint opportunities. */
export function installRendererReadiness(
  view: Pick<Window, 'addEventListener' | 'requestAnimationFrame' | 'setTimeout'>,
  document: Pick<Document, 'readyState' | 'documentElement'>,
  notify: (theme: 'dark' | 'light') => void,
): void {
  let domReady = document.readyState !== 'loading';
  let contentReady = false;
  let scheduled = false;
  const schedule = () => {
    if (!domReady || !contentReady || scheduled) return;
    scheduled = true;
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
