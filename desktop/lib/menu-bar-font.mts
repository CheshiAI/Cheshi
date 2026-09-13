import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export interface MenuBarGlyph {
  width: number;
  height: number;
  left: number;
  top: number;
  advance: number;
  alpha: number[];
}

export interface MenuBarFont {
  scale: number;
  glyphs: Record<string, MenuBarGlyph>;
}

const CHARACTERS = '0123456789-';
const CANVAS_WIDTH = 32;
const CANVAS_HEIGHT = 48;
const SCRIPT = `
ObjC.import('AppKit');
var glyphs = {};
var attrs = $.NSMutableDictionary.alloc.init;
attrs.setObjectForKey($.NSFont.monospacedDigitSystemFontOfSizeWeight(32, $.NSFontWeightMedium), $.NSFontAttributeName);
attrs.setObjectForKey($.NSColor.whiteColor, $.NSForegroundColorAttributeName);
for (var character of '0123456789-') {
  var rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(
    null, 32, 48, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0);
  var context = $.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep);
  $.NSGraphicsContext.saveGraphicsState;
  $.NSGraphicsContext.setCurrentContext(context);
  $.NSColor.clearColor.set;
  $.NSRectFillUsingOperation($.NSMakeRect(0, 0, 32, 48), $.NSCompositingOperationCopy);
  $(character).drawAtPointWithAttributes($.NSMakePoint(0, 0), attrs);
  context.flushGraphics;
  $.NSGraphicsContext.restoreGraphicsState;
  var pixels = [], left = 32, top = 48, right = -1, bottom = -1;
  for (var y = 0; y < 48; y++) for (var x = 0; x < 32; x++) {
    var alpha = Math.round(Number(rep.colorAtXY(x, y).alphaComponent) * 255);
    pixels.push(alpha);
    if (alpha > 0) { left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y); }
  }
  var cropped = [];
  for (var row = top; row <= bottom; row++) for (var column = left; column <= right; column++) cropped.push(pixels[row * 32 + column]);
  glyphs[character] = { width: right - left + 1, height: bottom - top + 1, left: left, top: top,
    advance: Number($(character).sizeWithAttributes(attrs).width), alpha: cropped };
}
JSON.stringify({ scale: 4, glyphs: glyphs });
`;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function parseGlyph(value: unknown): MenuBarGlyph {
  const glyph = record(value);
  if (!glyph || !integer(glyph.width, 1, CANVAS_WIDTH) || !integer(glyph.height, 1, CANVAS_HEIGHT)
    || !integer(glyph.left, 0, CANVAS_WIDTH - glyph.width) || !integer(glyph.top, 0, CANVAS_HEIGHT - glyph.height)
    || typeof glyph.advance !== 'number' || !Number.isFinite(glyph.advance) || glyph.advance <= 0 || glyph.advance > CANVAS_WIDTH
    || !Array.isArray(glyph.alpha) || glyph.alpha.length !== glyph.width * glyph.height
    || !glyph.alpha.every(alpha => integer(alpha, 0, 255)) || !glyph.alpha.some(alpha => alpha > 0)) {
    throw new Error('macOS returned an invalid menu bar font glyph.');
  }
  return { width: glyph.width, height: glyph.height, left: glyph.left, top: glyph.top,
    advance: glyph.advance, alpha: [...glyph.alpha] };
}

export function parseMenuBarFont(value: unknown): MenuBarFont {
  const font = record(value);
  const glyphs = record(font?.glyphs);
  if (font?.scale !== 4 || !glyphs || Object.keys(glyphs).length !== CHARACTERS.length
    || ![...CHARACTERS].every(character => Object.hasOwn(glyphs, character))) {
    throw new Error('macOS returned an invalid menu bar font atlas.');
  }
  return { scale: 4, glyphs: Object.fromEntries([...CHARACTERS].map(character => [character, parseGlyph(glyphs[character])])) };
}

const execute = promisify(execFile);
let pendingFont: Promise<MenuBarFont> | null = null;

/** Read the system's medium monospaced digits once, without creating an application window. */
export function loadMenuBarFont(): Promise<MenuBarFont> {
  pendingFont ??= execute('/usr/bin/osascript', ['-l', 'JavaScript', '-e', SCRIPT], {
    encoding: 'utf8', timeout: 5_000, maxBuffer: 256 * 1024,
  }).then(({ stdout }) => parseMenuBarFont(JSON.parse(stdout)));
  return pendingFont;
}
