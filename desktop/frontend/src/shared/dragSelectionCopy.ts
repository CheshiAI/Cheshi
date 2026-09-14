export interface SelectionCopySnapshot {
  text: string;
  anchor: object | null;
  focus: object | null;
  ranges: string;
}

interface DragSelectionCopyOptions {
  readSelection: (origin: EventTarget | null) => SelectionCopySnapshot | null;
  writeText: (text: string) => Promise<void>;
  onError?: (error: unknown) => void;
}

function sameSelection(left: SelectionCopySnapshot | null, right: SelectionCopySnapshot | null): boolean {
  return left === right || (left !== null && right !== null && left.text === right.text
    && left.anchor === right.anchor && left.focus === right.focus && left.ranges === right.ranges);
}

export function installDragSelectionCopy(document: Document, options: DragSelectionCopyOptions): () => void {
  let gesture: {
    id: number; x: number; y: number; origin: EventTarget | null;
    initial: SelectionCopySnapshot | null; moved: boolean; changed: boolean;
  } | null = null;
  let disposed = false;
  let writes = Promise.resolve();
  const cancel = (): void => { gesture = null; };
  const start = (event: PointerEvent): void => {
    cancel();
    if (event.button !== 0 || event.pointerType !== 'mouse' || event.isPrimary === false) return;
    gesture = {
      id: event.pointerId, x: event.clientX, y: event.clientY, origin: event.target,
      initial: options.readSelection(event.target), moved: false, changed: false,
    };
  };
  const move = (event: PointerEvent): void => {
    if (!gesture || gesture.id !== event.pointerId) return;
    if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) >= 3) gesture.moved = true;
  };
  const selectionChanged = (): void => {
    if (gesture && !sameSelection(gesture.initial, options.readSelection(gesture.origin))) gesture.changed = true;
  };
  const finish = (event: PointerEvent): void => {
    if (!gesture || gesture.id !== event.pointerId) return;
    move(event);
    const completed = gesture;
    cancel();
    if (event.button !== 0 || !completed.moved) return;
    const selection = options.readSelection(completed.origin);
    if (!selection?.text || (!completed.changed && sameSelection(completed.initial, selection))) return;
    writes = writes.then(async () => {
      if (!disposed) await options.writeText(selection.text);
    }).catch((error: unknown) => { options.onError?.(error); });
  };

  document.addEventListener('pointerdown', start, true);
  document.addEventListener('pointermove', move, true);
  document.addEventListener('pointerup', finish, true);
  document.addEventListener('selectionchange', selectionChanged);
  document.addEventListener('dragstart', cancel, true);
  document.addEventListener('pointercancel', cancel, true);
  document.defaultView?.addEventListener('blur', cancel);
  return () => {
    disposed = true;
    cancel();
    document.removeEventListener('pointerdown', start, true);
    document.removeEventListener('pointermove', move, true);
    document.removeEventListener('pointerup', finish, true);
    document.removeEventListener('selectionchange', selectionChanged);
    document.removeEventListener('dragstart', cancel, true);
    document.removeEventListener('pointercancel', cancel, true);
    document.defaultView?.removeEventListener('blur', cancel);
  };
}
