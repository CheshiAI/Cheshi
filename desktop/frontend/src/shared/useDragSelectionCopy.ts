import { useEffect } from 'react';
import { installDragSelectionCopy } from './dragSelectionCopy';
import { readSelectionCopyText } from './selectionCopyText';

export function useDragSelectionCopy(): void {
  useEffect(() => installDragSelectionCopy(document, {
    readSelection: (origin) => readSelectionCopyText(document, origin),
    writeText: (text) => navigator.clipboard.writeText(text),
    onError: (error) => { console.warn('Could not automatically copy the selected text.', error); },
  }), []);
}
