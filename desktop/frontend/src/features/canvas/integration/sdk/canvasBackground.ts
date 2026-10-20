import type { SkiaRenderer } from '@open-pencil/core/canvas';
import { RULER_SIZE, RULER_TEXT_COLOR, RULER_TICK_COLOR } from '@open-pencil/core/constants';

const workspaceColor = { r: 0.03, g: 0.04, b: 0.04, a: 1 };
const rulerBackground = { r: 41 / 255, g: 52 / 255, b: 61 / 255, a: 0.4 };

/** Keep the editor surface transparent without changing document page fills. */
export function installCanvasBackground(renderer: SkiaRenderer): () => void {
  const originalRender = renderer.renderFromEditorState;
  const render: SkiaRenderer['renderFromEditorState'] = (state, ...args) => {
    const surface = renderer.surface;
    const getCanvas = surface.getCanvas;
    const canvas = getCanvas.call(surface);
    const clear = canvas.clear;
    const drawRect = canvas.drawRect;
    let cornerCovered = false;
    // OpenPencil 0.16 paints the ruler corner twice. Avoid stacking its alpha
    // while retaining the SDK's normal blending.
    canvas.drawRect = (rect, paint) => {
      if (paint === renderer.rulerBgPaint && (Array.isArray(rect) || rect instanceof Float32Array)
        && rect[0] === 0 && rect[1] === 0
        && rect[2] !== undefined && rect[2] >= RULER_SIZE && rect[3] === RULER_SIZE) {
        if (cornerCovered && rect[2] === RULER_SIZE) return;
        cornerCovered = true;
      }
      drawRect.call(canvas, rect, paint);
    };
    // OpenPencil 0.16's full pass forces an opaque page clear. Adapt only this
    // presentation canvas during that pass; offscreen effects and exports keep
    // their original clears. Resolve the surface each time, including on resize.
    surface.getCanvas = () => canvas;
    canvas.clear = () => clear.call(canvas, renderer.ck.TRANSPARENT);
    try {
      originalRender.call(renderer, {
        ...state,
        pageColor: workspaceColor,
        rulerTheme: {
          background: rulerBackground,
          tick: state.rulerTheme?.tick ?? RULER_TICK_COLOR,
          text: state.rulerTheme?.text ?? RULER_TEXT_COLOR,
        },
      }, ...args);
    } finally {
      canvas.clear = clear;
      canvas.drawRect = drawRect;
      surface.getCanvas = getCanvas;
    }
  };
  renderer.renderFromEditorState = render;
  return () => {
    if (renderer.renderFromEditorState === render) renderer.renderFromEditorState = originalRender;
  };
}
