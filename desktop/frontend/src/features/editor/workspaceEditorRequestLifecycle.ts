import { EditorView } from '@codemirror/view';

/** Invalidate before the diagnostics listener starts requests for newly typed text. */
export function workspaceEditorRequestLifecycle(cancelSignatureHelp: () => void, dismissReferencePreview: () => void) {
  return EditorView.updateListener.of(update => {
    if (update.docChanged || !update.startState.selection.eq(update.state.selection)) cancelSignatureHelp();
    if (update.docChanged) dismissReferencePreview();
  });
}
