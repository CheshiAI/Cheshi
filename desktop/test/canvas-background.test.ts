import { describe, expect, test } from 'bun:test';
import type { SkiaRenderer } from '@open-pencil/core/canvas';
import { RULER_SIZE } from '@open-pencil/core/constants';
import { installCanvasBackground } from '../frontend/src/features/canvas/integration/sdk/canvasBackground';

function fixture(fail = false) {
  const transparent = new Float32Array([0, 0, 0, 0]);
  const colors: unknown[] = [];
  const rectangles: { rect: number[]; paint: object }[] = [];
  const createSurface = () => {
    const canvas = {
      clear(color: unknown) { colors.push(color); },
      drawRect(rect: number[], paint: object) { rectangles.push({ rect, paint }); },
    };
    return { canvas, getCanvas() { return canvas; } };
  };
  const surface = createSurface();
  let renderedState: unknown;
  const renderer = {
    surface,
    ck: { TRANSPARENT: transparent },
    rulerBgPaint: {},
    renderFromEditorState(state: unknown) {
      renderedState = state;
      const canvas = this.surface.getCanvas();
      canvas.clear('opaque page');
      canvas.drawRect([0, 0, 800, RULER_SIZE], this.rulerBgPaint);
      canvas.drawRect([0, RULER_SIZE, RULER_SIZE, 600], this.rulerBgPaint);
      canvas.drawRect([0, 0, RULER_SIZE, RULER_SIZE], this.rulerBgPaint);
      if (fail) throw new Error('Render failed');
    },
  };
  // The test double models only the presentation boundary used by this adapter.
  const detach = installCanvasBackground(renderer as unknown as SkiaRenderer);
  return { renderer, surface, colors, rectangles, transparent, detach, createSurface, renderedState: () => renderedState };
}

describe('canvas workspace background', () => {
  test('clears only the presentation surface and leaves document state unchanged', () => {
    const h = fixture();
    const state = { pageColor: { r: 1, g: 1, b: 1, a: 1 }, panX: 12,
      rulerTheme: { background: { r: 1, g: 1, b: 1, a: 1 },
        tick: { r: 0.2, g: 0.3, b: 0.4, a: 1 }, text: { r: 0.8, g: 0.7, b: 0.6, a: 1 } } };
    const before = structuredClone(state);
    h.renderer.renderFromEditorState(state);
    expect(h.colors).toEqual([h.transparent]);
    expect(state).toEqual(before);
    expect(h.renderedState()).toEqual({ ...state, pageColor: { r: 0.03, g: 0.04, b: 0.04, a: 1 },
      rulerTheme: { ...state.rulerTheme, background: { r: 41 / 255, g: 52 / 255, b: 61 / 255, a: 0.4 } } });
    h.surface.getCanvas().clear('ordinary clear');
    expect(h.colors.at(-1)).toBe('ordinary clear');
    h.detach();
    h.renderer.renderFromEditorState(state);
    expect(h.colors.at(-1)).toBe('opaque page');
  });

  test('uses replacement surfaces after resize', () => {
    const h = fixture();
    h.renderer.surface = h.createSurface();
    h.renderer.renderFromEditorState({});
    expect(h.colors).toEqual([h.transparent]);
    h.surface.getCanvas().clear('previous surface');
    expect(h.colors.at(-1)).toBe('previous surface');
    h.detach();
  });

  test('paints the translucent ruler corner once per frame without suppressing other rectangles', () => {
    const h = fixture();
    h.renderer.renderFromEditorState({});
    h.renderer.renderFromEditorState({});
    expect(h.rectangles.map(({ rect }) => rect)).toEqual([
      [0, 0, 800, RULER_SIZE], [0, RULER_SIZE, RULER_SIZE, 600],
      [0, 0, 800, RULER_SIZE], [0, RULER_SIZE, RULER_SIZE, 600],
    ]);
    const otherPaint = {};
    h.surface.canvas.drawRect([0, 0, RULER_SIZE, RULER_SIZE], otherPaint);
    expect(h.rectangles.at(-1)?.paint).toBe(otherPaint);
    h.detach();
    h.renderer.renderFromEditorState({});
    expect(h.rectangles).toHaveLength(8);
  });

  test('restores native canvas methods even when rendering fails', () => {
    const h = fixture(true);
    const getCanvas = h.surface.getCanvas;
    const clear = h.surface.canvas.clear;
    const drawRect = h.surface.canvas.drawRect;
    const rulerPaint = h.renderer.rulerBgPaint;
    expect(() => h.renderer.renderFromEditorState({})).toThrow('Render failed');
    expect(h.surface.getCanvas).toBe(getCanvas);
    expect(h.surface.canvas.clear).toBe(clear);
    expect(h.surface.canvas.drawRect).toBe(drawRect);
    expect(h.renderer.rulerBgPaint).toBe(rulerPaint);
    h.detach();
  });
});
