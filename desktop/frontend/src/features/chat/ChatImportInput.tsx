import { useImperativeHandle, useLayoutEffect, useRef, useState, type AriaAttributes, type ClipboardEventHandler,
  type FocusEventHandler, type KeyboardEventHandler, type Ref } from 'react';
import { Annotation, Compartment, EditorSelection, EditorState, type TransactionSpec } from '@codemirror/state';
import { EditorView, keymap, placeholder } from '@codemirror/view';
import { history, historyKeymap, insertNewline, isolateHistory, standardKeymap } from '@codemirror/commands';
import type { ChatImportAttachment } from '../../../../shared/chat-imports';
import { installAutoHideScrollbars } from '../../shared/useAutoHideScrollbars';
import { hasChatTransferFiles } from './attachmentTransferModel';
import { chatEditorAttachments, chatEditorImports, chatImportChips, chatImportSelectionBounds } from './chatImportEditor';
import type { ChatInputHandle } from './chatInputHandle';
import styles from './ChatImportInput.module.css';

interface ChatImportInputProps extends Pick<AriaAttributes, 'aria-label' | 'aria-controls' | 'aria-expanded' | 'aria-activedescendant'> {
  ref?: Ref<ChatInputHandle>;
  value: string;
  attachments?: readonly ChatImportAttachment[];
  historyKey: string;
  disabled?: boolean;
  readOnly?: boolean;
  placeholder?: string;
  onChange(value: string, attachments?: readonly ChatImportAttachment[]): void;
  onKeyDown?: KeyboardEventHandler<HTMLElement>;
  onPaste?: ClipboardEventHandler<HTMLElement>;
  onFocus?: FocusEventHandler<HTMLElement>;
}

const externalDraft = Annotation.define<boolean>();
const plainTextKeymap = [
  ...historyKeymap,
  { key: 'Enter', run: insertNewline, shift: insertNewline },
  ...standardKeymap.filter(binding => binding.key !== 'Enter'),
];

function inputConfiguration(props: ChatImportInputProps) {
  const attributes: Record<string, string> = {
    role: 'textbox', 'aria-multiline': 'true', spellcheck: 'true',
    'aria-readonly': String(props.readOnly === true), 'aria-disabled': String(props.disabled === true),
    tabindex: props.disabled ? '-1' : '0',
  };
  for (const name of ['aria-label', 'aria-controls', 'aria-expanded', 'aria-activedescendant'] as const) {
    if (props[name] !== undefined) attributes[name] = String(props[name]);
  }
  return [
    EditorState.readOnly.of(props.disabled === true || props.readOnly === true),
    EditorView.editable.of(!props.disabled && !props.readOnly),
    EditorView.contentAttributes.of(attributes), placeholder(props.placeholder ?? ''),
    chatEditorImports.of(props.attachments ?? []),
  ];
}

/** The document stays plain text; only connected attachment references render as chips. */
export function ChatImportInput(props: ChatImportInputProps) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const [configuration] = useState(() => new Compartment());
  const previous = useRef(props);

  const createState = (value: string) => EditorState.create({ doc: value, extensions: [
    history(), keymap.of(plainTextKeymap), EditorView.lineWrapping, chatImportChips,
    configuration.of(inputConfiguration(latest.current)),
    EditorView.updateListener.of(update => {
      if (update.docChanged && !update.transactions.some(transaction => transaction.annotation(externalDraft))) {
        const imports = update.state.field(chatEditorAttachments);
        latest.current.onChange(update.state.doc.toString(), latest.current.attachments === undefined
          || imports === update.startState.field(chatEditorAttachments) ? undefined : imports);
      }
    }),
  ] });

  useLayoutEffect(() => {
    if (!host.current) return;
    const view = new EditorView({ parent: host.current, state: createState(latest.current.value) });
    editor.current = view;
    const cleanupScrollbars = installAutoHideScrollbars(view.scrollDOM);
    return () => { cleanupScrollbars(); view.destroy(); editor.current = null; };
  }, []);

  useImperativeHandle(props.ref, () => ({
    get value() { return editor.current?.state.doc.toString() ?? latest.current.value; },
    get selectionStart() { return editor.current?.state.selection.main.from ?? 0; },
    get selectionEnd() { return editor.current?.state.selection.main.to ?? 0; },
    get selectionDirection() {
      const range = editor.current?.state.selection.main;
      return !range || range.empty ? 'none' : range.anchor > range.head ? 'backward' : 'forward';
    },
    focus: () => { if (!latest.current.disabled) editor.current?.focus(); },
    contains: node => host.current?.contains(node) ?? false,
    setSelectionRange: (start, end, direction) => {
      const view = editor.current;
      if (!view) return;
      const { from, to } = chatImportSelectionBounds(view.state, start, end);
      view.dispatch({ selection: EditorSelection.single(direction === 'backward' ? to : from, direction === 'backward' ? from : to),
        scrollIntoView: view.hasFocus });
    },
  }), []);

  useLayoutEffect(() => {
    const view = editor.current;
    if (!view) return;
    const before = previous.current;
    previous.current = props;
    const text = view.state.doc.toString();
    // Switching sessions or clearing a sent draft must not restore another message through Undo.
    if (before.historyKey !== props.historyKey || (props.value === '' && (text !== ''
      || (props.attachments?.length === 0 && view.state.field(chatEditorAttachments).length > 0)))) {
      view.setState(createState(props.value));
      return;
    }
    const update: TransactionSpec = { annotations: externalDraft.of(true) };
    let changed = false;
    if (text !== props.value) {
      let from = 0, oldEnd = text.length, newEnd = props.value.length;
      while (from < oldEnd && from < newEnd && text[from] === props.value[from]) from++;
      while (oldEnd > from && newEnd > from && text[oldEnd - 1] === props.value[newEnd - 1]) { oldEnd--; newEnd--; }
      update.changes = { from, to: oldEnd, insert: props.value.slice(from, newEnd) };
      update.selection = { anchor: newEnd };
      update.annotations = [externalDraft.of(true), isolateHistory.of('full')];
      changed = true;
    }
    if (before.attachments !== props.attachments || before.disabled !== props.disabled || before.readOnly !== props.readOnly
      || before.placeholder !== props.placeholder || before['aria-label'] !== props['aria-label']
      || before['aria-controls'] !== props['aria-controls'] || before['aria-expanded'] !== props['aria-expanded']
      || before['aria-activedescendant'] !== props['aria-activedescendant']) {
      update.effects = configuration.reconfigure(inputConfiguration(props));
      changed = true;
    }
    if (changed) view.dispatch(update);
  }, [props.value, props.historyKey, props.attachments, props.disabled, props.readOnly, props.placeholder,
    props['aria-label'], props['aria-controls'], props['aria-expanded'], props['aria-activedescendant']]);

  return <div className={styles.input} ref={host} aria-disabled={props.disabled || undefined}
    onKeyDownCapture={event => {
      // Keep IME confirmation native, before either composer or editor key bindings run.
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || editor.current?.composing) {
        event.stopPropagation();
        return;
      }
      props.onKeyDown?.(event);
    }} onPasteCapture={props.onPaste} onFocus={props.onFocus}
    onDragOverCapture={event => { if (hasChatTransferFiles(event.dataTransfer)) event.preventDefault(); }}
    onDropCapture={event => { if (hasChatTransferFiles(event.dataTransfer)) event.preventDefault(); }} />;
}
