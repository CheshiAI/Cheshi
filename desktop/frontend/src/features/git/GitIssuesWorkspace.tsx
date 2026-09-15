import { useRef, useState } from 'react';
import { CircleDot, CircleCheck, ExternalLink, Search } from 'lucide-react';
import { cheshiDesktop } from '../../cheshiDesktop';
import { FilterTab, FilterTabList, LiquidGlassPanel, LoadingState, NeumorphicButton, NeumorphicTextField, SearchClearButton } from '../../shared/ui';
import type { GitHubIssueState } from '../../../../shared/github-issues';
import { useGitIssues } from './useGitIssues';
import { formatGitDate } from './gitWorkspaceModel';
import styles from './GitIssuesWorkspace.module.css';

export function GitIssuesWorkspace({ revision }: { revision: number }) {
  const searchInput = useRef<HTMLInputElement>(null);
  const [input, setInput] = useState('');
  const [search, setSearch] = useState('');
  const [state, setState] = useState<GitHubIssueState>('open');
  const issues = useGitIssues(cheshiDesktop?.githubIssues, { search, state }, revision);
  const { list, detail, selected } = issues;
  return (
    <section className={styles.workspace} aria-label="GitHub issues">
      <div className={styles.toolbar}>
        <form className={styles.search} onSubmit={event => { event.preventDefault(); setSearch(input.trim()); }}>
          <Search className={styles.searchIcon} aria-hidden="true" />
          <NeumorphicTextField ref={searchInput} className={styles.searchField} type="search" aria-label="Search issue titles and bodies" placeholder="Search issues…" maxLength={200}
            value={input} onChange={event => setInput(event.target.value)}
            trailingAction={input || search ? <SearchClearButton aria-label="Clear issue search" onClick={() => {
              setInput(''); setSearch(''); searchInput.current?.focus();
            }} /> : undefined} />
        </form>
        <FilterTabList aria-label="Issue state">
          {(['open', 'closed', 'all'] as const).map(value => <FilterTab key={value} active={state === value}
            badge={issues.counts && issues.counts[value] > 0 ? issues.counts[value] : undefined}
            aria-pressed={state === value} onClick={() => setState(value)}>{value === 'all' ? 'All' : value === 'open' ? 'Open' : 'Closed'}</FilterTab>)}
        </FilterTabList>
      </div>
      <div className={styles.split}>
        <LiquidGlassPanel as="section" className={styles.list} aria-label="Issue list" aria-busy={issues.loading}>
          {issues.error && <div role="alert" className={styles.message}><p>{issues.error}</p>
            <NeumorphicButton raised size="standard" onClick={() => void issues.loadMore()} disabled={issues.loading}>Retry</NeumorphicButton></div>}
          {issues.loading && !list && <LoadingState className={styles.centeredState} />}
          {list && !issues.loading && list.issues.length === 0 && <p className={`${styles.message} ${styles.centeredState}`}>No issues match this search.</p>}
          {list?.issues.map(issue => <button type="button" className={styles.row} data-selected={selected === issue.number}
            aria-pressed={selected === issue.number} key={issue.number} onClick={() => issues.setSelected(issue.number)}>
            {issue.state === 'open' ? <CircleDot aria-label="Open" /> : <CircleCheck aria-label="Closed" />}
            <span className={styles.rowContent}><strong>#{issue.number} {issue.title}</strong>
              <span className={`${styles.meta} ${styles.issueMeta}`}>
                <span>{issue.author}</span>
                <time dateTime={issue.updatedAt}>{formatGitDate(issue.updatedAt)}</time>
              </span>
              {issue.labels.length > 0 && <span className={styles.labels}>{issue.labels.map(label => <span key={label}>{label}</span>)}</span>}
              {issue.assignees.length > 0 && <span className={styles.meta}>Assigned to {issue.assignees.join(', ')}</span>}
            </span>
          </button>)}
          {issues.loading && list && <LoadingState className={styles.message} />}
          {list?.hasMore && <NeumorphicButton raised size="standard" className={styles.more} disabled={issues.loading}
            onClick={() => void issues.loadMore()}>Load more issues</NeumorphicButton>}
          {list?.incomplete && <p className={styles.message}>Results may be incomplete. Narrow your search to see more matching issues.</p>}
        </LiquidGlassPanel>
        <LiquidGlassPanel as="section" className={styles.detail} aria-label="Issue details" aria-busy={issues.detailLoading}>
          {selected === null && <p className={`${styles.message} ${styles.centeredState}`}>Select an issue to view its description and comments.</p>}
          {issues.detailLoading && <LoadingState className={!detail ? styles.centeredState : styles.message} />}
          {issues.detailError && <div role="alert" className={styles.message}><p>{issues.detailError}</p>
            <NeumorphicButton raised size="standard" disabled={issues.detailLoading} onClick={() => void issues.retryDetail()}>Retry</NeumorphicButton></div>}
          {detail && <>
            <header className={styles.detailHeader}><h2>#{detail.number} {detail.title}</h2>
              <NeumorphicButton raised size="icon" aria-label="Open issue on GitHub" title="Open on GitHub" onClick={() => void issues.open()}>
                <ExternalLink aria-hidden="true" /></NeumorphicButton></header>
            <p className={styles.meta}>{detail.state === 'open' ? 'Open' : 'Closed'} · {detail.author} · Updated {formatGitDate(detail.updatedAt)}</p>
            <div className={styles.body}>{detail.body || 'No description provided.'}</div>
            <h3>Comments · {detail.commentCount}</h3>
            {issues.comments.map(comment => <article key={comment.id} className={styles.comment}>
              <p className={styles.meta}>{comment.author} · {formatGitDate(comment.createdAt)}</p><div className={styles.body}>{comment.body}</div>
            </article>)}
            {issues.commentsLoading && <LoadingState />}
            {issues.commentsError && <div role="alert"><p>{issues.commentsError}</p>
              <NeumorphicButton raised size="standard" disabled={issues.commentsLoading} onClick={() => void issues.loadComments()}>Retry comments</NeumorphicButton></div>}
            {issues.commentsMore && <NeumorphicButton raised size="standard" disabled={issues.commentsLoading}
              onClick={() => void issues.loadComments()}>Load more comments</NeumorphicButton>}
            {issues.commentPage === 40 && detail.commentCount > issues.comments.length && <p>Open this issue on GitHub to read the remaining comments.</p>}
          </>}
        </LiquidGlassPanel>
      </div>
    </section>
  );
}
