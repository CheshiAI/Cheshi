import { createBlurEdgePadding } from './regionalBlurEdgePadding';

const SVG_NS = 'http://www.w3.org/2000/svg';
let nextFilter = 0;

/** Shared pixel-replacement filter for React panels and imperative tooltip portals. */
export function createRegionalBlurFilter(defs: SVGDefsElement, { extendEdges = false } = {}) {
  const node = <K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string>) => {
    const element = defs.ownerDocument.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
    return element;
  };
  const filter = node('filter', { id: `regional-blur-${++nextFilter}`, filterUnits: 'userSpaceOnUse',
    primitiveUnits: 'userSpaceOnUse', x: '0', y: '0', 'color-interpolation-filters': 'sRGB' });
  const mask = node('feImage', { x: '0', y: '0', result: 'region' });
  filter.append(
    node('feGaussianBlur', { in: extendEdges ? 'edge-padded' : 'SourceGraphic', stdDeviation: '16', edgeMode: 'duplicate', result: 'blurred' }),
    mask,
    node('feComposite', { in: 'SourceGraphic', in2: 'region', operator: 'out', result: 'sharp' }),
    node('feComposite', { in: 'blurred', in2: 'region', operator: 'in', result: 'soft' }),
    node('feComposite', { in: 'sharp', in2: 'soft', operator: 'arithmetic', k2: '1', k3: '1' }),
  );
  const resize = extendEdges ? createBlurEdgePadding(filter) : undefined;
  defs.append(filter);
  return { filter, mask, resize, dispose: () => filter.remove() };
}
