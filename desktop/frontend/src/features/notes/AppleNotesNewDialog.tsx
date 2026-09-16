import { Check, Folder, StickyNote } from 'lucide-react';
import { useRef, useState } from 'react';
import type { AppleNotesApi, AppleNotesFolder } from '../../../../shared/apple-notes';
import { Modal, NeumorphicButton } from '../../shared/ui';
import { useAppleNotesBrowser } from './useAppleNotesBrowser';
import styles from './AppleNotesNewDialog.module.css';

export function AppleNotesNewDialog({ api, initialFolderId, onClose, onContinue }: {
  api: AppleNotesApi; initialFolderId: string; onClose: () => void; onContinue: (folder: AppleNotesFolder) => void;
}) {
  const { state, browser } = useAppleNotesBrowser(api, false);
  const chosen = useRef(false);
  const [selectedId, setSelectedId] = useState(initialFolderId);
  const selectedFolder = state.folders.find(folder => folder.id === selectedId)
    ?? state.folders.find(folder => folder.id === state.folderId);
  return <Modal title="New memo" titleIcon={<StickyNote aria-hidden="true" />} onClose={onClose} className={styles.dialog}>
    <form className={styles.content} onSubmit={event => {
      event.preventDefault();
      if (chosen.current || !selectedFolder || state.loadingFolders || state.error) return;
      chosen.current = true;
      onContinue(selectedFolder);
    }}>
      {state.loadingFolders && <p role="status">Loading folders…</p>}
      {state.error && <><p className={styles.error} role="alert">{state.error}</p>
        <NeumorphicButton type="button" disabled={state.loadingFolders} onClick={() => void browser.refresh()}>Retry loading folders</NeumorphicButton></>}
      {!state.loadingFolders && !state.error && state.folders.length === 0 && <p>No folders available. Add a folder in Apple Notes.</p>}
      <ul className={styles.folders} aria-label="Choose a folder">
        {state.folders.map(folder => <li key={folder.id}>
          <button type="button" className={styles.folder} aria-pressed={folder.id === selectedFolder?.id}
            title={`${folder.account} / ${folder.path}`} disabled={state.loadingFolders || !!state.error}
            onClick={() => {
              if (chosen.current || state.loadingFolders || state.error) return;
              setSelectedId(folder.id);
            }}>
            <Folder aria-hidden="true" />
            <span className={styles.label}><strong>{folder.path}</strong><small>{folder.account}</small></span>
            {folder.id === selectedFolder?.id && <Check aria-hidden="true" />}
          </button>
        </li>)}
      </ul>
      <div className={styles.actions}>
        <NeumorphicButton type="submit" raised size="standard" disabled={!selectedFolder || state.loadingFolders || !!state.error}>Confirm</NeumorphicButton>
      </div>
    </form>
  </Modal>;
}
