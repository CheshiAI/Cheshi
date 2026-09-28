import { createModalBlurFilter } from './modalBlurFilter';

const SVG_NS = 'http://www.w3.org/2000/svg';
const TOP_ATTRIBUTE = 'data-modal-blur-top';
const documents = new WeakMap<Document, ReturnType<typeof createModalBlur>>();

function restoreAttribute(element: Element, name: string, value: string | null) {
  if (value === null) element.removeAttribute(name);
  else element.setAttribute(name, value);
}

/** Filter the original scene once, with the active dialog outside that scene. */
function createModalBlur(document: Document) {
  const dialogs = new Map<HTMLDialogElement, string | null>();
  const sources = new Map<HTMLElement, { filter: string; priority: string; applied: string; effect: ReturnType<typeof createModalBlurFilter> }>();
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.setAttribute('aria-hidden', 'true');
  svg.style.cssText = 'position:absolute;pointer-events:none';
  const defs = document.createElementNS(SVG_NS, 'defs');
  svg.append(defs); document.body.append(svg);

  const restoreSource = (source: HTMLElement) => {
    const saved = sources.get(source);
    if (!saved) return;
    if (source.style.getPropertyValue('filter') === saved.applied) {
      if (saved.filter) source.style.setProperty('filter', saved.filter, saved.priority);
      else source.style.removeProperty('filter');
    }
    saved.effect.dispose();
    if (![...dialogs.keys()].some(dialog => dialog === source)) resize.unobserve(source);
    sources.delete(source);
  };
  const update = () => {
    const top = [...dialogs.keys()].filter(dialog => dialog.isConnected && dialog.open).at(-1);
    for (const dialog of dialogs.keys()) dialog.setAttribute(TOP_ATTRIBUTE, String(dialog === top));
    const behind = new Set<HTMLElement>();
    if (top) {
      // App content and HTML portals are siblings of the native top-layer dialog.
      for (const child of document.body.children) {
        if (child.namespaceURI !== 'http://www.w3.org/1999/xhtml'
          || /^(SCRIPT|STYLE|LINK|TEMPLATE)$/.test(child.tagName) || child.contains(top)) continue;
        behind.add(child as HTMLElement);
      }
    }
    for (const source of sources.keys()) if (!behind.has(source)) restoreSource(source);
    for (const source of behind) {
      let saved = sources.get(source);
      if (!saved) {
        const previous = document.defaultView?.getComputedStyle(source).filter;
        const effect = createModalBlurFilter(defs);
        const applied = `${previous && previous !== 'none' ? `${previous} ` : ''}url("#${effect.id}")`;
        saved = { filter: source.style.getPropertyValue('filter'), priority: source.style.getPropertyPriority('filter'), applied, effect };
        sources.set(source, saved);
        source.style.setProperty('filter', applied, saved.priority);
        resize.observe(source);
      }
      if (top) saved.effect.update(source, top);
    }
  };
  const Observer = document.defaultView!.MutationObserver;
  const observer = new Observer(update);
  const resize = new document.defaultView!.ResizeObserver(update);
  const window = document.defaultView!;
  window.addEventListener('resize', update);
  document.addEventListener('scroll', update, true);
  const observe = () => {
    observer.disconnect();
    observer.observe(document.body, { childList: true });
    for (const dialog of dialogs.keys()) observer.observe(dialog, { attributes: true, attributeFilter: ['open', 'class', 'style'] });
  };
  return {
    register(dialog: HTMLDialogElement) {
      dialogs.set(dialog, dialog.getAttribute(TOP_ATTRIBUTE));
      resize.observe(dialog);
      observe(); update();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        restoreAttribute(dialog, TOP_ATTRIBUTE, dialogs.get(dialog) ?? null);
        dialogs.delete(dialog);
        resize.unobserve(dialog);
        update();
        if (dialogs.size) observe();
        else {
          observer.disconnect(); resize.disconnect();
          window.removeEventListener('resize', update);
          document.removeEventListener('scroll', update, true);
          svg.remove(); documents.delete(document);
        }
      };
    },
  };
}

export function registerModalBlur(dialog: HTMLDialogElement) {
  const document = dialog.ownerDocument;
  let controller = documents.get(document);
  if (!controller) {
    controller = createModalBlur(document);
    documents.set(document, controller);
  }
  return controller.register(dialog);
}
