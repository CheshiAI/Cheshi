import { Check, StickyNote } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { APPLE_NOTES_MAX_BODY_LENGTH, APPLE_NOTES_MAX_TITLE_LENGTH, APPLE_NOTES_SAVE_UNKNOWN_MESSAGE, type AppleNotesApi } from '../../../../shared/apple-notes';
import { cheshiDesktop } from '../../cheshiDesktop';
import { LiquidGlassPanel, Modal, NeumorphicButton, NeumorphicTextField, Tooltip } from '../../shared/ui';
import { AppleNotesFolderField } from './AppleNotesFolderField';
import { useAppleNotesBrowser } from './useAppleNotesBrowser';
import styles from './AppleNotes.module.css';

export function AppleNotesSaveAction({ title, body }: { title: string; body: string }) {
  const api = cheshiDesktop?.appleNotes;
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  if (!api?.available) return null;
  const label = saved ? 'Saved to Apple Notes' : 'Save response to Apple Notes';
  return <>
    <Tooltip content={label}>{props => <NeumorphicButton {...props} raised size="icon" aria-label={label}
      disabled={!body.trim()} onClick={() => setOpen(true)}>{saved ? <Check aria-hidden="true" /> : <StickyNote aria-hidden="true" />}</NeumorphicButton>}</Tooltip>
    {open && <AppleNotesSaveDialog api={api} initialTitle={title} body={body} onClose={() => setOpen(false)}
      onSaved={() => { setSaved(true); setOpen(false); }} />}
  </>;
}

export function AppleNotesSaveDialog({ api, initialTitle, body, onClose, onSaved }: {
  api: AppleNotesApi; initialTitle: string; body: string; onClose: () => void; onSaved: () => void;
}) {
  const { state, browser } = useAppleNotesBrowser(api, false);
  const [title, setTitle] = useState((initialTitle.trim() || 'Cheshi response').slice(0, APPLE_NOTES_MAX_TITLE_LENGTH));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unknownResult, setUnknownResult] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  const titleId = useId();
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const tooLarge = body.length > APPLE_NOTES_MAX_BODY_LENGTH;
  const save = async () => {
    if (pending.current || state.loadingFolders || !state.folderId || !title.trim() || !body.trim() || tooLarge || unknownResult) return;
    pending.current = true;
    setSaving(true);
    setError(null);
    try {
      const result = await api.create({ folderId: state.folderId, title: title.trim(), body });
      if (!mounted.current) return;
      if (result.ok) onSaved();
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

  return <Modal title="Save to Apple Notes" titleIcon={<StickyNote aria-hidden="true" />} onClose={onClose} closeDisabled={saving}
    className={styles.dialog}>
    <form className={styles.content} onSubmit={event => { event.preventDefault(); void save(); }}>
      <label htmlFor={titleId} className={styles.field}><span>Title</span>
        <NeumorphicTextField id={titleId} value={title} maxLength={APPLE_NOTES_MAX_TITLE_LENGTH} disabled={saving}
          onChange={event => setTitle(event.target.value)} />
      </label>
      <AppleNotesFolderField folders={state.folders} value={state.folderId} disabled={state.loadingFolders || saving}
        onChange={id => { void browser.selectFolder(id); }} />
      {state.loadingFolders && <p role="status">Loading folders…</p>}
      {state.error && <div className={styles.content}><p className={styles.error} role="alert">{state.error}</p>
        <NeumorphicButton type="button" raised size="standard" disabled={saving || state.loadingFolders}
          onClick={() => void browser.refresh()}>Retry loading folders</NeumorphicButton></div>}
      <LiquidGlassPanel as="section" className={styles.preview} aria-label="Response to save" tabIndex={0}><pre>{body}</pre></LiquidGlassPanel>
      <p className={styles.hint}>Creates a new note with this response as text. Markdown is kept as text; images and files are not included.</p>
      {(error || tooLarge) && <p className={styles.error} role="alert">{error ?? 'This response is too large to save to Apple Notes.'}</p>}
      <div className={styles.actions}>
        <NeumorphicButton type="button" raised size="standard" disabled={saving} onClick={onClose}>Cancel</NeumorphicButton>
        <NeumorphicButton type="submit" raised size="standard"
          disabled={saving || state.loadingFolders || !state.folderId || !title.trim() || !body.trim() || tooLarge || unknownResult}>
          {saving ? 'Saving…' : 'Create note'}
        </NeumorphicButton>
      </div>
    </form>
  </Modal>;
}
