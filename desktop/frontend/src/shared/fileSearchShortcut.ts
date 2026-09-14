export function installFileSearchShortcut(
    target: Window,
    onTrigger: () => boolean,
): () => void {
    let composing = false;
    const keyDown = (event: KeyboardEvent) => {
        const isFileKey = event.code === 'KeyF' || (!event.code && event.key.toLowerCase() === 'f');
        if (!isFileKey || !event.shiftKey || event.ctrlKey || event.metaKey || event.altKey
            || event.repeat || event.isComposing || event.keyCode === 229 || composing) return;
        if (onTrigger()) {
            event.preventDefault();
            event.stopPropagation();
        }
    };
    const compositionStart = () => { composing = true; };
    const reset = () => { composing = false; };
    target.addEventListener('keydown', keyDown, true);
    target.addEventListener('compositionstart', compositionStart, true);
    target.addEventListener('compositionend', reset, true);
    target.addEventListener('blur', reset, true);
    return () => {
        target.removeEventListener('keydown', keyDown, true);
        target.removeEventListener('compositionstart', compositionStart, true);
        target.removeEventListener('compositionend', reset, true);
        target.removeEventListener('blur', reset, true);
    };
}
