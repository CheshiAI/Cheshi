import { TooltipTarget } from '../../shared/ui/TooltipTarget';
import { TooltipButton } from '../../shared/ui/TooltipButton';
import { Search } from 'lucide-react';
import { useRef } from 'react';

import { NeumorphicTextField, SearchClearButton } from '../../shared/ui';
import styles from './ChatHistorySearch.module.css';

interface ChatHistorySearchBarProps {
  query: string;
  disabled: boolean;
  onQueryChange: (value: string) => void;
  onSubmit: () => void;
  onFocus: () => void;
}

export function ChatHistorySearchBar({ query, disabled, onQueryChange, onSubmit, onFocus }: ChatHistorySearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const searchDescription = 'Search messages, tool activity, and file paths';

  return <form className={styles.searchBar} role="search" aria-label="Conversation search"
    onSubmit={(event) => {
      event.preventDefault();
      if (!disabled && query.trim()) onSubmit();
    }}>
    <TooltipTarget content={searchDescription}><NeumorphicTextField variant="standard" ref={inputRef} className={styles.searchField} type="search"
      value={query} maxLength={500} disabled={disabled} placeholder="Search…"
      aria-label={searchDescription}
      onFocus={onFocus} onChange={(event) => onQueryChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault();
      }}
      trailingAction={query ? <SearchClearButton variant="ghost" aria-label="Clear search" title="Clear search" disabled={disabled}
        onClick={() => {
          onQueryChange('');
          inputRef.current?.focus();
        }} /> : undefined} /></TooltipTarget>
    <TooltipButton raised size="icon" className={styles.searchSubmit} type="submit"
      disabled={disabled || !query.trim()} aria-label="Search conversations" title={searchDescription}>
      <Search aria-hidden="true" />
    </TooltipButton>
  </form>;
}
