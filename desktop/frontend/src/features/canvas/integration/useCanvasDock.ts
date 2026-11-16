import { useLayoutEffect, useRef, type RefObject } from 'react';
import { canvasClipPath, canvasDockGeometry, type CanvasEditorLayout, type CanvasRectangle } from '../../../../../shared/canvas-layout';
import { connectCanvasSidebarSwipe } from './canvasSidebarSwipe';

export function useCanvasDock(frame: RefObject<HTMLIFrameElement | null>, workspace: RefObject<HTMLElement | null>,
  layers: HTMLElement | null, visible: boolean, ready: boolean, overlays: readonly CanvasRectangle[], post: (message: object) => void) {
  const layout = useRef<CanvasEditorLayout | null>(null);
  const overlayRects = useRef(overlays);
  overlayRects.current = overlays;
  useLayoutEffect(() => {
    if (!ready || !frame.current || !layers) return;
    return connectCanvasSidebarSwipe(frame.current, layers);
  }, [frame, layers, ready]);
  useLayoutEffect(() => {
    if (frame.current && layout.current) frame.current.style.clipPath = canvasClipPath(layout.current, overlays);
  }, [frame, overlays]);
  useLayoutEffect(() => {
    const iframe = frame.current;
    const editor = workspace.current;
    if (!iframe || !editor) return;
    let animation = 0;
    let lastLayout = '';
    const update = () => {
      animation = 0;
      const editorBounds = editor.getBoundingClientRect();
      const shown = visible && editorBounds.width > 0 && editorBounds.height > 0;
      iframe.style.visibility = shown ? 'visible' : 'hidden';
      if (!shown) return;
      const bounds = layers && !layers.closest('[inert], [aria-hidden="true"]') ? layers.getBoundingClientRect() : null;
      const dock = bounds && bounds.width > 0 && bounds.height > 0 ? bounds : null;
      const geometry = canvasDockGeometry(editorBounds, dock);
      layout.current = geometry.layout;
      const host = iframe.closest('.app-layout');
      const origin = host?.getBoundingClientRect();
      Object.assign(iframe.style, { position: origin ? 'absolute' : 'fixed', left: `${geometry.x - (origin?.x ?? 0)}px`, top: `${geometry.y - (origin?.y ?? 0)}px`, width: `${geometry.width}px`,
        height: `${geometry.height}px`, clipPath: canvasClipPath(geometry.layout, overlayRects.current) });
      const serialized = JSON.stringify(geometry.layout);
      if (ready && serialized !== lastLayout) {
        lastLayout = serialized;
        post({ type: 'layout', payload: geometry.layout });
      }
    };
    const schedule = () => { if (!animation) animation = requestAnimationFrame(update); };
    const resize = new ResizeObserver(schedule);
    resize.observe(editor);
    if (layers) resize.observe(layers);
    // Tab visibility and pane reparenting can move a surface without resizing it.
    const mutations = new MutationObserver(schedule);
    for (const element of [editor, layers]) {
      for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
        mutations.observe(ancestor, { attributes: true, attributeFilter: ['class', 'style', 'hidden', 'inert', 'aria-hidden'], childList: true });
      }
    }
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    update();
    return () => {
      cancelAnimationFrame(animation);
      resize.disconnect(); mutations.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
      iframe.style.visibility = 'hidden';
    };
  }, [frame, workspace, layers, visible, ready, post]);
}
