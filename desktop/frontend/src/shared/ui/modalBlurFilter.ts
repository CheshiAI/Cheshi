import { regionalBlurMask, type BlurSurface } from './regionalBlurGeometry';

const SVG_NS = 'http://www.w3.org/2000/svg';
let nextFilter = 0;

/** The panel region replaces scene pixels rather than compositing a second backdrop. */
export function createModalBlurFilter(defs: SVGDefsElement) {
  const document = defs.ownerDocument;
  const node = <K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string>) => {
    const element = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
    return element;
  };
  const filter = node('filter', { id: `modal-scene-blur-${++nextFilter}`, x: '0', y: '0', width: '100%', height: '100%',
    'color-interpolation-filters': 'sRGB' });
  const mask = node('feImage', { x: '0', y: '0', result: 'region' });
  filter.append(
    node('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: '16', edgeMode: 'duplicate', result: 'scene' }),
    node('feGaussianBlur', { in: 'scene', stdDeviation: '16', edgeMode: 'duplicate', result: 'panel' }),
    mask,
    node('feComposite', { in: 'scene', in2: 'region', operator: 'out', result: 'outside' }),
    node('feComposite', { in: 'panel', in2: 'region', operator: 'in', result: 'inside' }),
    node('feComposite', { in: 'outside', in2: 'inside', operator: 'arithmetic', k2: '1', k3: '1' }),
  );
  defs.append(filter);
  let previousMask: string | null | undefined;
  return {
    id: filter.id,
    update(source: HTMLElement, dialog: HTMLDialogElement) {
      const width = source.offsetWidth, height = source.offsetHeight;
      const bounds = source.getBoundingClientRect(), rect = dialog.getBoundingClientRect();
      const style = document.defaultView!.getComputedStyle(dialog);
      const surface: BlurSurface = { x: rect.x, y: rect.y, width: rect.width, height: rect.height,
        corners: [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius] };
      const nextMask = regionalBlurMask(bounds, width, height, [surface]);
      if (width > 0 && height > 0) {
        filter.setAttribute('filterUnits', 'userSpaceOnUse');
        filter.setAttribute('primitiveUnits', 'userSpaceOnUse');
        filter.setAttribute('width', String(width)); filter.setAttribute('height', String(height));
        mask.setAttribute('width', String(width)); mask.setAttribute('height', String(height));
      }
      if (previousMask === nextMask) return;
      previousMask = nextMask;
      // An empty mask leaves the scene blur alone for sources outside the panel.
      if (!nextMask) { mask.removeAttribute('href'); return; }
      mask.setAttribute('href', `data:image/svg+xml,${encodeURIComponent(nextMask)}`);
    },
    dispose() { filter.remove(); },
  };
}
