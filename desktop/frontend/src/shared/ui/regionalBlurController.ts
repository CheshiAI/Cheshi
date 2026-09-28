import { regionalBlurMask, type BlurSurface } from './regionalBlurGeometry';

const SURFACE_ATTRIBUTE = 'data-regional-blur-surface';
const SOURCE_ATTRIBUTE = 'data-regional-blur-source';
const surfaceOwners = new WeakMap<HTMLElement, { previous: string | null; owners: Set<object> }>();

function restoreAttribute(element: Element, name: string, value: string | null) {
  if (value === null) element.removeAttribute(name);
  else element.setAttribute(name, value);
}

/** Nested source controllers share the native-backdrop override until the last one releases it. */
function setSurfaceOwner(panel: HTMLElement, owner: object, active: boolean) {
  let state = surfaceOwners.get(panel);
  if (active) {
    if (!state) {
      state = { previous: panel.getAttribute(SURFACE_ATTRIBUTE), owners: new Set() };
      surfaceOwners.set(panel, state);
    }
    state.owners.add(owner);
    if (panel.getAttribute(SURFACE_ATTRIBUTE) !== 'true') panel.setAttribute(SURFACE_ATTRIBUTE, 'true');
  } else if (state?.owners.delete(owner) && !state.owners.size) {
    restoreAttribute(panel, SURFACE_ATTRIBUTE, state.previous);
    surfaceOwners.delete(panel);
  }
}

function ancestors(element: HTMLElement) {
  const result = new Set<HTMLElement>();
  for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement) result.add(parent);
  return result;
}

function visibleSurface(element: HTMLElement): BlurSurface | null {
  if (!element.isConnected || !element.getClientRects().length || element.closest('[hidden], [inert]')) return null;
  const style = getComputedStyle(element);
  if (style.visibility !== 'visible' || style.display === 'none' || style.opacity === '0') return null;
  const r = element.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height,
    corners: [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius] };
}

/** One filtered source image replaces its covered pixels; it never paints a second backdrop. */
export function createRegionalBlurController() {
  const panels = new Set<HTMLElement>();
  const owner = {};
  let refresh: (() => void) | undefined;

  const register = (panel: HTMLElement) => {
    panels.add(panel);
    refresh?.();
    return () => {
      setSurfaceOwner(panel, owner, false);
      panels.delete(panel);
      refresh?.();
    };
  };

  const connect = (source: HTMLElement, filter: SVGFilterElement, mask: SVGFEImageElement) => {
    const document = source.ownerDocument;
    const window = document.defaultView;
    if (!window) return () => {};
    const previousFilter = source.style.getPropertyValue('filter');
    const previousPriority = source.style.getPropertyPriority('filter');
    const previousAttribute = source.getAttribute(SOURCE_ATTRIBUTE);
    const appliedFilter = `url("#${filter.id}")`;
    let disposed = false, frame: number | null = null, lastMask: string | null = null;
    let watched = new Set<HTMLElement>();
    const moving = new Map<EventTarget, Set<string>>();

    const restoreSource = () => {
      if (source.style.getPropertyValue('filter') === appliedFilter) {
        if (previousFilter) source.style.setProperty('filter', previousFilter, previousPriority);
        else source.style.removeProperty('filter');
      }
      restoreAttribute(source, SOURCE_ATTRIBUTE, previousAttribute);
    };
    const update = () => {
      if (disposed) return;
      const rect = source.getBoundingClientRect();
      const surfaces: BlurSurface[] = [];
      for (const panel of panels) {
        // A panel inside SourceGraphic would blur its own foreground. Keep its existing behavior.
        if (source.contains(panel)) { setSurfaceOwner(panel, owner, false); continue; }
        setSurfaceOwner(panel, owner, true);
        const surface = visibleSurface(panel);
        if (surface) surfaces.push(surface);
      }
      const width = source.offsetWidth, height = source.offsetHeight;
      const nextMask = regionalBlurMask(rect, width, height, surfaces);
      if (nextMask === lastMask) return;
      lastMask = nextMask;
      if (!nextMask) { restoreSource(); mask.removeAttribute('href'); return; }
      filter.setAttribute('width', String(width));
      filter.setAttribute('height', String(height));
      mask.setAttribute('width', String(width));
      mask.setAttribute('height', String(height));
      mask.setAttribute('href', `data:image/svg+xml,${encodeURIComponent(nextMask)}`);
      source.style.setProperty('filter', appliedFilter);
      source.setAttribute(SOURCE_ATTRIBUTE, filter.id);
    };
    const schedule = () => {
      if (disposed || frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        update();
        if (moving.size) schedule();
      });
    };
    const resize = new ResizeObserver(schedule);
    const mutation = new MutationObserver(schedule);
    const refreshTargets = () => {
      resize.disconnect(); mutation.disconnect(); watched = ancestors(source);
      resize.observe(source);
      for (const panel of panels.keys()) {
        resize.observe(panel);
        for (const ancestor of ancestors(panel)) watched.add(ancestor);
      }
      for (const target of moving.keys()) {
        if (!(target instanceof HTMLElement) || !target.isConnected || !watched.has(target)) moving.delete(target);
      }
      // Observe only geometry/theme ancestors, not every streamed message or character.
      for (const element of watched) mutation.observe(element, { attributes: true });
      update();
    };
    const motion = (event: Event) => {
      if (!(event.target instanceof HTMLElement) || !watched.has(event.target)) return;
      const name = 'propertyName' in event ? String(event.propertyName) : 'animationName' in event ? String(event.animationName) : '';
      const starting = event.type === 'transitionrun' || event.type === 'animationstart';
      const names = moving.get(event.target) ?? new Set<string>();
      if (starting) names.add(name); else names.delete(name);
      if (names.size) moving.set(event.target, names); else moving.delete(event.target);
      schedule();
    };
    const motionEvents = ['transitionrun', 'transitionend', 'transitioncancel', 'animationstart', 'animationend', 'animationcancel'];
    document.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('scroll', schedule);
    for (const event of motionEvents) document.addEventListener(event, motion, true);
    refresh = refreshTargets;
    refreshTargets();

    return () => {
      disposed = true;
      refresh = undefined;
      if (frame !== null) window.cancelAnimationFrame(frame);
      resize.disconnect(); mutation.disconnect();
      document.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('scroll', schedule);
      for (const event of motionEvents) document.removeEventListener(event, motion, true);
      for (const panel of panels) setSurfaceOwner(panel, owner, false);
      restoreSource();
      mask.removeAttribute('href');
    };
  };
  return { register, connect };
}
