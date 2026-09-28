import { createRegionalBlurController } from './regionalBlurController';
import { createRegionalBlurFilter } from './regionalBlurFilter';

const SVG_NS = 'http://www.w3.org/2000/svg';
const PORTAL = '[data-tooltip-blur-portal]';
const managers = new WeakMap<Document, ReturnType<typeof createTooltipBlur>>();

/** Exclude foreground portals, descending into dialogs so top-layer tooltips stay sharp. */
function backgroundSources(document: Document) {
  const sources: HTMLElement[] = [];
  const visit = (element: Element) => {
    if (element.namespaceURI !== 'http://www.w3.org/1999/xhtml'
      || /^(SCRIPT|STYLE|LINK|TEMPLATE)$/.test(element.tagName) || element.matches(PORTAL)) return;
    if (element.querySelector(PORTAL)) {
      for (const child of element.children) visit(child);
    } else sources.push(element as HTMLElement);
  };
  for (const child of document.body.children) visit(child);
  return sources;
}

function createTooltipBlur(document: Document) {
  const panels = new Map<HTMLElement, HTMLElement | undefined>();
  const sources = new Map<HTMLElement, {
    register(panel: HTMLElement): () => void;
    registrations: Map<HTMLElement, () => void>;
    dispose(): void;
  }>();
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', '0'); svg.setAttribute('height', '0');
  svg.setAttribute('aria-hidden', 'true');
  svg.style.cssText = 'position:absolute;pointer-events:none';
  const defs = document.createElementNS(SVG_NS, 'defs');
  svg.append(defs); document.body.append(svg);

  const sync = () => {
    const backgrounds = backgroundSources(document);
    const wanted = new Map<HTMLElement, Set<HTMLElement>>();
    for (const [panel, explicitSource] of panels) {
      if (!panel.isConnected) continue;
      for (const source of explicitSource ? [explicitSource] : backgrounds) {
        if (!source.isConnected || source.contains(panel)) continue;
        const set = wanted.get(source) ?? new Set<HTMLElement>();
        set.add(panel); wanted.set(source, set);
      }
    }
    for (const [source, entry] of sources) {
      if (!wanted.has(source)) { entry.dispose(); sources.delete(source); }
    }
    for (const [source, surfaces] of wanted) {
      let entry = sources.get(source);
      if (!entry) {
        const controller = createRegionalBlurController({ preserveFilter: true });
        const effect = createRegionalBlurFilter(defs, { extendEdges: true });
        const disconnect = controller.connect(source, effect.filter, effect.mask, effect.resize);
        const registrations = new Map<HTMLElement, () => void>();
        entry = { register: controller.register, registrations, dispose: () => {
          for (const release of registrations.values()) release();
          disconnect(); effect.dispose();
        } };
        sources.set(source, entry);
      }
      for (const [panel, release] of entry.registrations) {
        if (!surfaces.has(panel)) { release(); entry.registrations.delete(panel); }
      }
      for (const panel of surfaces) {
        if (!entry.registrations.has(panel)) entry.registrations.set(panel, entry.register(panel));
      }
    }
  };
  const observer = new document.defaultView!.MutationObserver(sync);
  observer.observe(document.body, { childList: true, subtree: true });
  return {
    register(panel: HTMLElement, source?: HTMLElement) {
      panels.set(panel, source); sync();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        panels.delete(panel); sync();
        if (!panels.size) {
          observer.disconnect(); svg.remove(); managers.delete(document);
        }
      };
    },
  };
}

/** All tooltip implementations share one masked SVG filter per background source. */
export function registerTooltipBlur(panel: HTMLElement, source?: HTMLElement) {
  const document = panel.ownerDocument;
  let manager = managers.get(document);
  if (!manager) {
    manager = createTooltipBlur(document);
    managers.set(document, manager);
  }
  return manager.register(panel, source);
}
