import { Search } from 'lucide-react';
import { useRef } from 'react';

import { NeumorphicButton, NeumorphicTextField, SearchClearButton } from '../../shared/ui';
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
    <NeumorphicTextField ref={inputRef} className={styles.searchField} type="search"
      value={query} maxLength={500} disabled={disabled} placeholder="Search…"
      aria-label={searchDescription} title={searchDescription}
      onFocus={onFocus} onChange={(event) => onQueryChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault();
      }}
      trailingAction={query ? <SearchClearButton aria-label="Clear search" title="Clear search" disabled={disabled}
        onClick={() => {
          onQueryChange('');
          inputRef.current?.focus();
        }} /> : undefined} />
    <NeumorphicButton raised size="icon" className={styles.searchSubmit} type="submit"
      disabled={disabled || !query.trim()} aria-label="Search conversations" title={searchDescription}>
      <Search aria-hidden="true" />
    </NeumorphicButton>
  </form>;
}
