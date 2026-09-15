export interface DragSelection {
  text: string;
  identity: readonly unknown[];
}

export type SelectionReader = (target: Element) => DragSelection | null;

function sameSelection(a: DragSelection | null, b: DragSelection | null): boolean {
  return a === b || (!!a && !!b && a.text === b.text && a.identity.length === b.identity.length
    && a.identity.every((value, index) => value === b.identity[index]));
}

export function readDomSelection(target: Element): DragSelection | null {
  const input = target.closest('input, textarea') as HTMLInputElement | HTMLTextAreaElement | null;
  if (input) {
    if (input.tagName === 'INPUT' && (input as HTMLInputElement).type === 'password') return null;
    const { selectionStart: start, selectionEnd: end } = input;
    if (start === null || end === null) {
      // Chromium exposes selection text for controls such as number/email through Selection,
      // even though those controls do not support selectionStart/selectionEnd.
      const selected = input.ownerDocument.getSelection();
      if (input.ownerDocument.activeElement !== input || !selected?.toString().length) return null;
      return { text: selected.toString(), identity: [input, selected.anchorOffset, selected.focusOffset] };
    }
    if (start === end) return null;
    return { text: input.value.slice(start, end), identity: [input, start, end] };
  }
  const selected = target.ownerDocument.getSelection();
  if (!selected || selected.isCollapsed || !selected.anchorNode || !selected.focusNode) return null;
  // Ignore an old selection in another part of the page.
  if (!target.contains(selected.anchorNode) && !target.contains(selected.focusNode)
    && !selected.containsNode(target, true)) return null;
  return { text: selected.toString(), identity: [selected.anchorNode, selected.anchorOffset, selected.focusNode, selected.focusOffset] };
}

/** Observe gestures without consuming input or changing the selection. */
export function installDragCopy(document: Document, write: (text: string) => Promise<unknown> | void,
  read: SelectionReader = readDomSelection): () => void {
  const view = document.defaultView;
  if (!view) return () => {};
  let gesture: { target: Element; id: number; x: number; y: number; moved: boolean;
    before: DragSelection | null; changed: boolean; selecting: boolean } | null = null;
  let pending: number | undefined;
  const cancel = () => { gesture = null; if (pending !== undefined) view.clearTimeout(pending); pending = undefined; };
  const observe = () => {
    if (gesture && !sameSelection(gesture.before, read(gesture.target))) gesture.changed = true;
  };
  const down = (event: PointerEvent) => {
    cancel();
    if (!event.isTrusted || event.button !== 0 || event.pointerType !== 'mouse') return;
    const target = event.composedPath().find(node => node instanceof view.Element) as Element | undefined;
    if (!target || target.closest('button, [role="button"], [role="separator"], [role="slider"], select, input[type="password"]')) return;
    gesture = { target, id: event.pointerId, x: event.clientX, y: event.clientY,
      moved: false, changed: false, selecting: false, before: read(target) };
  };
  const move = (event: PointerEvent) => {
    if (!gesture || gesture.id !== event.pointerId || !event.isTrusted) return;
    if (!(event.buttons & 1)) { cancel(); return; }
    if (event.clientX !== gesture.x || event.clientY !== gesture.y) gesture.moved = true;
    observe();
  };
  const select = (event: Event) => { if (gesture && event.isTrusted) gesture.selecting = true; };
  const up = (event: PointerEvent) => {
    if (!gesture || gesture.id !== event.pointerId || !event.isTrusted || event.button !== 0) return;
    const finished = gesture;
    if (event.clientX !== finished.x || event.clientY !== finished.y) finished.moved = true;
    // Let native controls and editor mouseup handlers finish updating selection first.
    pending = view.setTimeout(() => {
      pending = undefined;
      if (gesture !== finished) return;
      observe();
      gesture = null;
      const selected = read(finished.target);
      if (!finished.moved || (!finished.changed && !finished.selecting) || !selected?.text.length) return;
      try { void Promise.resolve(write(selected.text)).catch(() => {}); } catch { /* Preserve input on clipboard failure. */ }
    }, 0);
  };
  document.addEventListener('pointerdown', down, true);
  document.addEventListener('pointermove', move, true);
  document.addEventListener('pointerup', up, true);
  document.addEventListener('selectionchange', observe, true);
  document.addEventListener('selectstart', select, true);
  document.addEventListener('select', select, true);
  document.addEventListener('pointercancel', cancel, true);
  document.addEventListener('dragstart', cancel, true);
  document.addEventListener('copy', cancel, true);
  document.addEventListener('cut', cancel, true);
  document.addEventListener('keydown', cancel, true);
  view.addEventListener('blur', cancel);
  return () => {
    cancel();
    document.removeEventListener('pointerdown', down, true);
    document.removeEventListener('pointermove', move, true);
    document.removeEventListener('pointerup', up, true);
    document.removeEventListener('selectionchange', observe, true);
    document.removeEventListener('selectstart', select, true);
    document.removeEventListener('select', select, true);
    document.removeEventListener('pointercancel', cancel, true);
    document.removeEventListener('dragstart', cancel, true);
    document.removeEventListener('copy', cancel, true);
    document.removeEventListener('cut', cancel, true);
    document.removeEventListener('keydown', cancel, true);
    view.removeEventListener('blur', cancel);
  };
}
