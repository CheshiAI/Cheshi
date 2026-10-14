import { Facet, StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state';
import { invertedEffects } from '@codemirror/commands';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import { chatImportLabel, type ChatImportAttachment } from '../../../../shared/chat-imports';
import styles from './ChatImportInput.module.css';

export const chatEditorImports = Facet.define<readonly ChatImportAttachment[], readonly ChatImportAttachment[]>({
  combine: values => values[0] ?? [],
});

const restoreAttachments = StateEffect.define<readonly ChatImportAttachment[]>();

/** Keep the attachment list in the same Undo transaction as its inline references. */
export const chatEditorAttachments = StateField.define<readonly ChatImportAttachment[]>({
  create: state => state.facet(chatEditorImports),
  update: (value, transaction) => {
    const supplied = transaction.state.facet(chatEditorImports);
    const suppliedChanged = supplied !== transaction.startState.facet(chatEditorImports);
    let next = suppliedChanged ? supplied : value;
    let restored = false;
    for (const effect of transaction.effects) {
      if (effect.is(restoreAttachments)) {
        next = effect.value;
        restored = true;
      }
    }
    if (transaction.docChanged && !suppliedChanged && !restored && next.some(item => item.importNumber !== undefined)) {
      const before = transaction.startState.doc.toString();
      const after = transaction.newDoc.toString();
      next = next.filter(attachment => {
        if (attachment.importNumber === undefined) return true;
        const label = chatImportLabel(attachment.importNumber);
        // Older drafts may have attachments without references. Only a removed last reference detaches them.
        return !before.includes(label) || after.includes(label);
      });
    }
    return next.length === value.length && next.every((item, index) => item === value[index]) ? value : next;
  },
});

const attachmentHistory = invertedEffects.of(transaction => {
  const before = transaction.startState.field(chatEditorAttachments);
  return transaction.docChanged && before !== transaction.state.field(chatEditorAttachments)
    ? [restoreAttachments.of(before)] : [];
});

class ImportChip extends WidgetType {
  readonly number: number;
  readonly name: string;

  constructor(number: number, name: string) {
    super();
    this.number = number;
    this.name = name;
  }

  eq(other: ImportChip) { return this.number === other.number && this.name === other.name; }

  toDOM(view: EditorView) {
    const chip = view.dom.ownerDocument.createElement('span');
    chip.className = styles.chip ?? '';
    chip.textContent = `import ${this.number}`;
    chip.title = this.name;
    chip.setAttribute('data-chat-import-number', String(this.number));
    chip.setAttribute('aria-label', `import ${this.number}: ${this.name}`);
    chip.setAttribute('spellcheck', 'false');
    return chip;
  }

  // Let the editor place the caret before/after a chip on pointer input.
  ignoreEvent() { return false; }
}

function importDecorations(state: EditorState) {
  const attachments = new Map(state.field(chatEditorAttachments).flatMap(attachment =>
    attachment.importNumber === undefined ? [] : [[chatImportLabel(attachment.importNumber), attachment] as const]));
  if (!attachments.size) return Decoration.none;
  const ranges = [];
  for (const match of state.doc.toString().matchAll(/\[import [1-9]\d*\]/g)) {
    const attachment = attachments.get(match[0]);
    if (!attachment || attachment.importNumber === undefined) continue;
    ranges.push(Decoration.replace({ widget: new ImportChip(attachment.importNumber, attachment.name) })
      .range(match.index, match.index + match[0].length));
  }
  return Decoration.set(ranges);
}

const chips = StateField.define<DecorationSet>({
  create: importDecorations,
  update: (value, transaction) => transaction.docChanged
    || transaction.startState.field(chatEditorAttachments) !== transaction.state.field(chatEditorAttachments)
    ? importDecorations(transaction.state) : value,
  provide: field => [EditorView.decorations.from(field), EditorView.atomicRanges.of(view => view.state.field(field))],
});

export const chatImportChips: Extension = [chatEditorAttachments, attachmentHistory, chips];

/** Keep external cursor restoration out of the hidden text inside a chip. */
export function chatImportSelectionBounds(state: EditorState, start: number, end: number) {
  let from = Math.max(0, Math.min(start, state.doc.length));
  let to = Math.max(from, Math.min(end, state.doc.length));
  const collapsed = from === to;
  state.field(chips).between(from, to, (chipStart, chipEnd) => {
    if (collapsed && chipStart < from && from < chipEnd) {
      from = to = from - chipStart < chipEnd - from ? chipStart : chipEnd;
    } else if (!collapsed) {
      if (chipStart < from && from < chipEnd) from = chipStart;
      if (chipStart < to && to < chipEnd) to = chipEnd;
    }
  });
  return { from, to };
}
