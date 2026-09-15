import { deflateSync } from 'node:zlib';
import type { MenuBarFont } from './menu-bar-font.mts';
import type { MenuBarLogo } from './menu-bar-logo.mts';

const SIZE = 22;
const SAMPLES = 4;
const RING_WIDTH = 1.725;
const NUMBER_CENTER_Y = 18.4;
type Point = readonly [number, number];
const DIGITS: Record<string, Point[][]> = {
  '0': [[[1, 0.4], [2, 0.4], [2.6, 1.2], [2.6, 4.6], [2, 5.4], [1, 5.4], [0.4, 4.6], [0.4, 1.2], [1, 0.4]]],
  '1': [[[0.6, 1.3], [1.5, 0.4], [1.5, 5.4]], [[0.5, 5.4], [2.5, 5.4]]],
  '2': [[[0.4, 1.1], [1, 0.4], [2, 0.4], [2.6, 1.1], [2.6, 2], [0.4, 4.7], [0.4, 5.4], [2.6, 5.4]]],
  '3': [[[0.4, 0.4], [2, 0.4], [2.6, 1.1], [2.6, 2.2], [1.6, 2.9], [2.6, 3.6], [2.6, 4.7], [2, 5.4], [0.4, 5.4]], [[1, 2.9], [1.6, 2.9]]],
  '4': [[[2.1, 0.4], [0.4, 3.7], [2.6, 3.7]], [[2.1, 0.4], [2.1, 5.4]]],
  '5': [[[2.6, 0.4], [0.4, 0.4], [0.4, 2.8], [2, 2.8], [2.6, 3.5], [2.6, 4.7], [2, 5.4], [0.4, 5.4]]],
  '6': [[[2.5, 0.4], [1.2, 0.4], [0.4, 1.5], [0.4, 4.7], [1, 5.4], [2, 5.4], [2.6, 4.7], [2.6, 3.5], [2, 2.8], [0.4, 2.8]]],
  '7': [[[0.4, 0.4], [2.6, 0.4], [1, 5.4]]],
  '8': [[[1, 2.9], [0.4, 2.2], [0.4, 1.1], [1, 0.4], [2, 0.4], [2.6, 1.1], [2.6, 2.2], [2, 2.9], [1, 2.9], [0.4, 3.6], [0.4, 4.7], [1, 5.4], [2, 5.4], [2.6, 4.7], [2.6, 3.6], [2, 2.9]]],
  '9': [[[2.6, 3], [1, 3], [0.4, 2.3], [0.4, 1.1], [1, 0.4], [2, 0.4], [2.6, 1.1], [2.6, 4.3], [1.8, 5.4], [0.5, 5.4]]],
  '-': [[[0.4, 2.9], [2.6, 2.9]]],
};

type Color = readonly [number, number, number];
interface Shape { contains: (x: number, y: number) => boolean; color: Color; alpha: number | ((x: number, y: number) => number) }

