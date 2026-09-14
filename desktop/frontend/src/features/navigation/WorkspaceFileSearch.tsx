import { FileSearch, FileText, Search } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { Modal, NeumorphicButton, NeumorphicTextField, SearchClearButton } from '../../shared/ui';
import { installFileSearchShortcut } from '../../shared/fileSearchShortcut';
import { useWorkspaceFileSearch } from './useWorkspaceFileSearch';
import styles from './WorkspaceFileSearch.module.css';

export function WorkspaceFileSearch({ disabled, onOpenFile }: {
  disabled: boolean;
  onOpenFile: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (disabled) { setOpen(false); return; }
    return installFileSearchShortcut(window, () => {
      const blockingDialog = [...document.querySelectorAll('dialog[open], [role="dialog"]')]
        .some(dialog => dialog.getClientRects().length > 0 && getComputedStyle(dialog).visibility === 'visible');
      if (blockingDialog) return false;
      setOpen(true);
      return true;
    });
  }, [disabled]);
  return open && !disabled ? <WorkspaceFileSearchDialog onClose={() => setOpen(false)} onOpenFile={onOpenFile} /> : null;
}

export function WorkspaceFileSearchDialog({ onClose, onOpenFile }: {
  onClose: () => void;
  onOpenFile: (path: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const openedFile = useRef(false);
  const listId = useId();
  const result = useWorkspaceFileSearch(query);
  const selectedFile = result.files[selected];
  const changeQuery = (value: string) => { setQuery(value); setSelected(0); };
  const openFile = (path: string) => {
    if (openedFile.current || result.loading) return;
    openedFile.current = true;
    onOpenFile(path);
    onClose();
  };
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selected, result.files]);

  return <Modal title="Search files" titleIcon={<FileSearch aria-hidden="true" />} className={styles.dialog}
    onClose={onClose} restoreFocus={() => !openedFile.current}>
    <div className={styles.search}>
      <Search aria-hidden="true" />
      <NeumorphicTextField autoFocus ref={inputRef} value={query} maxLength={256}
        placeholder="Search by file name or path…" aria-label="Search workspace files"
        role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls={listId}
        aria-activedescendant={selectedFile ? `${listId}-${selected}` : undefined}
        onChange={event => changeQuery(event.target.value)}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault(); event.stopPropagation();
            if (result.files.length) setSelected(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + result.files.length) % result.files.length);
          } else if (event.key === 'Enter') {
            event.preventDefault(); event.stopPropagation();
            if (selectedFile && !result.loading) openFile(selectedFile.path);
          }
        }}
        trailingAction={query && <SearchClearButton aria-label="Clear file search" onClick={() => {
          changeQuery(''); inputRef.current?.focus();
        }} />} />
    </div>
    <ul ref={listRef} id={listId} role="listbox" aria-label="Matching files" aria-busy={result.loading} className={styles.results}>
      {result.files.map((file, index) => <li key={file.path} id={`${listId}-${index}`} role="option"
        aria-selected={index === selected} className={styles.result} title={file.path}
        onMouseDown={event => event.preventDefault()} onMouseMove={() => setSelected(index)} onClick={() => openFile(file.path)}>
        <FileText aria-hidden="true" /><span><strong>{file.name}</strong><small>{file.path}</small></span>
      </li>)}
    </ul>
    {result.loading && <p className={styles.message} role="status">Searching files…</p>}
    {result.error && <div className={styles.message} role="alert"><span>{result.error}</span>
      <NeumorphicButton size="standard" onClick={() => { setSelected(0); result.retry(); }}>Retry</NeumorphicButton></div>}
    {!result.loading && !result.error && !result.files.length && <p className={styles.message} role="status">No files found.</p>}
    <footer className={styles.footer}>
      <span>↑↓ Navigate · Enter Open · Esc Close</span>
      <span role="status">{result.truncated ? 'More files available · Refine your search' : `${result.files.length} files`}</span>
    </footer>
  </Modal>;
}
