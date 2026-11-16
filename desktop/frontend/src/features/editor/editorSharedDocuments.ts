import { Annotation, Transaction } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';
import { cheshiDesktop } from '../../cheshiDesktop';
import { languageServerLanguageForPath } from './languageServerDiagnostics';

const synchronizedEdit = Annotation.define<boolean>();
const views = new Map<string, Set<EditorView>>();
const versions = new Map<string, number>();

export function nextEditorDocumentVersion(path: string): number {
  const next = (versions.get(path) ?? 0) + 1;
  versions.set(path, next);
  return next;
}

/** A language-server document belongs to all its views, rather than one pane. */
export function sharedEditorDocument(path: string) {
  return ViewPlugin.define(view => {
    const peers = views.get(path) ?? new Set<EditorView>();
    peers.add(view);
    views.set(path, peers);
    return { destroy() {
      peers.delete(view);
      if (peers.size) return;
      views.delete(path);
      const language = languageServerLanguageForPath(path);
      if (language) void cheshiDesktop?.closeLanguageServerDocument?.({ language, path });
    } };
  });
}

export function dispatchSharedEditorTransactions(path: string, transactions: readonly Transaction[], view: EditorView): void {
  view.update(transactions);
  for (const transaction of transactions) {
    if (!transaction.docChanged || transaction.annotation(synchronizedEdit)) continue;
    for (const peer of views.get(path) ?? []) {
      if (peer === view) continue;
      peer.dispatch({ changes: transaction.changes,
        annotations: [synchronizedEdit.of(true), Transaction.addToHistory.of(false)] });
    }
  }
}
