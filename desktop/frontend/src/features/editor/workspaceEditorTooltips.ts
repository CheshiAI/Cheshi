import { type Extension } from '@codemirror/state';
import { tooltips, ViewPlugin } from '@codemirror/view';
import { registerTooltipBlur } from '../../shared/ui/tooltipBlur';
import panelStyles from '../../shared/ui/LiquidGlassPanel.module.css';
import { installAutoHideScrollbars } from '../../shared/useAutoHideScrollbars';

/** Keep CodeMirror's tooltip DOM and positioning, but render above the editor's clipping layers. */
export function workspaceEditorTooltips(document: Document): Extension {
  const portal = document.createElement('div');
  portal.className = 'workspace-editor-tooltip-portal';
  portal.dataset.tooltipBlurPortal = 'true';
  Object.assign(portal.style, { position: 'fixed', inset: '0', zIndex: '120', pointerEvents: 'none' });

  const surfaces = ViewPlugin.fromClass(class {
    private readonly blurSurfaces = new Map<HTMLElement, () => void>();
    private readonly observer: MutationObserver;
    private readonly cleanupScrollbars: () => void;

    constructor() {
      document.body.append(portal);
      this.cleanupScrollbars = installAutoHideScrollbars(portal);
      this.observer = new document.defaultView!.MutationObserver(() => this.sync());
      this.observer.observe(portal, { childList: true, subtree: true });
      this.sync();
    }

    private sync(): void {
      const tooltips = portal.querySelectorAll<HTMLElement>('.cm-tooltip');
      for (const [panel, release] of this.blurSurfaces) {
        if (!portal.contains(panel)) { release(); this.blurSurfaces.delete(panel); }
      }
      for (const tooltip of tooltips) {
        if (tooltip.querySelector(':scope > .workspace-editor-tooltip-surface')) continue;
        // Keep CodeMirror content outside the shared background-only SVG filter.
        const panel = document.createElement('div');
        panel.className = `${panelStyles.panel} workspace-editor-tooltip-surface`;
        panel.dataset.liquidGlassBackdrop = 'true';
        panel.setAttribute('aria-hidden', 'true');
        tooltip.append(panel);
        this.blurSurfaces.set(panel, registerTooltipBlur(panel));
      }
    }

    destroy(): void {
      this.observer.disconnect();
      this.cleanupScrollbars();
      for (const release of this.blurSurfaces.values()) release();
      this.blurSurfaces.clear();
      portal.remove();
    }
  });

  return [surfaces, tooltips({ parent: portal })];
}
