import { expect, test } from 'bun:test';
import { parseMenuBarFont } from '../lib/menu-bar-font.mts';

function atlas() {
  return { scale: 4, glyphs: Object.fromEntries([...'0123456789-'].map(character => [character,
    { width: 2, height: 2, left: 1, top: 12, advance: 20.25, alpha: [0, 64, 255, 128] }])) };
}

test('preserves system glyph placement, fractional advances and alpha while detaching input arrays', () => {
  const source = atlas();
  const parsed = parseMenuBarFont(source);
  expect(parsed.scale).toBe(4);
  expect(parsed.glyphs['9']).toEqual({ width: 2, height: 2, left: 1, top: 12, advance: 20.25, alpha: [0, 64, 255, 128] });
  source.glyphs['9']!.alpha[2] = 0;
  expect(parsed.glyphs['9']!.alpha[2]).toBe(255);
});

test('requires exactly the supported digits and dash at the expected raster scale', () => {
  for (const value of [null, [], {}, { ...atlas(), scale: 1 }, { ...atlas(), scale: '4' },
    { scale: 4, glyphs: {} }, { scale: 4, glyphs: { ...atlas().glyphs, extra: atlas().glyphs['0'] } }]) {
    expect(() => parseMenuBarFont(value)).toThrow('font atlas');
  }
  const missing = atlas();
  delete missing.glyphs['-'];
  expect(() => parseMenuBarFont(missing)).toThrow('font atlas');
});

test('rejects oversized or invalid geometry before consuming glyph pixel data', () => {
  for (const change of [{ width: 0 }, { width: 33 }, { height: 49 }, { left: -1 }, { top: -1 },
    { left: 31 }, { top: 47 }, { width: 1.5 }, { advance: Infinity }, { advance: 0 }, { advance: 33 }]) {
    const source = atlas();
    Object.assign(source.glyphs['0']!, change);
    expect(() => parseMenuBarFont(source)).toThrow('font glyph');
  }
});

test('requires a complete nonempty byte alpha mask with matching dimensions', () => {
  for (const alpha of [[255], [0, 0, 0, 0], [0, -1, 255, 0], [0, 256, 255, 0], [0, 1.5, 255, 0], [0, NaN, 255, 0]]) {
    const source = atlas();
    source.glyphs['0']!.alpha = alpha;
    expect(() => parseMenuBarFont(source)).toThrow('font glyph');
  }
});
