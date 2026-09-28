import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { Bold, Code, Heading2, Italic, List, ListOrdered, Quote, RotateCcw, Save, StickyNote, Undo2, Redo2 } from 'lucide-react';
import type { AppleNote, AppleNoteSummary, AppleNotesApi } from '../../../../shared/apple-notes';
import { APPLE_NOTES_MAX_BODY_LENGTH } from '../../../../shared/apple-notes';
import { noteDocumentReadOnlyReason, type AppleNoteDocument } from '../../../../shared/apple-notes-document';
import { LoadingState, Modal, NeumorphicButton, TwoTierHeader } from '../../shared/ui';
import { TooltipButton } from '../../shared/ui/TooltipButton';
import { retainedNoteDraft, protectNoteDraftsOnClose, type NoteEditorDraft } from './appleNotesDraft';
import type { createNewNoteDraft } from './appleNotesNewDraft';
import { noteEditorHtml, noteEditorTitle } from './appleNotesEditorContent';
import { noteEditorSaveHtml } from './appleNotesFormatting';
import { noteEditorExtensions } from './appleNotesEditorExtensions';
import { noteTimestamp } from './appleNotesTimestamp';
import styles from './AppleNotesEditor.module.css';

interface Props {
  api: AppleNotesApi;
  note: AppleNoteSummary;
  loadingNote?: boolean;
  children?: ReactNode;
  disabled: boolean;
  onSaved: (note: AppleNote) => void;
  onBusyChange: (busy: boolean) => void;
}

export function AppleNotesEditor(props: Props) {
  const [document, setDocument] = useState<AppleNoteDocument | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (props.loadingNote) {
      setDocument(null);
      setError('');
      return;
    }
    let active = true;
    props.api.document(props.note.id).then(value => {
      if (value.id !== props.note.id) throw new Error('Unexpected note');
      if (active) setDocument(value);
    }).catch(() => { if (active) setError('Could not load this note for editing.'); });
    return () => { active = false; };
  }, [props.api, props.note.id, props.loadingNote, retry]);
  if (props.loadingNote || !document) return <div className={styles.editor}>
    <NoteEditorHeader note={props.note}>{props.children}</NoteEditorHeader>
    <div className={styles.loading}>
      {!props.loadingNote && error ? <>
        <p role="alert">{error}</p>
        <NeumorphicButton onClick={() => { setError(''); setRetry(value => value + 1); }}>Retry</NeumorphicButton>
      </> : <LoadingState />}
    </div>
  </div>;
  return <LoadedNoteEditor {...props} document={document} />;
}

export function AppleNotesNewEditor({ draft, api, onSaved, onDiscard, onBusyChange }: {
  draft: ReturnType<typeof createNewNoteDraft>; api: AppleNotesApi; onSaved: (note: AppleNote) => void;
  onDiscard: () => void; onBusyChange: (busy: boolean) => void;
}) {
  const [restored] = useState(() => draft.getSnapshot());
  useEffect(() => { if (restored.saved) onSaved(restored.original); }, [restored, onSaved]);
  return <LoadedNoteEditor api={api} note={restored.original} document={restored.original} disabled={false}
    composeDraft={draft} onDiscard={onDiscard} onSaved={onSaved} onBusyChange={onBusyChange} />;
}

function NoteEditorHeader({ note, label, children }: { note: AppleNoteSummary; label?: string; children: ReactNode }) {
  const timestamp = noteTimestamp(note);
  return <TwoTierHeader className={styles.header} primary={<>
    {label ? <span className={styles.timestamp}>{label}</span> : timestamp ? <time className={styles.timestamp} dateTime={timestamp.dateTime} title={timestamp.label}>{timestamp.label}</time>
      : <span className={styles.timestamp}>Date unavailable</span>}
    <div className={styles.headerActions}>{children}</div>
  </>} />;
}

