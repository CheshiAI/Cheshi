export function isFileSearchShortcut(event: Pick<KeyboardEvent,
  'code' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey' | 'repeat' | 'isComposing' | 'keyCode' | 'defaultPrevented'>): boolean {
  return event.code === 'KeyF' && event.shiftKey && !event.ctrlKey && event.metaKey && !event.altKey
    && !event.repeat && !event.isComposing && event.keyCode !== 229 && !event.defaultPrevented;
}

function blocksFileSearchShortcut(node: EventTarget | null | undefined): boolean {
  if (!(node instanceof Element)) return false;
  if (node.closest('input, textarea, select, .terminal-host')) return true;
  if (node.closest('.cm-editor .cm-content')) return false;
  return (node instanceof HTMLElement && node.isContentEditable)
    || node.closest('[role="textbox"]') !== null;
}

export function installFileSearchShortcut(document: Document, open: () => void): () => void {
  const handle = (event: KeyboardEvent) => {
    if (!isFileSearchShortcut(event) || document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) return;
    const elements = [...event.composedPath(), document.activeElement];
    if (elements.some(blocksFileSearchShortcut)) return;
    event.preventDefault();
    event.stopPropagation();
    open();
  };
  document.addEventListener('keydown', handle, true);
  return () => document.removeEventListener('keydown', handle, true);
}
