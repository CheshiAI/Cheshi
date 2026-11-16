import type { WorkspaceSurfaceApi } from '../../../../shared/workspace-host';
import { registerTooltipBlur } from '../../shared/ui/tooltipBlur';

/** A geometry-only portal lets the shared SVG filter blur the live workspace. */
export function connectWorkspaceRailBlur(api: WorkspaceSurfaceApi, document: Document) {
  let portal: HTMLDivElement | undefined;
  let panel: HTMLDivElement | undefined;
  let release: (() => void) | undefined;
  const clear = () => {
    release?.(); release = undefined;
    portal?.remove(); portal = undefined; panel = undefined;
  };
  const unsubscribe = api.onRailBlur(region => {
    if (!region) { clear(); return; }
    if (!panel) {
      portal = document.createElement('div');
      portal.setAttribute('data-tooltip-blur-portal', '');
      portal.setAttribute('data-workspace-rail-blur', '');
      portal.setAttribute('aria-hidden', 'true');
      portal.style.cssText = 'position:fixed;inset:0;pointer-events:none;overflow:clip';
      panel = document.createElement('div');
      panel.style.cssText = 'position:absolute;visibility:visible;opacity:1;pointer-events:none;background:transparent';
      portal.append(panel); document.body.append(portal);
    }
    Object.assign(panel.style, { left: `${region.x}px`, top: `${region.y}px`,
      width: `${region.width}px`, height: `${region.height}px`, borderRadius: `${region.radius}px` });
    release ??= registerTooltipBlur(panel);
  });
  return () => { unsubscribe(); clear(); };
}