function LoadedNoteEditor({ api, document, children, disabled, onSaved, onBusyChange, composeDraft, onDiscard }: Props & {
  document: AppleNoteDocument; composeDraft?: ReturnType<typeof createNewNoteDraft>; onDiscard?: () => void;
}) {
  const [draft] = useState<NoteEditorDraft>(() => composeDraft ?? retainedNoteDraft(document, noteEditorHtml(document)));
  const state = useSyncExternalStore(draft.subscribe, draft.getSnapshot, draft.getSnapshot);
  const [latest, setLatest] = useState<AppleNoteDocument | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState('');
  const live = useRef(true);
  const reason = noteDocumentReadOnlyReason(state.original);
  const contentDisabled = disabled || state.saving || !!state.createdId || (!!composeDraft && state.blocked);
  const saveRef = useRef<() => void>(() => {});
  const editorRef = useRef<Editor | null>(null);
  const editor = useEditor({
    extensions: noteEditorExtensions(),
    content: state.html,
    autofocus: composeDraft ? 'start' : false,
    parseOptions: { preserveWhitespace: 'full' },
    editable: !reason && !contentDisabled,
    editorProps: {
      attributes: { class: styles.body!, 'aria-label': 'Memo', role: 'textbox', 'aria-multiline': 'true' },
      handleKeyDown: (_view, event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
          event.preventDefault(); saveRef.current(); return true;
        }
        return false;
      },
      handlePaste: (_view, event) => {
        const text = event.clipboardData?.getData('text/plain');
        if (!text || event.clipboardData?.getData('text/html') || !editorRef.current?.isEditable) return false;
        if (!/(^|\n)(#{1,6} |[-*] |\d+\. |> |```)|\*\*/.test(text)) return false;
        return editorRef.current.commands.insertContent(text, { contentType: 'markdown' });
      },
    },
    onUpdate: ({ editor }) => { draft.edit(noteEditorTitle(editor.state.doc), editor.getHTML()); },
  });
  editorRef.current = editor;
  const tooLarge = state.html.length > APPLE_NOTES_MAX_BODY_LENGTH;
  const saveDisabled = disabled || !!reason || state.saving || state.blocked || (!state.dirty && !state.createdId) || !state.title.trim() || tooLarge;
  saveRef.current = () => {
    if (saveDisabled || !editor) return;
    const html = noteEditorSaveHtml(editor);
    // Keep the editable draft rich; only the Notes payload uses quote markers
    // and list separators, so undo/discard still compare the same representation.
    void draft.save({ ...api,
      create: request => api.create({ ...request, html }),
      update: request => api.update({ ...request, html }),
    }).then(note => { if (note && live.current) onSaved(note); });
  };
  useEffect(() => {
    protectNoteDraftsOnClose();
    live.current = true;
    return () => { live.current = false; onBusyChange(false); };
  }, [onBusyChange]);
  useEffect(() => { onBusyChange(state.dirty || state.saving); }, [state.dirty, state.saving, onBusyChange]);
  useEffect(() => { editor?.setEditable(!reason && !contentDisabled, false); }, [editor, reason, contentDisabled]);

  const checkOriginal = async () => {
    if (checking || state.saving) return;
    setChecking(true); setCheckError('');
    try { const note = await api.document(state.original.id); if (live.current) setLatest(note); }
    catch { if (live.current) setCheckError('Could not load the original. Your draft is preserved.'); }
    finally { if (live.current) setChecking(false); }
  };

  const toolbar = [
    { label: 'Heading', icon: Heading2, run: () => editor?.chain().focus().toggleHeading({ level: 2 }).run() },
    { label: 'Bold', icon: Bold, run: () => editor?.chain().focus().toggleBold().run() },
    { label: 'Italic', icon: Italic, run: () => editor?.chain().focus().toggleItalic().run() },
    { label: 'Bullet list', icon: List, run: () => editor?.chain().focus().toggleBulletList().run() },
    { label: 'Numbered list', icon: ListOrdered, run: () => editor?.chain().focus().toggleOrderedList().run() },
    { label: 'Quote', icon: Quote, run: () => editor?.chain().focus().toggleBlockquote().run() },
    { label: 'Code block', icon: Code, run: () => editor?.chain().focus().toggleCodeBlock().run() },
    { label: 'Undo', icon: Undo2, run: () => editor?.chain().focus().undo().run() },
    { label: 'Redo', icon: Redo2, run: () => editor?.chain().focus().redo().run() },
  ];

  return <div className={styles.editor} onKeyDown={event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); saveRef.current(); }
  }}>
    <NoteEditorHeader note={state.original} label={composeDraft ? `New memo · ${composeDraft.folder.account} / ${composeDraft.folder.path}` : undefined}>
      <span className={styles.status} role="status">{state.saving ? 'Saving…' : state.blocked ? (composeDraft ? 'Check Apple Notes' : 'Review original') : state.dirty ? 'Edited' : state.saved ? 'Saved' : reason ? 'Read only' : ''}</span>
      <TooltipButton variant="ghost" size="icon" aria-label="Discard changes" title="Discard changes" disabled={(!composeDraft && !state.dirty) || state.saving || disabled} onClick={() => {
        if (composeDraft) { onDiscard?.(); return; }
        draft.discard?.(); editor?.commands.setContent(draft.getSnapshot().html, { emitUpdate: false });
      }}><RotateCcw aria-hidden="true" /></TooltipButton>
      <TooltipButton variant="ghost" size="icon" aria-label="Save to Apple Notes" title="Save (⌘S)" disabled={saveDisabled} onClick={() => saveRef.current()}><Save aria-hidden="true" /></TooltipButton>
      {children}
    </NoteEditorHeader>
    {!reason && <div className={styles.toolbar} role="toolbar" aria-label="Memo formatting">
      {toolbar.map(({ label, icon: Icon, run }) => <TooltipButton key={label} variant="ghost" size="icon" aria-label={label} title={label}
        disabled={contentDisabled || !editor} onMouseDown={event => event.preventDefault()} onClick={run}><Icon aria-hidden="true" /></TooltipButton>)}
    </div>}
    {(reason || state.error || checkError || tooLarge) && <div className={styles.notice}
      data-read-only={!!reason && !state.error && !checkError && !tooLarge && !state.blocked}>
      <p role={state.error || checkError || tooLarge ? 'alert' : undefined}>{checkError || state.error || (tooLarge ? 'This note is too large. Reduce its content.' : reason)}</p>
      {state.blocked && !composeDraft && <NeumorphicButton disabled={checking || state.saving} onClick={() => void checkOriginal()}>{checking ? 'Checking…' : 'Review latest original'}</NeumorphicButton>}
    </div>}
    <div className={styles.scroll}>
      <article className={styles.page}>
        {reason ? <pre>{state.original.plaintext}</pre> : <EditorContent editor={editor} />}
      </article>
    </div>
    {latest && <Modal title="LATEST APPLE NOTES ORIGINAL" headerVariant="section" closeButtonVariant="ghost" titleIcon={<StickyNote aria-hidden="true" />} onClose={() => setLatest(null)}>
      <p>Review the original below. Saving your draft again will replace its content.</p>
      <pre className={styles.latest}>{latest.plaintext}</pre>
      {noteDocumentReadOnlyReason(latest) && <p>{noteDocumentReadOnlyReason(latest)}</p>}
      <div className={styles.headerActions}>
        <NeumorphicButton onClick={() => setLatest(null)}>Close</NeumorphicButton>
        <NeumorphicButton disabled={!!noteDocumentReadOnlyReason(latest)} onClick={() => { draft.rebase?.(latest, noteEditorHtml(latest)); setLatest(null); }}>Keep draft and resume saving</NeumorphicButton>
      </div>
    </Modal>}
  </div>;
}
