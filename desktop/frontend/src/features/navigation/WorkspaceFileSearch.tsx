import { FileText, Search } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { cheshiDesktop } from '../../cheshiDesktop';
import { Modal, NeumorphicTextField } from '../../shared/ui';
import { createFileSearchController, handleFileSearchKeyDown, initialFileSearchState, selectedFileSearchPath } from './fileSearchModel';
import styles from './WorkspaceFileSearch.module.css';

export function WorkspaceFileSearch({ onOpenFile, onClose }: { onOpenFile: (path: string) => void; onClose: () => void }) {
  const [state, setState] = useState(initialFileSearchState);
  const controller = useRef<ReturnType<typeof createFileSearchController> | null>(null);
  const openedFile = useRef(false);
  const list = useRef<HTMLUListElement>(null);
  const listId = useId();
  useEffect(() => {
    const current = createFileSearchController(query => {
      if (!cheshiDesktop?.searchWorkspaceFiles) return Promise.reject(new Error('File search is unavailable.'));
      return cheshiDesktop.searchWorkspaceFiles(query);
    }, setState);
    controller.current = current;
    const unsubscribe = cheshiDesktop?.onWorkspaceFilesChanged?.(() => current.refresh());
    return () => { unsubscribe?.(); current.dispose(); controller.current = null; };
  }, []);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [state.selectedIndex, state.result]);
  const openFile = (path: string | null) => {
    if (!path || state.loading) return;
    openedFile.current = true;
    onOpenFile(path);
    onClose();
  };
  return <Modal title="Find file" titleIcon={<Search aria-hidden="true" />} className={styles.dialog}
    restoreFocus={() => !openedFile.current} onClose={onClose}>
    <div className={styles.content} onKeyDown={event => handleFileSearchKeyDown(event, {
      move: direction => controller.current?.move(direction),
      open: () => openFile(selectedFileSearchPath(state)), close: onClose,
    })}>
      <NeumorphicTextField autoFocus type="search" role="combobox" aria-label="Find a workspace file"
        placeholder="Search filenames or paths…" value={state.query} maxLength={256} autoComplete="off" spellCheck={false}
        aria-controls={listId} aria-expanded={true} aria-autocomplete="list"
        aria-activedescendant={state.selectedIndex >= 0 ? `${listId}-${state.selectedIndex}` : undefined}
        onChange={event => controller.current?.changeQuery(event.target.value)} />
      <ul ref={list} id={listId} role="listbox" aria-label="Matching files" aria-busy={state.loading} className={styles.results}>
        {state.result.files.map((file, index) => <li key={file.path} id={`${listId}-${index}`} role="option"
          aria-selected={index === state.selectedIndex} className={styles.result} title={file.path}
          onPointerMove={() => controller.current?.select(index)}
          onMouseDown={event => event.preventDefault()} onClick={() => openFile(file.path)}>
          <FileText aria-hidden="true" /><span className={styles.file}><strong>{file.name}</strong><small>{file.path}</small></span>
        </li>)}
      </ul>
      <p role={state.error ? 'alert' : 'status'} className={styles.status}>
        {state.error ?? (state.loading ? 'Searching…' : !state.query.trim() ? 'Type a filename or path to search.'
          : state.result.files.length === 0 ? 'No files found.'
            : state.result.truncated ? 'Showing partial results. Refine your search.' : `${state.result.files.length} files`)}
      </p>
      <p className={styles.hint}>↑↓ Navigate · Enter Open · Esc Close</p>
    </div>
  </Modal>;
}
