const SVG_NS = 'http://www.w3.org/2000/svg';
// Three standard deviations cover the 16px Gaussian kernel at source boundaries.
const PADDING = 48;

/** Explicitly clamp sampling: Chromium does not reliably honor Gaussian edgeMode. */
export function createBlurEdgePadding(filter: SVGFilterElement) {
  const node = <K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string>) => {
    const element = filter.ownerDocument.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
    return element;
  };
  const patches: { dx: number; dy: number; crop: SVGFEOffsetElement; tile: SVGFETileElement }[] = [];
  const merge = node('feMerge', { result: 'edge-padded' });
  for (const dy of [-1, 0, 1]) {
    for (const dx of [-1, 0, 1]) {
      if (dx === 0 && dy === 0) continue;
      const id = patches.length;
      // Crop a one-pixel edge/corner, then repeat it only outside SourceGraphic.
      const crop = node('feOffset', { in: 'SourceGraphic', dx: '0', dy: '0', result: `edge-${id}` });
      const tile = node('feTile', { in: `edge-${id}`, result: `padding-${id}` });
      patches.push({ dx, dy, crop, tile });
      merge.append(node('feMergeNode', { in: `padding-${id}` }));
    }
  }
  merge.append(node('feMergeNode', { in: 'SourceGraphic' }));
  filter.prepend(...patches.flatMap(patch => [patch.crop, patch.tile]), merge);

  const rect = (element: SVGElement, x: number, y: number, width: number, height: number) => {
    for (const [name, value] of Object.entries({ x, y, width, height })) element.setAttribute(name, String(value));
  };
  return (width: number, height: number) => {
    rect(filter, -PADDING, -PADDING, width + PADDING * 2, height + PADDING * 2);
    for (const { dx, dy, crop, tile } of patches) {
      rect(crop, dx > 0 ? width - 1 : 0, dy > 0 ? height - 1 : 0,
        dx === 0 ? width : 1, dy === 0 ? height : 1);
      rect(tile, dx < 0 ? -PADDING : dx > 0 ? width : 0, dy < 0 ? -PADDING : dy > 0 ? height : 0,
        dx === 0 ? width : PADDING, dy === 0 ? height : PADDING);
    }
  };
}
