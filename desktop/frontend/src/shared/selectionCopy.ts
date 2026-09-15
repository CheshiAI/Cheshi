import { EditorView } from '@codemirror/view';
import { installDragCopy, readDomSelection, type DragSelection } from '../../../shared/drag-copy';

export function readEditorSelection(target: Element): DragSelection | null {
  const host = target.closest<HTMLElement>('.cm-content, .cm-gutters');
  if (!host) return readDomSelection(target);
  const editor = EditorView.findFromDOM(host);
  if (!editor) return null;
  return readEditorStateSelection(editor);
}

export function readEditorStateSelection(editor: Pick<EditorView, 'state'>): DragSelection | null {
  const ranges = editor.state.selection.ranges.filter(range => !range.empty);
  if (!ranges.length) return null;
  return { text: ranges.map(range => editor.state.sliceDoc(range.from, range.to)).join(editor.state.lineBreak),
    identity: [editor, ...ranges.flatMap(range => [range.from, range.to])] };
}

export function installSelectionCopy(document: Document): () => void {
  return installDragCopy(document, text => navigator.clipboard.writeText(text), readEditorSelection);
}
