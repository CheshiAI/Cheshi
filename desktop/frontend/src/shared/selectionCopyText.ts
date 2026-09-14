import { EditorView } from '@codemirror/view';
import type { SelectionCopySnapshot } from './dragSelectionCopy';

export function readSelectionCopyText(document: Document, origin: EventTarget | null): SelectionCopySnapshot | null {
  const target = origin instanceof Element ? origin : null;
  if (target?.closest('[inert], [data-selection-copy="off"]')) return null;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    if (target instanceof HTMLInputElement && !['text', 'search', 'url', 'tel'].includes(target.type)) return null;
    const { selectionStart, selectionEnd } = target;
    if (selectionStart === null || selectionEnd === null || selectionStart === selectionEnd) return null;
    return {
      text: target.value.slice(selectionStart, selectionEnd), anchor: target, focus: target,
      ranges: `${selectionStart}:${selectionEnd}`,
    };
  }
  const editorElement = target?.closest('.cm-editor');
  if (editorElement instanceof HTMLElement && !target?.closest('.cm-tooltip')) {
    const view = EditorView.findFromDOM(editorElement);
    if (!view) return null;
    const ranges = view.state.selection.ranges.filter((range) => !range.empty);
    if (ranges.length === 0) return null;
    return {
      text: ranges.map((range) => view.state.sliceDoc(range.from, range.to)).join(view.state.lineBreak),
      anchor: view, focus: view, ranges: ranges.map((range) => `${range.from}:${range.to}`).join(','),
    };
  }
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const text = selection.toString();
  return text ? {
    text, anchor: selection.anchorNode, focus: selection.focusNode,
    ranges: `${selection.anchorOffset}:${selection.focusOffset}`,
  } : null;
}
