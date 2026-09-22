import type { WindowAppearanceApi, WindowAppearanceState } from '../../../../shared/window-appearance';

export function applyWindowAppearance(state: WindowAppearanceState, root = document.documentElement) {
  root.toggleAttribute('data-window-glass', state.active);
  root.toggleAttribute('data-main-pane-glass', state.active && state.preferences.mainPaneGlass);
  root.style.setProperty('--window-glass-opacity', String(state.preferences.opacity));
}

export function installWindowAppearance(api: WindowAppearanceApi | undefined) {
  if (!api) return () => {};
  let disposed = false, revision = 0;
  const unsubscribe = api.onChanged(state => {
    revision++;
    if (!disposed) applyWindowAppearance(state);
  });
  const initialRevision = revision;
  void api.get().then(state => {
    if (!disposed && revision === initialRevision) applyWindowAppearance(state);
  }).catch(() => { /* Standalone viewers and secondary windows retain their opaque background. */ });
  return () => { disposed = true; unsubscribe(); };
}
