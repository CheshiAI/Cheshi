export interface CanvasRectangle { x: number; y: number; width: number; height: number }
export interface CanvasEditorLayout { editor: CanvasRectangle; layers: CanvasRectangle | null }

function isRectangle(value: unknown): value is CanvasRectangle {
  if (!value || typeof value !== 'object') return false;
  const rect = value as CanvasRectangle;
  return [rect.x, rect.y, rect.width, rect.height].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)
    && rect.width > 0 && rect.height > 0;
}

export function isCanvasEditorLayout(value: unknown): value is CanvasEditorLayout {
  if (!value || typeof value !== 'object') return false;
  const layout = value as CanvasEditorLayout;
  return isRectangle(layout.editor) && (layout.layers === null || isRectangle(layout.layers));
}

export function isCanvasOverlayList(value: unknown): value is CanvasRectangle[] {
  return Array.isArray(value) && value.length <= 100 && value.every(isRectangle);
}

export function canvasClipPath(layout: CanvasEditorLayout, overlays: readonly CanvasRectangle[] = []) {
  const path = [layout.editor, layout.layers, ...overlays].filter((rect): rect is CanvasRectangle => rect !== null)
    .map(rect => `M ${rect.x} ${rect.y} h ${rect.width} v ${rect.height} h ${-rect.width} Z`).join(' ');
  return `path('${path}')`;
}

/** Keep both editor surfaces in one document so menus, dragging and shortcuts share their original context. */
export function canvasDockGeometry(editor: CanvasRectangle, layers: CanvasRectangle | null) {
  const x = Math.min(editor.x, layers?.x ?? editor.x);
  const y = Math.min(editor.y, layers?.y ?? editor.y);
  const width = Math.max(editor.x + editor.width, layers ? layers.x + layers.width : 0) - x;
  const height = Math.max(editor.y + editor.height, layers ? layers.y + layers.height : 0) - y;
  const relative = (rect: CanvasRectangle): CanvasRectangle => ({ x: rect.x - x, y: rect.y - y, width: rect.width, height: rect.height });
  const layout: CanvasEditorLayout = { editor: relative(editor), layers: layers ? relative(layers) : null };
  return { x, y, width, height, layout, clipPath: canvasClipPath(layout) };
}
