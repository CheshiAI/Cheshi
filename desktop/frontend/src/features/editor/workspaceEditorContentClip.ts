import { Direction, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { WorkspaceEditorGutterViewport } from './workspaceEditorGutterViewport';

interface GutterGeometry {
  source: HTMLElement;
  left: number;
  top: number;
  width: number;
  height: number;
  originY: number;
}

interface ViewportGeometry {
  clip: string;
  gutters: GutterGeometry[];
  scrollRange: number;
  font: string;
}

// Keep CodeMirror's editing DOM, scroll coordinates and gutter handlers intact.
// Clip its SCROLLER at a fixed boundary, rather than animating clips on moving
// content/cursor/selection layers. Gutters have separate, fixed viewports.
export const workspaceEditorContentClip = ViewPlugin.fromClass(class {
  private readonly view: EditorView;
  private readonly originalClip: string;
  private readonly gutters = new Map<HTMLElement, WorkspaceEditorGutterViewport>();
  private readonly resizeObserver: ResizeObserver | null;
  private readonly observed = new Set<Element>();
  private destroyed = false;
  private readonly measurement = {
    read: () => this.measure(),
    write: (geometry: ViewportGeometry) => this.apply(geometry),
  };
  private readonly schedule = () => {
    if (!this.destroyed) this.view.requestMeasure(this.measurement);
  };

  constructor(view: EditorView) {
    this.view = view;
    this.originalClip = view.scrollDOM.style.clipPath;
    this.resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(this.schedule);
    this.schedule();
  }

  update(update: ViewUpdate): void {
    if (update.geometryChanged || update.docChanged
      || update.transactions.some(transaction => transaction.reconfigured)) this.schedule();
  }

  private measure(): ViewportGeometry {
    const { view } = this;
    const { scrollDOM, scaleX, scaleY } = view;
    const rect = scrollDOM.getBoundingClientRect();
    const editor = view.dom.getBoundingClientRect();
    const viewportLeft = scrollDOM.clientLeft;
    const viewportRight = viewportLeft + scrollDOM.clientWidth;
    const viewportBottom = scrollDOM.clientTop + scrollDOM.clientHeight;
    let left = viewportLeft;
    let right = viewportRight;
    const gutters = [...scrollDOM.querySelectorAll<HTMLElement>(':scope > .cm-gutters')].map(source => {
      const bounds = source.getBoundingClientRect();
      const onRight = source.classList.contains('cm-gutters-after') !== (view.textDirection === Direction.RTL);
      if (onRight) right = Math.min(right, (bounds.left - rect.left) / scaleX);
      else left = Math.max(left, (bounds.right - rect.left) / scaleX);
      return {
        source,
        left: (bounds.left - editor.left) / scaleX - view.dom.clientLeft,
        top: (rect.top - editor.top) / scaleY + scrollDOM.clientTop - view.dom.clientTop,
        width: bounds.width / scaleX,
        height: scrollDOM.clientHeight,
        originY: (bounds.top - rect.top) / scaleY - scrollDOM.clientTop + scrollDOM.scrollTop,
      };
    });
    left = Math.min(viewportRight, Math.max(viewportLeft, left));
    right = Math.max(left, Math.min(viewportRight, right));
    // Bottom and outer side strips retain native scrollbars, including classic
    // scrollbars and a left-side scrollbar in RTL layouts.
    const clip = `polygon(0 0, ${viewportLeft}px 0, ${viewportLeft}px ${viewportBottom}px, `
      + `${left}px ${viewportBottom}px, ${left}px 0, ${right}px 0, ${right}px ${viewportBottom}px, `
      + `${viewportRight}px ${viewportBottom}px, ${viewportRight}px 0, 100% 0, 100% 100%, 0 100%)`;
    return {
      clip: gutters.length ? clip : this.originalClip,
      gutters,
      scrollRange: Math.max(0, scrollDOM.scrollHeight - scrollDOM.clientHeight),
      font: view.dom.ownerDocument.defaultView!.getComputedStyle(scrollDOM).font,
    };
  }

  private apply(geometry: ViewportGeometry): void {
    if (this.destroyed) return;
    const current = new Set(geometry.gutters.map(gutter => gutter.source));
    for (const [source, viewport] of this.gutters) {
      if (current.has(source)) continue;
      viewport.destroy();
      this.gutters.delete(source);
    }
    for (const gutter of geometry.gutters) {
      let viewport = this.gutters.get(gutter.source);
      if (!viewport) {
        viewport = new WorkspaceEditorGutterViewport(this.view, gutter.source);
        this.gutters.set(gutter.source, viewport);
      }
      viewport.layout(gutter, geometry.scrollRange, geometry.font);
    }
    if (this.view.scrollDOM.style.clipPath !== geometry.clip) this.view.scrollDOM.style.clipPath = geometry.clip;
    const observed = new Set<Element>([this.view.dom, this.view.scrollDOM, this.view.contentDOM, ...current]);
    for (const element of this.observed) if (!observed.has(element)) this.resizeObserver?.unobserve(element);
    for (const element of observed) if (!this.observed.has(element)) this.resizeObserver?.observe(element);
    this.observed.clear();
    for (const element of observed) this.observed.add(element);
  }

  destroy(): void {
    this.destroyed = true;
    this.resizeObserver?.disconnect();
    for (const viewport of this.gutters.values()) viewport.destroy();
    this.gutters.clear();
    this.observed.clear();
    this.view.scrollDOM.style.clipPath = this.originalClip;
  }
});
