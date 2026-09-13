import {
  CaseSensitive,
  ChevronDown,
  ChevronUp,
  Regex,
  Replace,
  ReplaceAll,
  Search,
  WholeWord,
  X,
} from 'lucide-react';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  RefObject,
} from 'react';

import {
  NeumorphicButton,
  NeumorphicTextField,
  SearchClearButton,
  nonDraggableWindowRegionStyle,
} from '../../shared/ui';
import type { EditorSearchControls } from './codeEditorSearch';

interface WorkspaceEditorSearchPanelProps {
  controls: EditorSearchControls;
  inputRef: RefObject<HTMLInputElement | null>;
  queryValid: boolean;
  onChange: (update: Partial<EditorSearchControls>) => void;
  onNext: () => void;
  onPrevious: () => void;
  onSelectAll: () => void;
  onReplace: () => void;
  onReplaceAll: () => void;
  onClose: () => void;
}

export function WorkspaceEditorSearchPanel({
  controls,
  inputRef,
  queryValid,
  onChange,
  onNext,
  onPrevious,
  onSelectAll,
  onReplace,
  onReplaceAll,
  onClose,
}: WorkspaceEditorSearchPanelProps) {
  const handleSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Enter' || !queryValid) return;
    event.preventDefault();
    if (event.shiftKey) onPrevious();
    else onNext();
  };

  return (
    <section
      id="workspace-editor-search"
      className="workspace-editor-search"
      aria-label="Find and replace"
      style={nonDraggableWindowRegionStyle}
    >
      <div className="workspace-editor-search-row">
        <Search aria-hidden="true" />
        <NeumorphicTextField
          ref={inputRef}
          className="workspace-editor-search-input"
          name="search"
          value={controls.search}
          placeholder="Find"
          aria-label="Find"
          onChange={(event) => onChange({ search: event.target.value })}
          onKeyDown={handleSearchKeyDown}
          trailingAction={controls.search ? (
            <SearchClearButton
              aria-label="Clear find text"
              onClick={() => {
                onChange({ search: '' });
                requestAnimationFrame(() => inputRef.current?.focus());
              }}
            />
          ) : undefined}
        />
        <NeumorphicButton active={controls.caseSensitive} className="neumorphic-surface workspace-editor-search-option" aria-label="Match case" aria-pressed={controls.caseSensitive} onClick={() => onChange({ caseSensitive: !controls.caseSensitive })}>
          <CaseSensitive aria-hidden="true" />
        </NeumorphicButton>
        <NeumorphicButton active={controls.wholeWord} className="neumorphic-surface workspace-editor-search-option" aria-label="Match whole word" aria-pressed={controls.wholeWord} onClick={() => onChange({ wholeWord: !controls.wholeWord })}>
          <WholeWord aria-hidden="true" />
        </NeumorphicButton>
        <NeumorphicButton active={controls.regexp} className="neumorphic-surface workspace-editor-search-option" aria-label="Use regular expression" aria-pressed={controls.regexp} onClick={() => onChange({ regexp: !controls.regexp })}>
          <Regex aria-hidden="true" />
        </NeumorphicButton>
        <NeumorphicButton className="neumorphic-surface workspace-editor-search-option" aria-label="Previous match" disabled={!queryValid} onClick={onPrevious}>
          <ChevronUp aria-hidden="true" />
        </NeumorphicButton>
        <NeumorphicButton className="neumorphic-surface workspace-editor-search-option" aria-label="Next match" disabled={!queryValid} onClick={onNext}>
          <ChevronDown aria-hidden="true" />
        </NeumorphicButton>
        <NeumorphicButton className="neumorphic-surface workspace-editor-search-option" aria-label="Select all matches" disabled={!queryValid} onClick={onSelectAll}>
          <span aria-hidden="true">All</span>
        </NeumorphicButton>
        <NeumorphicButton className="neumorphic-surface workspace-editor-search-option workspace-editor-search-close" aria-label="Close find and replace" onClick={onClose}>
          <X aria-hidden="true" />
        </NeumorphicButton>
      </div>
      <div className="workspace-editor-search-row">
        <Replace aria-hidden="true" />
        <NeumorphicTextField
          className="workspace-editor-search-input"
          name="replace"
          value={controls.replace}
          placeholder="Replace"
          aria-label="Replace"
          onChange={(event) => onChange({ replace: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              onClose();
            }
          }}
        />
        <NeumorphicButton className="neumorphic-surface workspace-editor-search-action" disabled={!queryValid} onClick={onReplace}>
          <Replace aria-hidden="true" />
          Replace
        </NeumorphicButton>
        <NeumorphicButton className="neumorphic-surface workspace-editor-search-action" disabled={!queryValid} onClick={onReplaceAll}>
          <ReplaceAll aria-hidden="true" />
          Replace all
        </NeumorphicButton>
      </div>
    </section>
  );
}
