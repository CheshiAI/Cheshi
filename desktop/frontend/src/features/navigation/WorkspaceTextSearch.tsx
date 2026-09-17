import { TextSearch } from 'lucide-react';
import { Fragment, useEffect, useId, useRef, useState, type RefObject } from 'react';
import { cheshiDesktop } from '../../cheshiDesktop';
import { workspaceTextSearchQueryLimit, type WorkspaceTextSearchMatch } from '../../../../shared/workspace-text-search';
import { Modal, NeumorphicCheckbox, NeumorphicTextField } from '../../shared/ui';
import { handleFileSearchKeyDown } from './fileSearchModel';
import { createTextSearchController, initialTextSearchState, matchLineParts, selectedTextSearchMatch, textSearchMatches,
  textSearchStatus } from './textSearchModel';
import styles from './WorkspaceTextSearch.module.css';

export function WorkspaceTextSearchResults({ matches, selectedIndex, listId, listRef, loading, onSelect, onOpen }: {
  matches: readonly WorkspaceTextSearchMatch[]; selectedIndex: number; listId: string; loading: boolean;
  listRef?: RefObject<HTMLUListElement | null>; onSelect: (index: number) => void; onOpen: (match: WorkspaceTextSearchMatch) => void;
}) {
  const counts = new Map<string, number>();
  for (const match of matches) counts.set(match.path, (counts.get(match.path) ?? 0) + 1);
  return <ul ref={listRef} id={listId} role="listbox" aria-label="Matching lines" aria-busy={loading} className={styles.results}>
    {matches.map((match, index) => {
      const parts = matchLineParts(match);
      const firstOfFile = index === 0 || matches[index - 1]?.path !== match.path;
      return <Fragment key={`${match.path}:${match.line}:${match.column}`}>
        {firstOfFile && <li role="presentation" className={styles.group}>
          <strong>{match.path}</strong><span>{counts.get(match.path)}</span>
        </li>}
        <li id={`${listId}-${index}`} role="option" aria-selected={index === selectedIndex} className={styles.result}
          title={`${match.path}:${match.line}:${match.column}`}
          onPointerMove={() => onSelect(index)} onMouseDown={event => event.preventDefault()} onClick={() => onOpen(match)}>
          <span className={styles.line}>{match.line}</span>
          <span className={styles.text}>{parts.before}<mark>{parts.matched}</mark>{parts.after}</span>
        </li>
      </Fragment>;
    })}
  </ul>;
}

export function WorkspaceTextSearch({ onOpenFile, onClose }: {
  onOpenFile: (path: string, line: number) => void; onClose: () => void;
}) {
  const [state, setState] = useState(initialTextSearchState);
  const controller = useRef<ReturnType<typeof createTextSearchController> | null>(null);
  const openedFile = useRef(false);
  const list = useRef<HTMLUListElement>(null);
  const listId = useId();
  useEffect(() => {
    const current = createTextSearchController(request => {
      if (!cheshiDesktop?.searchWorkspaceText) return Promise.reject(new Error('Text search is unavailable.'));
      return cheshiDesktop.searchWorkspaceText(request);
    }, setState);
    controller.current = current;
    return () => { current.dispose(); controller.current = null; };
  }, []);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [state.selectedIndex, state.result]);
  const openMatch = (match: WorkspaceTextSearchMatch | null) => {
    if (!match || state.loading) return;
    openedFile.current = true;
    onOpenFile(match.path, match.line);
    onClose();
  };
  return <Modal title="Find in Files" titleIcon={<TextSearch aria-hidden="true" />} className={styles.dialog}
    restoreFocus={() => !openedFile.current} onClose={onClose}>
    <div className={styles.content} onKeyDown={event => handleFileSearchKeyDown(event, {
      move: direction => controller.current?.move(direction),
      open: () => openMatch(selectedTextSearchMatch(state)), close: onClose,
    })}>
      <div className={styles.controls}>
        <NeumorphicTextField autoFocus type="search" role="combobox" aria-label="Find text in workspace files" className={styles.field}
          placeholder={state.options.regex ? 'Regular expression…' : 'Search text…'} value={state.query}
          maxLength={workspaceTextSearchQueryLimit} autoComplete="off" spellCheck={false}
          aria-controls={listId} aria-expanded={true} aria-autocomplete="list"
          aria-activedescendant={state.selectedIndex >= 0 ? `${listId}-${state.selectedIndex}` : undefined}
          onChange={event => controller.current?.changeQuery(event.target.value)} />
        <NeumorphicCheckbox checked={state.options.caseSensitive}
          onChange={event => controller.current?.changeOptions({ caseSensitive: event.target.checked })}>Match case</NeumorphicCheckbox>
        <NeumorphicCheckbox checked={state.options.regex}
          onChange={event => controller.current?.changeOptions({ regex: event.target.checked })}>Regex</NeumorphicCheckbox>
      </div>
      <WorkspaceTextSearchResults matches={textSearchMatches(state)} selectedIndex={state.selectedIndex} listId={listId} listRef={list}
        loading={state.loading} onSelect={index => controller.current?.select(index)} onOpen={openMatch} />
      <p role={state.error ? 'alert' : 'status'} className={styles.status}>{textSearchStatus(state)}</p>
      <p className={styles.hint}>↑↓ Navigate · Enter Open · Esc Close</p>
    </div>
  </Modal>;
}
