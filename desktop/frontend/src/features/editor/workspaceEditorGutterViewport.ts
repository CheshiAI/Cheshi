import type { EditorView } from '@codemirror/view';

interface ScrollTimelineConstructor {
  new(options: { source: HTMLElement; axis: 'y' }): AnimationTimeline;
}

interface GutterLayout {
  left: number;
  top: number;
  width: number;
  height: number;
  originY: number;
}

const mouseEvents = ['mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'mouseover', 'mouseout', 'mousemove'] as const;

// Mirror the existing gutter instead of reparenting CodeMirror-owned nodes.
// Its markers and event handlers remain authoritative (including lint hover).
export class WorkspaceEditorGutterViewport {
  private readonly view: EditorView;
  private readonly source: HTMLElement;
  private readonly viewport: HTMLElement;
  private readonly content: HTMLElement;
  private readonly mirror: HTMLElement;
  private readonly border: HTMLElement;
  private readonly sourceNodes = new WeakMap<Node, Node>();
  private readonly observer: MutationObserver;
  private readonly timeline: AnimationTimeline | null;
  private animation: Animation | null = null;
  private originY = 0;
  private scrollRange = 0;
  private readonly onScroll = () => {
    this.content.style.transform = `translateY(${this.originY - this.view.scrollDOM.scrollTop}px)`;
  };
  private readonly onMouse = (event: MouseEvent) => {
    const target = this.sourceNodes.get(event.target as Node);
    const window = this.source.ownerDocument.defaultView!;
    if (!target) return;
    const forwarded = new window.MouseEvent(event.type, {
      bubbles: event.bubbles, cancelable: event.cancelable, composed: event.composed,
      clientX: event.clientX, clientY: event.clientY, screenX: event.screenX, screenY: event.screenY,
      button: event.button, buttons: event.buttons, detail: event.detail,
      ctrlKey: event.ctrlKey, shiftKey: event.shiftKey, altKey: event.altKey, metaKey: event.metaKey,
      relatedTarget: this.sourceNodes.get(event.relatedTarget as Node) ?? event.relatedTarget,
      view: window,
    });
    if (!target.dispatchEvent(forwarded)) event.preventDefault();
    event.stopPropagation();
  };
  private readonly onWheel = (event: WheelEvent) => {
    if (event.ctrlKey) return;
    const scroller = this.view.scrollDOM;
    const lineHeight = this.view.defaultLineHeight / this.view.scaleY;
    const unitX = event.deltaMode === 2 ? scroller.clientWidth : event.deltaMode === 1 ? lineHeight : 1;
    const unitY = event.deltaMode === 2 ? scroller.clientHeight : event.deltaMode === 1 ? lineHeight : 1;
    const horizontal = event.shiftKey && !event.deltaX;
    scroller.scrollBy({ left: horizontal ? event.deltaY * unitX : event.deltaX * unitX,
      top: horizontal ? 0 : event.deltaY * unitY, behavior: 'instant' });
    event.preventDefault();
  };

  constructor(view: EditorView, source: HTMLElement) {
    this.view = view;
    this.source = source;
    const document = source.ownerDocument;
    const window = document.defaultView as (Window & typeof globalThis & { ScrollTimeline?: ScrollTimelineConstructor });
    this.viewport = document.createElement('div');
    this.viewport.className = 'cm-fixed-gutter-viewport';
    this.viewport.setAttribute('aria-hidden', 'true');
    this.viewport.style.cssText = 'position:absolute;overflow:clip;contain:paint;z-index:1;';
    this.content = document.createElement('div');
    this.content.style.cssText = 'position:absolute;left:0;top:0;width:100%;will-change:transform;';
    this.mirror = source.cloneNode(false) as HTMLElement;
    this.border = document.createElement('div');
    this.content.append(this.mirror);
    this.viewport.append(this.content, this.border);
    view.dom.append(this.viewport);
    this.sync();
    this.observer = new window.MutationObserver(() => this.sync());
    this.observer.observe(source, { subtree: true, childList: true, characterData: true, attributes: true });
    this.timeline = window.ScrollTimeline && typeof this.content.animate === 'function'
      ? new window.ScrollTimeline({ source: view.scrollDOM, axis: 'y' }) : null;
    if (!this.timeline) view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true });
    for (const type of mouseEvents) this.viewport.addEventListener(type, this.onMouse);
    this.viewport.addEventListener('wheel', this.onWheel, { passive: false });
  }

  private syncNode(source: Node, mirror: Node): void {
    this.sourceNodes.set(mirror, source);
    if (source.nodeType === 1 && mirror.nodeType === 1) {
      const original = source as Element;
      const copy = mirror as Element;
      for (const { name } of [...copy.attributes]) if (!original.hasAttribute(name) || name === 'id') copy.removeAttribute(name);
      for (const { name, value } of [...original.attributes]) {
        if (name !== 'id' && copy.getAttribute(name) !== value) copy.setAttribute(name, value);
      }
    } else if (mirror.nodeValue !== source.nodeValue) mirror.nodeValue = source.nodeValue;
    const children = [...source.childNodes];
    for (let index = 0; index < children.length; index++) {
      const child = children[index]!;
      let copy: Node | undefined = mirror.childNodes[index];
      if (!copy || copy.nodeType !== child.nodeType || copy.nodeName !== child.nodeName) {
        const replacement = child.cloneNode(false);
        if (copy) mirror.replaceChild(replacement, copy);
        else mirror.appendChild(replacement);
        copy = replacement;
      }
      this.syncNode(child, copy);
    }
    while (mirror.childNodes.length > children.length) mirror.removeChild(mirror.lastChild!);
  }

  private sync(): void {
    this.syncNode(this.source, this.mirror);
    // Retain the gutter's theme/marker styles, but not its sticky positioning.
    Object.assign(this.mirror.style, {
      position: 'relative', inset: 'auto', width: '100%', borderColor: 'transparent',
    });
    // Paint the themed border on the fixed viewport, not the moving document.
    // Keep the mirror's border width so line numbers and markers do not shift.
    this.border.className = `${this.source.className} cm-fixed-gutter-border`;
    this.border.style.cssText = this.source.style.cssText;
    Object.assign(this.border.style, {
      position: 'absolute', inset: '0', width: 'auto', height: 'auto', minHeight: '0',
      boxSizing: 'border-box', background: 'transparent', pointerEvents: 'none', zIndex: '1',
    });
  }

  layout(bounds: GutterLayout, scrollRange: number, font: string): void {
    Object.assign(this.viewport.style, {
      left: `${bounds.left}px`, top: `${bounds.top}px`, width: `${bounds.width}px`, height: `${bounds.height}px`, font,
    });
    if (this.animation && this.originY === bounds.originY && this.scrollRange === scrollRange) return;
    this.originY = bounds.originY;
    this.scrollRange = scrollRange;
    const frames = [{ transform: `translateY(${bounds.originY}px)` },
      { transform: `translateY(${bounds.originY - scrollRange}px)` }];
    if (!this.timeline) this.onScroll();
    else if (!scrollRange) {
      this.animation?.cancel();
      this.animation = null;
      this.content.style.transform = frames[0]!.transform;
    } else if (this.animation) {
      (this.animation.effect as KeyframeEffect).setKeyframes(frames);
    } else {
      this.content.style.transform = frames[0]!.transform;
      this.animation = this.content.animate(frames, {
        timeline: this.timeline, duration: 'auto', easing: 'linear', fill: 'both',
      });
    }
  }

  destroy(): void {
    this.observer.disconnect();
    this.animation?.cancel();
    this.view.scrollDOM.removeEventListener('scroll', this.onScroll);
    this.viewport.remove();
  }
}
