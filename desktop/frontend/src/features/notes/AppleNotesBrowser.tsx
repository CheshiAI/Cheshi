import { LockKeyhole, RefreshCw, StickyNote } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { AppleNote, AppleNotesApi } from '../../../../shared/apple-notes';
import { LiquidGlassPanel, NeumorphicButton, NeumorphicTextField, SearchClearButton } from '../../shared/ui';
import { AppleNotesFolderField } from './AppleNotesFolderField';
import { useAppleNotesBrowser } from './useAppleNotesBrowser';
import styles from './AppleNotes.module.css';

export function AppleNotesBrowser({ api, onAttach, attachmentDisabled = false }: {
  api: AppleNotesApi; onAttach: (note: AppleNote) => Promise<boolean>; attachmentDisabled?: boolean;
}) {
  const { state, browser } = useAppleNotesBrowser(api);
  const [query, setQuery] = useState('');
  const [attaching, setAttaching] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const notes = state.notes.filter(note => note.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const attach = async () => {
    if (!state.note || state.loadingNote || attachmentDisabled || pending.current) return;
    pending.current = true;
    setAttaching(true);
    setAttachmentError(null);
    try {
      const attached = await onAttach(state.note);
      if (!mounted.current) return;
      if (!attached) setAttachmentError('Could not attach this note. Check the conversation attachment limit and try again.');
    } catch (error) {
      if (mounted.current) setAttachmentError(error instanceof Error ? error.message : 'Could not attach this note.');
    } finally {
      pending.current = false;
      if (mounted.current) setAttaching(false);
    }
  };

  return <div className={`${styles.content} ${styles.workspaceContent}`}>
    <p className={styles.hint}>Choose a note to preview and attach as text. It is sent to the AI when you send your message.</p>
    <div className={styles.toolbar}>
      <AppleNotesFolderField folders={state.folders} value={state.folderId} disabled={state.loadingFolders || attaching}
        onChange={id => { setQuery(''); void browser.selectFolder(id); }} />
      <NeumorphicButton raised size="icon" aria-label="Refresh Apple Notes" title="Refresh Apple Notes"
        disabled={state.loadingFolders || attaching} onClick={() => void browser.refresh()}><RefreshCw aria-hidden="true" /></NeumorphicButton>
    </div>
    <NeumorphicTextField type="search" aria-label="Search loaded notes" placeholder="Search loaded notes by title" value={query}
      onChange={event => setQuery(event.target.value)} disabled={attaching}
      trailingAction={query ? <SearchClearButton aria-label="Clear note search" onClick={() => setQuery('')} /> : undefined} />
    <div className={styles.browser} aria-busy={state.loadingFolders || state.loadingNotes}>
      <div className={styles.list} role="region" aria-label="Notes">
        {notes.map(note => <NeumorphicButton key={note.id} raised size="standard" className={styles.noteRow}
          aria-pressed={state.selectedId === note.id} disabled={attaching} title={note.title}
          onClick={() => void browser.selectNote(note.id)}>
          {note.locked ? <LockKeyhole aria-hidden="true" /> : <StickyNote aria-hidden="true" />}
          <span>{note.title || 'Untitled note'}{note.locked && <small>Password protected</small>}</span>
        </NeumorphicButton>)}
        {!state.loadingFolders && !state.loadingNotes && notes.length === 0 && <p className={styles.hint}>
          {state.folders.length === 0 ? 'Open Notes and add an account to get started.' : query ? 'No matching loaded notes.' : 'This folder has no notes.'}
        </p>}
        {state.nextOffset !== null && <NeumorphicButton raised size="standard" disabled={state.loadingNotes || attaching}
          onClick={() => void browser.loadMore()}>Load more notes</NeumorphicButton>}
        {(state.loadingFolders || state.loadingNotes) && <p role="status">Loading notes…</p>}
      </div>
      <LiquidGlassPanel as="section" className={styles.preview} aria-label="Note preview" aria-busy={state.loadingNote} tabIndex={0}>
        {state.loadingNote ? <p role="status">Reading note…</p> : state.note ? <>
          <h3>{state.note.title || 'Untitled note'}</h3>
          <pre>{state.note.plaintext || '(Empty note)'}</pre>
        </> : <p className={styles.hint}>Select a note to read its text.</p>}
      </LiquidGlassPanel>
    </div>
    {(state.error || attachmentError) && <p className={styles.error} role="alert">{attachmentError ?? state.error}</p>}
    <p className={styles.hint}>Text only. Images, files, and rich formatting are not included.</p>
    <div className={styles.actions}>
      <NeumorphicButton raised size="standard" disabled={!state.note || state.loadingNote || attaching || attachmentDisabled} onClick={() => void attach()}>
        {attaching ? 'Attaching…' : '대화에 첨부'}
      </NeumorphicButton>
    </div>
  </div>;
}
