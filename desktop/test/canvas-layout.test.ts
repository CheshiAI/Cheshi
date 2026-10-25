import { expect, test } from 'bun:test';
import { canvasClipPath, canvasDockGeometry, isCanvasEditorLayout, isCanvasOverlayList } from '../shared/canvas-layout';

test('Canvas dock preserves the editor viewport while exposing only the lower sidebar', () => {
  const editor = { x: 400, y: 60, width: 800, height: 700 };
  const layers = { x: 80, y: 430, width: 319, height: 330 };
  const geometry = canvasDockGeometry(editor, layers);
  expect(geometry).toEqual({ x: 80, y: 60, width: 1120, height: 700,
    layout: { editor: { x: 320, y: 0, width: 800, height: 700 }, layers: { x: 0, y: 370, width: 319, height: 330 } },
    clipPath: "path('M 320 0 h 800 v 700 h -800 Z M 0 370 h 319 v 330 h -319 Z')" });
  expect(isCanvasEditorLayout(geometry.layout)).toBe(true);
  expect(canvasDockGeometry(editor, null).layout).toEqual({ editor: { ...editor, x: 0, y: 0 }, layers: null });
});

test('Canvas layout messages reject malformed dimensions instead of moving surfaces', () => {
  const valid = { editor: { x: 0, y: 0, width: 800, height: 600 }, layers: null };
  for (const width of [NaN, Infinity, -1, 0, '800', true, undefined]) {
    expect(isCanvasEditorLayout({ ...valid, editor: { ...valid.editor, width } })).toBe(false);
  }
  expect(isCanvasEditorLayout({ ...valid, layers: {} })).toBe(false);
  expect(isCanvasEditorLayout(null)).toBe(false);
});

test('Canvas dock reads native rectangle getters as well as plain objects', () => {
  class Bounds {
    get x() { return 400; }
    get y() { return 60; }
    get width() { return 800; }
    get height() { return 700; }
  }
  expect(canvasDockGeometry(new Bounds(), null).layout).toEqual({ editor: { x: 0, y: 0, width: 800, height: 700 }, layers: null });
});

test('Canvas popup clipping is bounded and restores the file area when menus close', () => {
  const layout = { editor: { x: 320, y: 0, width: 800, height: 700 }, layers: { x: 0, y: 500, width: 320, height: 200 } };
  const overlays = [{ x: 40, y: 350, width: 180, height: 220 }];
  expect(isCanvasOverlayList(overlays)).toBe(true);
  expect(isCanvasOverlayList([{ ...overlays[0], width: Infinity }])).toBe(false);
  expect(isCanvasOverlayList(Array.from({ length: 101 }, () => overlays[0]))).toBe(false);
  expect(canvasClipPath(layout, overlays)).toContain('M 40 350');
  expect(canvasClipPath(layout, [])).not.toContain('M 40 350');
});