function arc(cx: number, cy: number, radius: number, start: number, sweep: number,
  width: number, color: Color, alpha = 1): Shape {
  const startAngle = start * Math.PI / 180;
  const sweepAngle = sweep * Math.PI / 180;
  const startX = radius * Math.cos(startAngle);
  const startY = radius * Math.sin(startAngle);
  const endX = radius * Math.cos(startAngle + sweepAngle);
  const endY = radius * Math.sin(startAngle + sweepAngle);
  return { color, alpha, contains: (x, y) => {
    if (sweep === 0) return false;
    const dx = x - cx;
    const dy = y - cy;
    if (Math.hypot(dx - startX, dy - startY) <= width / 2 || Math.hypot(dx - endX, dy - endY) <= width / 2) return true;
    if (Math.abs(Math.hypot(dx, dy) - radius) > width / 2) return false;
    const delta = (Math.atan2(dy, dx) - startAngle) * Math.sign(sweep);
    const angle = (delta % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
    return angle <= Math.abs(sweepAngle);
  } };
}

function systemNumberShapes(label: string, color: Color, font: MenuBarFont): Shape[] {
  let cursor = 0;
  const glyphs = [...label].map(digit => {
    const glyph = font.glyphs[digit]!;
    const x = cursor + glyph.left;
    cursor += glyph.advance;
    return { glyph, x };
  });
  const left = Math.min(...glyphs.map(entry => entry.x));
  const right = Math.max(...glyphs.map(entry => entry.x + entry.glyph.width));
  const top = Math.min(...glyphs.map(entry => entry.glyph.top));
  const bottom = Math.max(...glyphs.map(entry => entry.glyph.top + entry.glyph.height));
  const scale = Math.min(1 / font.scale, 11 / (right - left), 5.7 / (bottom - top));
  const offsetX = (SIZE - (right - left) * scale) / 2;
  const offsetY = NUMBER_CENTER_Y - (bottom - top) * scale / 2;
  return glyphs.map(({ glyph, x: glyphX }) => {
    const x0 = offsetX + (glyphX - left) * scale;
    const y0 = offsetY + (glyph.top - top) * scale;
    const alpha = (x: number, y: number) => {
      const px = Math.floor((x - x0) / scale);
      const py = Math.floor((y - y0) / scale);
      return px >= 0 && px < glyph.width && py >= 0 && py < glyph.height
        ? glyph.alpha[py * glyph.width + px]! / 255 : 0;
    };
    return { color, alpha, contains: (x: number, y: number) => alpha(x, y) > 0 };
  });
}

function numberShapes(label: string, color: Color, font?: MenuBarFont): Shape[] {
  if (font) return systemNumberShapes(label, color, font);
  const shapes: Shape[] = [];
  const glyphScale = Math.min(1, 11 / (label.length * 4 - 1));
  const left = (SIZE - (label.length * 4 - 1) * glyphScale) / 2;
  for (const [digitIndex, digit] of [...label].entries()) {
    for (const path of DIGITS[digit]!) {
      shapes.push({ color, alpha: 1, contains: (x, y) => {
        const localX = (x - left) / glyphScale - digitIndex * 4;
        const localY = y - (NUMBER_CENTER_Y - 5.8 / 2);
        if (localX < 0 || localX > 3 || localY < 0 || localY > 5.8) return false;
        for (let index = 1; index < path.length; index++) {
          const [ax, ay] = path[index - 1]!;
          const [bx, by] = path[index]!;
          const dx = bx - ax;
          const dy = by - ay;
          const t = Math.max(0, Math.min(1, ((localX - ax) * dx + (localY - ay) * dy) / (dx * dx + dy * dy)));
          if (Math.hypot(localX - ax - t * dx, localY - ay - t * dy) <= 0.38) return true;
        }
        return false;
      } });
    }
  }
  return shapes;
}

function logoShape(logo: MenuBarLogo, color: Color): Shape {
  const scale = Math.min(11 / logo.width, 11 / logo.height);
  const left = (SIZE - logo.width * scale) / 2;
  const top = 9.6 - logo.height * scale / 2;
  const alpha = (x: number, y: number) => {
    const px = Math.floor((x - left) / scale);
    const py = Math.floor((y - top) / scale);
    return px >= 0 && px < logo.width && py >= 0 && py < logo.height
      ? logo.alpha[py * logo.width + px]! / 255 : 0;
  };
  return { color, alpha, contains: (x, y) => alpha(x, y) > 0 };
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const payload = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const output = Buffer.alloc(payload.length + 8);
  output.writeUInt32BE(data.length);
  payload.copy(output, 4);
  output.writeUInt32BE(crc32(payload), output.length - 4);
  return output;
}

function encodePng(width: number, rgba: Buffer): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(width, 4);
  header[8] = 8;
  header[9] = 6;
  const stride = width * 4;
  const rows = Buffer.alloc((stride + 1) * width);
  for (let y = 0; y < width; y++) rgba.copy(rows, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

/** Draw the ring, brand mask and percentage without a renderer process. */
export function renderAccountUsageTrayIcon(percent: number | null, options: {
  dark?: boolean; scaleFactor?: number; template?: boolean; font?: MenuBarFont; logo?: MenuBarLogo;
} = {}): Buffer {
  const scale = options.scaleFactor ?? 2;
  if (!Number.isFinite(scale) || scale <= 0 || scale > 4 || !Number.isInteger(SIZE * scale)) {
    throw new Error('Tray icon scale factor must produce an integer size between 1 and 88 pixels.');
  }
  const value = percent === null || !Number.isFinite(percent) ? null : Math.max(0, Math.min(100, percent));
  const template = options.template !== false;
  const color: Color = !template && options.dark === true ? [255, 255, 255] : [0, 0, 0];
  const fraction = value === null ? 0 : value / 100;
  const shapes: Shape[] = [
    arc(11, 11, 9, 135, 270, RING_WIDTH, color, 0.22),
    arc(11, 11, 9, 135, 270 * fraction, RING_WIDTH, color),
    ...(options.logo ? [logoShape(options.logo, color)] : []),
    ...numberShapes(value === null ? '-' : String(Math.round(value)), color, options.font),
  ];
  const layers = [...shapes].reverse();
  const width = SIZE * scale;
  const rgba = Buffer.alloc(width * width * 4);
  for (let py = 0; py < width; py++) for (let px = 0; px < width; px++) {
    let alpha = 0;
    const channels = [0, 0, 0];
    for (let sy = 0; sy < SAMPLES; sy++) for (let sx = 0; sx < SAMPLES; sx++) {
      const x = (px + (sx + 0.5) / SAMPLES) / scale;
      const y = (py + (sy + 0.5) / SAMPLES) / scale;
      const shape = layers.find(candidate => candidate.contains(x, y));
      if (!shape) continue;
      const opacity = typeof shape.alpha === 'number' ? shape.alpha : shape.alpha(x, y);
      alpha += opacity;
      for (let channel = 0; channel < 3; channel++) channels[channel]! += shape.color[channel]! * opacity;
    }
    const offset = (py * width + px) * 4;
    if (alpha > 0) for (let channel = 0; channel < 3; channel++) rgba[offset + channel] = Math.round(channels[channel]! / alpha);
    rgba[offset + 3] = Math.round(alpha / (SAMPLES * SAMPLES) * 255);
  }
  return encodePng(width, rgba);
}
