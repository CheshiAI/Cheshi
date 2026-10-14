export interface BlurBounds { x: number; y: number; width: number; height: number }
export interface BlurSurface extends BlurBounds { corners: readonly [string, string, string, string] }

function coordinate(value: number) { return Math.round(value * 1000) / 1000; }

function cornerRadius(value: string, width: number, height: number): [number, number] {
  const [horizontal = '0', vertical = horizontal] = value.split(/\s+/);
  const length = (token: string, size: number) => Math.max(0, Number.parseFloat(token) || 0) * (token.endsWith('%') ? size / 100 : 1);
  return [length(horizontal, width), length(vertical, height)];
}

/** Keep each surface's rounded corners, including the composer's square queue edge. */
function roundedPath(surface: BlurSurface, bounds: BlurBounds, width: number, height: number) {
  const sx = width / bounds.width, sy = height / bounds.height;
  const x = coordinate((surface.x - bounds.x) * sx), y = coordinate((surface.y - bounds.y) * sy);
  const w = coordinate(surface.width * sx), h = coordinate(surface.height * sy);
  const corners = surface.corners.map(value => cornerRadius(value, w, h));
  const [tl, tr, br, bl] = corners as [[number, number], [number, number], [number, number], [number, number]];
  const scale = Math.min(1, w / Math.max(1, tl[0] + tr[0], bl[0] + br[0]), h / Math.max(1, tl[1] + bl[1], tr[1] + br[1]));
  for (const corner of corners) { corner[0] = coordinate(corner[0] * scale); corner[1] = coordinate(corner[1] * scale); }
  return `M${x + tl[0]} ${y}H${x + w - tr[0]}A${tr[0]} ${tr[1]} 0 0 1 ${x + w} ${y + tr[1]}`
    + `V${y + h - br[1]}A${br[0]} ${br[1]} 0 0 1 ${x + w - br[0]} ${y + h}`
    + `H${x + bl[0]}A${bl[0]} ${bl[1]} 0 0 1 ${x} ${y + h - bl[1]}`
    + `V${y + tl[1]}A${tl[0]} ${tl[1]} 0 0 1 ${x + tl[0]} ${y}Z`;
}

function visibleSurfaces(bounds: BlurBounds, surfaces: readonly BlurSurface[]) {
  return surfaces.filter(r => r.width > 0 && r.height > 0
    && r.x < bounds.x + bounds.width && r.y < bounds.y + bounds.height
    && r.x + r.width > bounds.x && r.y + r.height > bounds.y);
}

function maskSvg(bounds: BlurBounds, width: number, height: number, surfaces: readonly BlurSurface[], image: BlurBounds) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${image.width}" height="${image.height}" viewBox="${image.x} ${image.y} ${image.width} ${image.height}">`
    + surfaces.map(surface => `<path fill="white" d="${roundedPath(surface, bounds, width, height)}"/>`).join('') + '</svg>';
}

/** The SVG viewport clips offscreen regions without inventing new rounded edges. */
export function regionalBlurMask(bounds: BlurBounds, width: number, height: number, surfaces: readonly BlurSurface[]) {
  if (bounds.width <= 0 || bounds.height <= 0 || width <= 0 || height <= 0) return null;
  const visible = visibleSurfaces(bounds, surfaces);
  if (!visible.length) return null;
  return maskSvg(bounds, width, height, visible, { x: 0, y: 0, width, height });
}

/** Crop transparent mask pixels, keeping paths in the original source coordinates.
 * feImage's placement must match this viewBox to avoid rescaling the rounded mask.
 * This reduces the animated SVG image's raster area without changing blur or alpha.
 */
export function regionalBlurMaskImage(bounds: BlurBounds, width: number, height: number, surfaces: readonly BlurSurface[]) {
  if (bounds.width <= 0 || bounds.height <= 0 || width <= 0 || height <= 0) return null;
  const visible = visibleSurfaces(bounds, surfaces);
  if (!visible.length) return null;
  const sx = width / bounds.width, sy = height / bounds.height;
  const x = Math.max(0, Math.floor(Math.min(...visible.map(r => (r.x - bounds.x) * sx))));
  const y = Math.max(0, Math.floor(Math.min(...visible.map(r => (r.y - bounds.y) * sy))));
  const right = Math.min(width, Math.ceil(Math.max(...visible.map(r => (r.x + r.width - bounds.x) * sx))));
  const bottom = Math.min(height, Math.ceil(Math.max(...visible.map(r => (r.y + r.height - bounds.y) * sy))));
  const image = { x, y, width: right - x, height: bottom - y };
  return { ...image, svg: maskSvg(bounds, width, height, visible, image) };
}
