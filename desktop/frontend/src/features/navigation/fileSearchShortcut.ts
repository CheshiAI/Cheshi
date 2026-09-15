export function isFileSearchShortcut(event: Pick<KeyboardEvent,
  'code' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey' | 'repeat' | 'isComposing' | 'keyCode' | 'defaultPrevented'>): boolean {
  return event.code === 'KeyF' && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey
    && !event.repeat && !event.isComposing && event.keyCode !== 229 && !event.defaultPrevented;
}

export function installFileSearchShortcut(document: Document, open: () => void): () => void {
  const handle = (event: KeyboardEvent) => {
    if (!isFileSearchShortcut(event) || document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) return;
    const elements = [...event.composedPath(), document.activeElement];
    if (elements.some(node => node instanceof Element && (
      (node instanceof HTMLElement && node.isContentEditable)
      || node.closest('input, textarea, select, [role="textbox"], .cm-editor, .terminal-host')
    ))) return;
    event.preventDefault();
    event.stopPropagation();
    open();
  };
  document.addEventListener('keydown', handle);
  return () => document.removeEventListener('keydown', handle);
}
