type ShortcutEvent = Pick<KeyboardEvent,
  'code' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey' | 'repeat' | 'isComposing' | 'keyCode' | 'defaultPrevented'>;

function isShiftF(event: ShortcutEvent): boolean {
  return event.code === 'KeyF' && event.shiftKey && !event.altKey
    && !event.repeat && !event.isComposing && event.keyCode !== 229 && !event.defaultPrevented;
}

export function isFileSearchShortcut(event: ShortcutEvent): boolean {
  return isShiftF(event) && !event.ctrlKey && !event.metaKey;
}

/** Cmd+Shift+F on macOS or Ctrl+Shift+F elsewhere; the modifier keeps it distinct from plain Shift+F file search. */
export function isTextSearchShortcut(event: ShortcutEvent): boolean {
  return isShiftF(event) && Boolean(event.metaKey) !== Boolean(event.ctrlKey);
}

function installShortcut(document: Document, matches: (event: KeyboardEvent) => boolean, open: () => void,
  allowEditable: boolean): () => void {
  const handle = (event: KeyboardEvent) => {
    if (!matches(event) || document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) return;
    if (!allowEditable) {
      const elements = [...event.composedPath(), document.activeElement];
      if (elements.some(node => node instanceof Element && (
        (node instanceof HTMLElement && node.isContentEditable)
        || node.closest('input, textarea, select, [role="textbox"], .cm-editor, .terminal-host')
      ))) return;
    }
    event.preventDefault();
    event.stopPropagation();
    open();
  };
  document.addEventListener('keydown', handle);
  return () => document.removeEventListener('keydown', handle);
}

export function installFileSearchShortcut(document: Document, open: () => void): () => void {
  return installShortcut(document, isFileSearchShortcut, open, false);
}

/** Find in Files also opens while typing in inputs, editors, and terminals because the modifier makes it unambiguous. */
export function installTextSearchShortcut(document: Document, open: () => void): () => void {
  return installShortcut(document, isTextSearchShortcut, open, true);
}
