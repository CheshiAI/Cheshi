import { unzipSync } from 'fflate';

/** Files exported without a renderer can contain a 1px placeholder, not a design preview. */
export function canvasVersionPreview(data: Uint8Array): Uint8Array | null {
  if (data[0] !== 80 || data[1] !== 75) return null;
  const png = unzipSync(data, { filter: entry => entry.name === 'thumbnail.png' && entry.originalSize <= 8 * 1024 * 1024 })['thumbnail.png'];
  if (!png || png.length < 24 || png[0] !== 137 || png[1] !== 80 || png[2] !== 78 || png[3] !== 71) return null;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  if (view.getUint32(16) <= 1 || view.getUint32(20) <= 1) return null;
  return png;
}
