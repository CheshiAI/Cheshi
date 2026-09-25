import { type Extension } from '@codemirror/state';
import { tooltips, ViewPlugin } from '@codemirror/view';
import panelStyles from '../../shared/ui/LiquidGlassPanel.module.css';
import { beginSplitPreview } from '../../shared/ui/splitPreviewState';

/** Keep CodeMirror's tooltip DOM and positioning, but render above the editor's clipping layers. */
export function workspaceEditorTooltips(document: Document): Extension {
  const portal = document.createElement('div');
  portal.className = 'workspace-editor-tooltip-portal';
  Object.assign(portal.style, { position: 'fixed', inset: '0', zIndex: '120', pointerEvents: 'none' });

  const surfaces = ViewPlugin.fromClass(class {
    private readonly observer: MutationObserver;
    private restoreNativeSurfaces: (() => void) | undefined;

    constructor() {
      document.body.append(portal);
      this.observer = new document.defaultView!.MutationObserver(() => this.sync());
      this.observer.observe(portal, { childList: true, subtree: true });
      this.sync();
    }

    private sync(): void {
      const tooltips = portal.querySelectorAll<HTMLElement>('.cm-tooltip');
      for (const tooltip of tooltips) {
        if (tooltip.querySelector(':scope > .workspace-editor-tooltip-surface')) continue;
        // A separate foreground panel leaves the outer tooltip free of backdrop filters.
        // Its ::before and this panel can then sample the page as independent layers.
        const panel = document.createElement('div');
        panel.className = `${panelStyles.panel} workspace-editor-tooltip-surface`;
        panel.dataset.liquidGlassBackdrop = 'true';
        panel.setAttribute('aria-hidden', 'true');
        tooltip.append(panel);
      }
      if (tooltips.length && !this.restoreNativeSurfaces) this.restoreNativeSurfaces = beginSplitPreview();
      if (!tooltips.length) {
        this.restoreNativeSurfaces?.();
        this.restoreNativeSurfaces = undefined;
      }
    }

    destroy(): void {
      this.observer.disconnect();
      this.restoreNativeSurfaces?.();
      portal.remove();
    }
  });

  return [surfaces, tooltips({ parent: portal })];
}
