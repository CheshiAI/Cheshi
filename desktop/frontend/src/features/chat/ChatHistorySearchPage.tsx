import { ArrowLeft, PanelRight, RefreshCw, Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import type { ChatHistorySearchHit, ChatHistorySearchResponse } from '../../../../shared/chat-history-search';
import { errorMessage } from '../../shared/errorMessage';
import { SidebarToggle, LoadingState, NeumorphicButton, TieredHeader, draggableWindowRegionStyle, nonDraggableWindowRegionStyle } from '../../shared/ui';
import styles from './ChatHistorySearch.module.css';

const kindLabels = { user: 'You', assistant: 'Assistant', activity: 'Tool activity', plan: 'Plan' };
const fileLabels = { mentioned: 'Mentioned', changed: 'Changed', read: 'Read' };
const FILE_PREVIEW_LIMIT = 5;

export function ChatHistorySearchResults({ result, disabled, onOpen }: {
  result: ChatHistorySearchResponse;
  disabled: boolean;
  onOpen: (hit: ChatHistorySearchHit) => void;
}) {
  const partial = result.unavailableSessions.length > 0;

  return <section className={styles.results} aria-label="Chat search results">
    <p className={styles.status} role="status">
      {result.hits.length} of {result.total} matches · {result.indexedSessions} conversations searched
    </p>
    {partial && <p className={styles.notice} role="status">
      {result.unavailableSessions.length} conversations could not be searched. Refresh to retry.
    </p>}
    {result.hits.length === 0 && <div className={styles.emptyState}>
      <Search aria-hidden="true" />
      <h2>{partial ? 'No matches in the available conversations.' : 'No matching messages or file references.'}</h2>
      <p>Try another word, filename, or file path.</p>
    </div>}
    {result.hits.length > 0 && <ul className={styles.resultList}>
      {result.hits.map((hit) => <li key={JSON.stringify([hit.threadId, hit.turnId, hit.itemId])}>
        <button type="button" className={styles.hit} disabled={disabled}
          onClick={() => onOpen(hit)} aria-label={`Open original message: ${hit.title}`}>
          <span className={styles.hitHeading}><strong>{hit.title}</strong><span>{kindLabels[hit.kind]}</span></span>
          <span className={styles.snippet}>{hit.snippet}</span>
          {hit.files.length > 0 && <span className={styles.files}>
            {hit.files.slice(0, FILE_PREVIEW_LIMIT).map((file) =>
              <span key={`${file.kind}:${file.path}`} title={file.path}>{fileLabels[file.kind]} · {file.path}</span>)}
            {hit.files.length > FILE_PREVIEW_LIMIT && <span>+{hit.files.length - FILE_PREVIEW_LIMIT} more file references in the original message</span>}
          </span>}
          <span className={styles.source} title={`Turn ${hit.turnId}`}>
            Turn {hit.turnId}{hit.duplicateCount > 0 && ` · +${hit.duplicateCount} ${hit.duplicateCount === 1 ? 'copy' : 'copies'}`}
          </span>
        </button>
      </li>)}
    </ul>}
  </section>;
}

interface ChatHistorySearchPageProps {
  query: string;
  result: ChatHistorySearchResponse | null;
  loading: boolean;
  error: string | null;
  selectionDisabled: boolean;
  onOpen: (hit: ChatHistorySearchHit) => Promise<boolean>;
  onRefresh: () => void;
  onClose: () => void;
  rightSidebarOpen: boolean;
  onToggleRightSidebar: () => void;
}

export function ChatHistorySearchPage({ query, result, loading, error, selectionDisabled, onOpen, onRefresh,
  onClose, rightSidebarOpen, onToggleRightSidebar }: ChatHistorySearchPageProps) {
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const pending = useRef(false);
  const requestId = useRef(0);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    requestId.current += 1;
    pending.current = false;
    setOpening(false);
    setOpenError(null);
  }, [query, result]);

  const open = async (hit: ChatHistorySearchHit) => {
    if (pending.current || selectionDisabled || loading) return;
    const currentRequestId = ++requestId.current;
    const isCurrent = () => mounted.current && requestId.current === currentRequestId;
    pending.current = true;
    setOpening(true);
    setOpenError(null);
    try {
      const opened = await onOpen(hit);
      if (isCurrent() && !opened) setOpenError('Could not open the original conversation. Refresh the results and try again.');
    } catch (reason) {
      if (isCurrent()) setOpenError(errorMessage(reason));
    } finally {
      if (isCurrent()) {
        pending.current = false;
        setOpening(false);
      }
    }
  };

  return <main className={styles.page} aria-label="Conversation search page">
    <TieredHeader className={styles.header} style={draggableWindowRegionStyle} primary={<>
      <div className={styles.title}><Search aria-hidden="true" /><h1>Search</h1></div>
      <div className={styles.headerActions} style={nonDraggableWindowRegionStyle}>
        <NeumorphicButton raised size="icon" aria-label="Refresh chat search" title="Refresh conversation history"
          disabled={!query.trim() || opening || loading} onClick={onRefresh}>
          <RefreshCw aria-hidden="true" />
        </NeumorphicButton>
        <NeumorphicButton raised size="icon" aria-label="Back to workspace" title="Back to workspace"
          disabled={opening} onClick={() => { if (!pending.current) onClose(); }}>
          <ArrowLeft aria-hidden="true" />
        </NeumorphicButton>
        <SidebarToggle raised size="icon" aria-label={rightSidebarOpen ? 'Close right sidebar' : 'Open right sidebar'}
          aria-expanded={rightSidebarOpen} onClick={onToggleRightSidebar}>
          <PanelRight aria-hidden="true" />
        </SidebarToggle>
      </div>
    </>} />
    <div className={styles.content} aria-busy={loading || opening}>
      {query.trim() && <p className={styles.query}>Results for <strong>{query.trim()}</strong></p>}
      {loading && <LoadingState type="processing" label="Searching conversation history…" />}
      {opening && <LoadingState type="preparing" label="Opening original message…" />}
      {(error || openError) && <p className={styles.notice} role="alert">{error || openError}</p>}
      {!result && !loading && !error && <div className={styles.emptyState}>
        <Search aria-hidden="true" />
        <h2>Search conversations</h2>
        <p>Find messages, tool activity, and file paths from this workspace.</p>
        <p>Enter a search in the sidebar, then press Enter.</p>
      </div>}
      {result && <ChatHistorySearchResults result={result} disabled={opening || selectionDisabled || loading}
        onOpen={(hit) => { void open(hit); }} />}
    </div>
  </main>;
}
