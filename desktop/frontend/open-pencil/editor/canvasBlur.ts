import { createRegionalBlurController } from '../../src/shared/ui/regionalBlurController';
import { createRegionalBlurFilter } from '../../src/shared/ui/regionalBlurFilter';

const surfaces = '[role="menu"], [role="listbox"], [data-test-id="toolbar"]';
const svgNamespace = 'http://www.w3.org/2000/svg';

/** Connect Vue/Teleport surfaces to Cheshi's shared blur inside the editor document. */
export function connectCanvasBlur(source: HTMLElement) {
  const document = source.ownerDocument;
  const window = document.defaultView;
  if (!window) return () => {};
  const svg = document.createElementNS(svgNamespace, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.style.cssText = 'position:absolute;pointer-events:none';
  const defs = document.createElementNS(svgNamespace, 'defs');
  svg.append(defs);
  document.body.append(svg);
  const effect = createRegionalBlurFilter(defs);
  const controller = createRegionalBlurController();
  const disconnect = controller.connect(source, effect.filter, effect.mask);
  const registrations = new Map<HTMLElement, () => void>();
  const sync = () => {
    const current = new Set(document.querySelectorAll<HTMLElement>(surfaces));
    for (const [surface, release] of registrations) {
      if (!current.has(surface)) { release(); registrations.delete(surface); }
    }
    for (const surface of current) {
      if (!registrations.has(surface) && !source.contains(surface)) {
        registrations.set(surface, controller.register(surface));
      }
    }
  };
  // Geometry, visibility, scrolling and animations are tracked by the shared
  // controller. This observer only discovers newly mounted/removed portals.
  const observer = new window.MutationObserver(sync);
  observer.observe(document.body, { childList: true, subtree: true });
  sync();
  return () => {
    observer.disconnect();
    for (const release of registrations.values()) release();
    registrations.clear();
    disconnect();
    effect.dispose();
    svg.remove();
  };
}
