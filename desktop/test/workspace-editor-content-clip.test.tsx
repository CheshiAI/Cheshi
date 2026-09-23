import { expect, mock, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import { Compartment, EditorState } from '@codemirror/state';
import { Direction, drawSelection, EditorView, lineNumbers } from '@codemirror/view';
import { workspaceEditorContentClip } from '../frontend/src/features/editor/workspaceEditorContentClip';

interface RecordedAnimation {
  target: HTMLElement;
  frames: Keyframe[];
  cancel: ReturnType<typeof mock<() => void>>;
}

// Test the real CodeMirror lifecycle and DOM. Geometry and native animations
// need doubles here; actual painting and scrolling require rendered UI review.
test.each([
  { native: true, rtl: false, scale: 1 },
  { native: true, rtl: true, scale: 1 },
  { native: true, rtl: false, scale: 1.5 },
  { native: false, rtl: false, scale: 1 },
])('uses fixed viewports in both axes (native=$native, rtl=$rtl, scale=$scale)', async ({ native, rtl, scale }) => {
  const window = new Window();
  const previousAnimate = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, 'animate');
  const animations: RecordedAnimation[] = [];
  const timelineOptions: Array<{ source: HTMLElement; axis: string }> = [];
  if (native) {
    Object.defineProperty(window, 'ScrollTimeline', { value: class {
      constructor(options: { source: HTMLElement; axis: string }) { timelineOptions.push(options); }
    } });
    Object.defineProperty(window.HTMLElement.prototype, 'animate', {
      configurable: true, writable: true,
      value(this: HTMLElement, frames: Keyframe[], options: KeyframeAnimationOptions): Animation {
        expect(options).toMatchObject({ duration: 'auto', easing: 'linear', fill: 'both' });
        expect(options.timeline).toBeDefined();
        const record = { target: this, frames, cancel: mock(() => {}) };
        animations.push(record);
        return { cancel: record.cancel, effect: { setKeyframes: (next: Keyframe[]) => { record.frames = next; } } } as unknown as Animation;
      },
    });
  }
  const globals = {
    window, Window: window.Window, document: window.document, navigator: window.navigator,
    MutationObserver: window.MutationObserver,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  let view: EditorView | undefined;
  try {
    const container = window.document.createElement('div');
    window.document.body.append(container);
    const clipping = new Compartment();
    const drawing = new Compartment();
    const numbers = new Compartment();
    const click = mock(() => true);
    view = new EditorView({ parent: container as unknown as HTMLElement,
      state: EditorState.create({ doc: 'one\ntwo\nthree', extensions: [
        numbers.of(lineNumbers({ domEventHandlers: { click } })), drawing.of(drawSelection()), clipping.of(workspaceEditorContentClip),
      ] }),
    });
    const editor = view;
    const source = editor.scrollDOM.querySelector<HTMLElement>('.cm-gutters')!;
    source.style.borderLeft = rtl ? '1px solid rgb(40, 50, 60)' : '0px none transparent';
    source.style.borderRight = rtl ? '0px none transparent' : '1px solid rgb(40, 50, 60)';
    const layers = [...editor.scrollDOM.querySelectorAll<HTMLElement>('.cm-layer')];
    let x = rtl ? -120 : 120, y = 80, width = 500, height = 300, gutterWidth = 56, scrollHeight = 1800;
    let gutterHeight = 1800;
    const rect = (left: number, top: number, w: number, h: number) => ({
      x: left, y: top, left, top, right: left + w, bottom: top + h, width: w, height: h, toJSON: () => ({}),
    });
    Object.defineProperties(editor, {
      scaleX: { configurable: true, get: () => scale }, scaleY: { configurable: true, get: () => scale },
      textDirection: { configurable: true, get: () => rtl ? Direction.RTL : Direction.LTR },
    });
    Object.defineProperties(editor.scrollDOM, {
      clientLeft: { configurable: true, value: 0 }, clientTop: { configurable: true, value: 0 },
      clientWidth: { configurable: true, get: () => width }, clientHeight: { configurable: true, get: () => height },
      scrollWidth: { configurable: true, value: 1600 }, scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollLeft: { configurable: true, get: () => x, set: (value: number) => { x = value; } },
      scrollTop: { configurable: true, get: () => y, set: (value: number) => { y = value; } },
    });
    const scrollerBounds = spyOn(editor.scrollDOM, 'getBoundingClientRect').mockImplementation(() => rect(20, 30, width * scale, height * scale));
    spyOn(editor.dom, 'getBoundingClientRect').mockImplementation(() => rect(20, 10, width * scale, height * scale + 20));
    spyOn(source, 'getBoundingClientRect').mockImplementation(() => rect(
      20 + (rtl ? width - gutterWidth : 0) * scale, 30 + (1 - y) * scale, gutterWidth * scale, gutterHeight * scale,
    ));
    const contentBounds = spyOn(editor.contentDOM, 'getBoundingClientRect');
    const pending: Array<() => void> = [];
    const measure = spyOn(editor, 'requestMeasure').mockImplementation(request => {
      if (request) pending.push(() => { const result = request.read(editor); request.write?.(result, editor); });
    });
    function flush() { pending.splice(0).forEach(run => run()); }
    function layout() { editor.dispatch({ effects: clipping.reconfigure(workspaceEditorContentClip) }); flush(); }
    function scroll() { editor.scrollDOM.dispatchEvent(new window.Event('scroll') as unknown as Event); }
    function viewport() { return editor.dom.querySelector<HTMLElement>(':scope > .cm-fixed-gutter-viewport')!; }
    layout();
    expect(viewport().style.overflow).toBe('clip');
    expect(viewport().getAttribute('aria-hidden')).toBe('true');
    expect(viewport().style.width).toBe('56px');
    expect(viewport().style.height).toBe('300px');
    const border = viewport().querySelector<HTMLElement>('.cm-fixed-gutter-border')!;
    expect(border.parentElement).toBe(viewport());
    expect(border.style.borderLeft).toBe(source.style.borderLeft);
    expect(border.style.borderRight).toBe(source.style.borderRight);
    expect(border.style.pointerEvents).toBe('none');
    expect(viewport().querySelector<HTMLElement>('.cm-gutters')!.style.borderColor).toBe('transparent');
    expect(Number.parseFloat(viewport().style.top)).toBeCloseTo(20 / scale);
    expect(source.parentElement).toBe(editor.scrollDOM);
    expect(editor.contentDOM.parentElement).toBe(editor.scrollDOM);
    expect(layers.every(layer => layer.parentElement === editor.scrollDOM)).toBe(true);
    expect(timelineOptions).toEqual(native ? [{ source: editor.scrollDOM, axis: 'y' }] : []);
    const fixedClip = editor.scrollDOM.style.clipPath;
    const fixedViewport = viewport().style.cssText;
    const fixedBorder = border.style.cssText;
    if (native) expect(animations[0]!.frames).toEqual([
      { transform: 'translateY(1px)' }, { transform: 'translateY(-1499px)' },
    ]);
    // No clipping styles or measurements are driven by scroll events, whether
    // the input is horizontal, vertical, diagonal, or a rapid reversal.
    measure.mockClear(); scrollerBounds.mockClear(); contentBounds.mockClear();
    for (const [nextX, nextY] of [[950, 0], [950, 900], [0, 1490], [700, 240], [0, 0]]) {
      x = rtl ? -nextX! : nextX!; y = nextY!;
      scroll();
      expect(editor.scrollDOM.style.clipPath).toBe(fixedClip);
      expect(viewport().style.cssText).toBe(fixedViewport);
      expect(border.style.cssText).toBe(fixedBorder);
      expect(editor.contentDOM.style.clipPath).toBe('');
      expect(layers.every(layer => layer.style.clipPath === '')).toBe(true);
      expect(measure).not.toHaveBeenCalled();
      expect(scrollerBounds).not.toHaveBeenCalled();
      expect(contentBounds).not.toHaveBeenCalled();
      if (!native) expect((viewport().firstElementChild as HTMLElement).style.transform).toBe(`translateY(${1 - y}px)`);
    }
    // Updating geometry while scrolled changes fixed dimensions, never origins
    // derived from scroll position. The native gutter animation is retained.
    x = rtl ? -300 : 300; y = 600;
    gutterWidth = 72; width = 320; height = 240;
    layout();
    expect(viewport().style.width).toBe('72px');
    expect(viewport().style.height).toBe('240px');
    expect(viewport().style.left).toBe(rtl ? '248px' : '0px');
    if (native) {
      expect(animations).toHaveLength(1);
      expect(animations[0]!.frames[1]).toEqual({ transform: 'translateY(-1559px)' });
    }
    // Mirror changes to line numbers/markers without replacing the scroll layer.
    const visibleGutter = viewport().querySelector('.cm-gutters')!;
    editor.dispatch({ changes: { from: 0, insert: 'new\n' } });
    flush();
    await window.happyDOM.waitUntilComplete();
    expect(viewport().querySelector('.cm-gutters')).toBe(visibleGutter);
    expect(visibleGutter.textContent).toBe(source.textContent);
    const copiedRow = viewport().querySelector('.cm-lineNumbers .cm-gutterElement:last-child')!;
    const clickEvent = new window.MouseEvent('click', { bubbles: true, cancelable: true, clientY: 45 });
    copiedRow.dispatchEvent(clickEvent as unknown as Event);
    expect(click).toHaveBeenCalledTimes(1);
    expect(clickEvent.defaultPrevented).toBe(true);
    const hover = mock(() => {});
    const marker = window.document.createElement('span');
    marker.onmouseover = hover;
    source.lastElementChild!.lastElementChild!.appendChild(marker as unknown as Node);
    await window.happyDOM.waitUntilComplete();
    viewport().querySelector('span')!.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }) as unknown as Event);
    expect(hover).toHaveBeenCalledTimes(1);
    const scrollBy = spyOn(editor.scrollDOM, 'scrollBy').mockImplementation(() => {});
    viewport().dispatchEvent(new window.WheelEvent('wheel', { deltaX: 120, deltaY: 280, cancelable: true }) as unknown as Event);
    expect(scrollBy).toHaveBeenCalledWith({ left: 120, top: 280, behavior: 'instant' });
    // Cursor/selection layers can be replaced without needing new clip paths.
    editor.dispatch({ effects: drawing.reconfigure([]) }); flush();
    editor.dispatch({ effects: drawing.reconfigure(drawSelection()) }); flush();
    expect([...editor.scrollDOM.querySelectorAll<HTMLElement>('.cm-layer')].every(layer => !layer.style.clipPath)).toBe(true);
    // A short document must not shorten the fixed border. The source gutter
    // and its mirror retain their document height; the border spans the viewport.
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: 'short' } });
    gutterHeight = 64; scrollHeight = height; y = 0;
    source.style.height = '64px';
    source.style.minHeight = '64px';
    layout();
    await window.happyDOM.waitUntilComplete();
    if (native) expect(animations[0]!.cancel).toHaveBeenCalledTimes(1);
    expect((viewport().firstElementChild as HTMLElement).style.transform).toBe('translateY(1px)');
    expect(viewport().querySelector<HTMLElement>('.cm-gutters')!.style.height).toBe('64px');
    expect(viewport().style.height).toBe('240px');
    expect(border.style.position).toBe('absolute');
    expect(border.style.inset).toBe('0');
    expect(border.style.height).toBe('auto');
    expect(border.style.minHeight).toBe('0');
    expect(border.style.borderLeft).toBe(source.style.borderLeft);
    expect(border.style.borderRight).toBe(source.style.borderRight);
    height = 480; scrollHeight = height; layout();
    expect(viewport().style.height).toBe('480px');
    expect(border.style.inset).toBe('0');
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: '' } }); flush();
    expect(viewport().style.height).toBe('480px');
    expect(border.parentElement).toBe(viewport());
    editor.dispatch({ effects: numbers.reconfigure([]) }); flush();
    expect(viewport()).toBeNull();
    expect(editor.scrollDOM.style.clipPath).toBe('');
    editor.dispatch({ effects: numbers.reconfigure(lineNumbers()) }); flush();
    expect(viewport()).not.toBeNull();
    editor.dispatch({ effects: clipping.reconfigure([]) }); flush();
    expect(viewport()).toBeNull();
    expect(editor.scrollDOM.style.clipPath).toBe('');
    measure.mockRestore(); scrollBy.mockRestore();
  } finally {
    view?.destroy();
    if (previousAnimate) Object.defineProperty(window.HTMLElement.prototype, 'animate', previousAnimate);
    else Reflect.deleteProperty(window.HTMLElement.prototype, 'animate');
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
