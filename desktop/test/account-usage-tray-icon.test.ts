import { inflateSync } from 'node:zlib';
import { expect, test } from 'bun:test';
import { renderAccountUsageTrayIcon } from '../lib/account-usage-tray-icon.mts';

function pixels(png: Buffer) {
  expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  expect(png[24]).toBe(8);
  expect(png[25]).toBe(6);
  const compressed: Buffer[] = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT') compressed.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const rows = inflateSync(Buffer.concat(compressed));
  expect(rows.length).toBe(height * (width * 4 + 1));
  const rgba: number[][] = [];
  for (let y = 0; y < height; y++) {
    expect(rows[y * (width * 4 + 1)]).toBe(0);
    for (let x = 0; x < width; x++) {
      const offset = y * (width * 4 + 1) + 1 + x * 4;
      rgba.push([...rows.subarray(offset, offset + 4)]);
    }
  }
  return { width, height, rgba };
}

test('creates transparent 22pt RGBA PNGs at standard and Retina resolutions', () => {
  for (const scaleFactor of [1, 2]) {
    const result = pixels(renderAccountUsageTrayIcon(96, { scaleFactor }));
    expect([result.width, result.height]).toEqual([22 * scaleFactor, 22 * scaleFactor]);
    expect(result.rgba[0]).toEqual([0, 0, 0, 0]);
    expect(result.rgba.some(pixel => pixel[3]! > 200)).toBe(true);
    expect(result.rgba.some(pixel => pixel[3]! > 0 && pixel[3]! < 255)).toBe(true);
  }
});

test('zero, full and unknown usage are distinct and clamp out-of-range values', () => {
  const empty = renderAccountUsageTrayIcon(0);
  const full = renderAccountUsageTrayIcon(100);
  const unknown = renderAccountUsageTrayIcon(null);
  expect(empty.equals(full)).toBe(false);
  expect(unknown.equals(empty)).toBe(false);
  expect(unknown.equals(full)).toBe(false);
  expect(renderAccountUsageTrayIcon(-5).equals(empty)).toBe(true);
  expect(renderAccountUsageTrayIcon(150).equals(full)).toBe(true);
  expect(renderAccountUsageTrayIcon(Number.NaN).equals(unknown)).toBe(true);
  const gaugeAlpha = (image: Buffer) => {
    const { width, rgba } = pixels(image);
    return rgba.reduce((sum, pixel, index) => sum + (index % width < 8 ? pixel[3]! : 0), 0);
  };
  expect(gaugeAlpha(full)).toBeGreaterThan(gaugeAlpha(empty));
});

test('gauges remain monochrome across the former low usage threshold in both themes', () => {
  for (const percent of [0, 20, 29.9, 30, 100]) {
    for (const template of [true, false]) for (const dark of [true, false]) {
      const { rgba } = pixels(renderAccountUsageTrayIcon(percent, { template, dark }));
      const channel = !template && dark ? 255 : 0;
      const visible = rgba.filter(pixel => pixel[3]! > 0);
      expect(visible.length).toBeGreaterThan(0);
      expect(visible.every(pixel => pixel[0] === channel && pixel[1] === channel && pixel[2] === channel)).toBe(true);
    }
  }
});

test('rejects invalid output scales before allocating an image', () => {
  for (const scaleFactor of [0, -1, 5, Number.NaN, Infinity, 1.01]) {
    expect(() => renderAccountUsageTrayIcon(50, { scaleFactor })).toThrow('Tray icon scale factor');
  }
});

test('half capacity fills the left arc before the right arc', () => {
  const { width, rgba } = pixels(renderAccountUsageTrayIcon(50));
  let left = 0;
  let right = 0;
  for (let y = 12; y < 34; y++) for (let x = 0; x < width; x++) {
    if (x < 12) left += rgba[y * width + x]![3]!;
    if (x >= width - 12) right += rgba[y * width + x]![3]!;
  }
  expect(left).toBeGreaterThan(right * 3);
});

test('places the active percentage below the logo area and keeps three digits centered', () => {
  const { width, rgba } = pixels(renderAccountUsageTrayIcon(100));
  const numberPixels = rgba.flatMap((pixel, index) => {
    const x = index % width;
    const y = Math.floor(index / width);
    const radius = Math.hypot((x + 0.5) / 2 - 11, (y + 0.5) / 2 - 11);
    const outsideArc = radius < 8 || y >= 37;
    return pixel[3]! > 0 && outsideArc && x >= 10 && x < width - 10 && y >= 30 ? [{ x, y }] : [];
  });
  expect(numberPixels.length).toBeGreaterThan(0);
  const xs = numberPixels.map(point => point.x);
  const ys = numberPixels.map(point => point.y);
  expect(Math.abs((Math.min(...xs) + Math.max(...xs) + 1) / 2 - width / 2)).toBeLessThanOrEqual(1);
  expect(Math.abs((Math.min(...ys) + Math.max(...ys) + 1) / 2 - 18.4 * 2)).toBeLessThanOrEqual(1);
  expect(Math.max(...xs) - Math.min(...xs) + 1).toBeLessThanOrEqual(22);
});

test('keeps the centered logo in the normal foreground color at low usage while preserving its transparent cutouts', () => {
  const alpha = new Uint8Array(100).fill(255);
  for (let y = 4; y < 6; y++) for (let x = 4; x < 6; x++) alpha[y * 10 + x] = 0;
  const { width, rgba } = pixels(renderAccountUsageTrayIcon(20, {
    dark: true, template: false, logo: { width: 10, height: 10, alpha },
  }));
  expect(rgba[19 * width + 22]).toEqual([0, 0, 0, 0]);
  expect(rgba[15 * width + 22]).toEqual([255, 255, 255, 255]);
  expect(rgba.filter(pixel => pixel[3]! > 0).every(pixel => pixel[0] === 255 && pixel[1] === 255 && pixel[2] === 255)).toBe(true);
});
