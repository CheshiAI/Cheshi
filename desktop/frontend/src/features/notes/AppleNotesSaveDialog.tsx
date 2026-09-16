import { StickyNote } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { APPLE_NOTES_MAX_BODY_LENGTH, APPLE_NOTES_MAX_TITLE_LENGTH, APPLE_NOTES_SAVE_UNKNOWN_MESSAGE, type AppleNotesApi } from '../../../../shared/apple-notes';
import { LiquidGlassPanel, Modal, NeumorphicButton, NeumorphicTextField } from '../../shared/ui';
import { AppleNotesFolderField } from './AppleNotesFolderField';
import { useAppleNotesBrowser } from './useAppleNotesBrowser';
import styles from './AppleNotes.module.css';

export function AppleNotesSaveDialog({ api, initialTitle, body: responseBody, initialFolderId = '', mode = 'response', onClose, onSaved }: {
  api: AppleNotesApi; initialTitle: string; body: string; initialFolderId?: string; mode?: 'response' | 'compose';
  onClose: () => void; onSaved: (folderId: string) => void;
}) {
  const { state, browser } = useAppleNotesBrowser(api, false);
  const composing = mode === 'compose';
  const [title, setTitle] = useState((initialTitle.trim() || (composing ? '' : 'Cheshi response')).slice(0, APPLE_NOTES_MAX_TITLE_LENGTH));
  const [draftBody, setDraftBody] = useState('');
  const [selectedFolderId, setSelectedFolderId] = useState(initialFolderId);
  const folderId = state.folders.some(folder => folder.id === selectedFolderId) ? selectedFolderId : state.folderId;
  const body = composing ? draftBody : responseBody;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unknownResult, setUnknownResult] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  const titleId = useId();
  const bodyId = useId();
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const tooLarge = body.length > APPLE_NOTES_MAX_BODY_LENGTH;
  const save = async () => {
    if (pending.current || state.loadingFolders || !folderId || !title.trim() || !body.trim() || tooLarge || unknownResult) return;
    pending.current = true;
    setSaving(true);
    setError(null);
    try {
      const result = await api.create({ folderId, title: title.trim(), body });
      if (!mounted.current) return;
      if (result.ok === true) onSaved(folderId);
      else { setError(result.error.message); setUnknownResult(result.error.code === 'save-unknown'); }
    } catch {
      if (mounted.current) {
        setError(APPLE_NOTES_SAVE_UNKNOWN_MESSAGE);
        setUnknownResult(true);
      }
    } finally {
      pending.current = false;
      if (mounted.current) setSaving(false);
    }
  };

  return <Modal title={composing ? '새 메모' : 'Save to Apple Notes'} titleIcon={<StickyNote aria-hidden="true" />} onClose={onClose} closeDisabled={saving}
    className={styles.dialog}>
    <form className={styles.content} onSubmit={event => { event.preventDefault(); void save(); }}>
      <label htmlFor={titleId} className={styles.field}><span>{composing ? '제목' : 'Title'}</span>
        <NeumorphicTextField id={titleId} value={title} maxLength={APPLE_NOTES_MAX_TITLE_LENGTH} disabled={saving}
          onChange={event => setTitle(event.target.value)} />
      </label>
      <AppleNotesFolderField folders={state.folders} value={folderId} disabled={state.loadingFolders || saving}
        onChange={setSelectedFolderId} />
      {state.loadingFolders && <p role="status">Loading folders…</p>}
      {state.error && <div className={styles.content}><p className={styles.error} role="alert">{state.error}</p>
        <NeumorphicButton type="button" raised size="standard" disabled={saving || state.loadingFolders}
          onClick={() => void browser.refresh()}>Retry loading folders</NeumorphicButton></div>}
      {composing ? <label htmlFor={bodyId} className={styles.field}><span>본문</span>
        <NeumorphicTextField id={bodyId} multiline rows={10} value={draftBody} maxLength={APPLE_NOTES_MAX_BODY_LENGTH}
          disabled={saving} onChange={event => setDraftBody(event.target.value)} />
      </label> : <LiquidGlassPanel as="section" className={styles.preview} aria-label="Response to save" tabIndex={0}><pre>{body}</pre></LiquidGlassPanel>}
      <p className={styles.hint}>{composing ? '입력한 내용을 Apple 메모에 새 메모로 저장합니다.' : 'Creates a new note with this response as text. Markdown is kept as text; images and files are not included.'}</p>
      {(error || tooLarge) && <p className={styles.error} role="alert">{error ?? 'This text is too large to save to Apple Notes.'}</p>}
      <div className={styles.actions}>
        <NeumorphicButton type="button" raised size="standard" disabled={saving} onClick={onClose}>{composing ? '취소' : 'Cancel'}</NeumorphicButton>
        <NeumorphicButton type="submit" raised size="standard"
          disabled={saving || state.loadingFolders || !folderId || !title.trim() || !body.trim() || tooLarge || unknownResult}>
          {saving ? (composing ? '저장 중…' : 'Saving…') : (composing ? '저장' : 'Create note')}
        </NeumorphicButton>
      </div>
    </form>
  </Modal>;
}
