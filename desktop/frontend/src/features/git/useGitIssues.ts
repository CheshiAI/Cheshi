import { useCallback, useEffect, useRef, useState } from 'react';
import type { GitHubIssuesApi, GitHubIssueQuery, GitHubIssueList, GitHubIssueDetail, GitHubIssueComment, GitHubIssueCounts } from '../../../../shared/github-issues';
import { errorMessage } from '../../shared/errorMessage';

interface CachedIssueList { list: GitHubIssueList; page: number }
interface CachedIssueDetail {
  detail: GitHubIssueDetail;
  comments: GitHubIssueComment[];
  commentPage: number;
  commentsMore: boolean;
  commentsError: string | null;
}
const MAX_CACHED_ISSUE_QUERIES = 30;
const MAX_CACHED_ISSUE_DETAILS = 30;
function rememberEntry<K, V>(entries: Map<K, V>, key: K, value: V, limit: number) {
  entries.delete(key);
  entries.set(key, value);
  if (entries.size > limit) {
    const oldest = entries.keys().next();
    if (!oldest.done) entries.delete(oldest.value);
  }
}

export function useGitIssues(api: GitHubIssuesApi | undefined, query: Omit<GitHubIssueQuery, 'page'>, revision: number) {
  const cacheKey = JSON.stringify([revision, query.search, query.state]);
  const cache = useRef({ api, revision, entries: new Map<string, CachedIssueList>(), details: new Map<number, CachedIssueDetail>() });
  const cacheMatches = cache.current.api === api && cache.current.revision === revision;
  const cached = cacheMatches ? cache.current.entries.get(cacheKey) : undefined;
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [list, setList] = useState<GitHubIssueList | null>(null);
  const [countSnapshot, setCountSnapshot] = useState<{ search: string; revision: number; counts: GitHubIssueCounts | null } | null>(null);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [activeDetail, setActiveDetail] = useState<number | null>(null);
  const [detail, setDetail] = useState<GitHubIssueDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [comments, setComments] = useState<GitHubIssueComment[]>([]);
  const [commentPage, setCommentPage] = useState(0);
  const [commentsMore, setCommentsMore] = useState(false);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [commentsError, setCommentsError] = useState<string | null>(null);
  const listGeneration = useRef(0);
  const detailGeneration = useRef(0);
  const listBusy = useRef(false);
  const commentsBusy = useRef(false);

  const fetchList = useCallback(async (nextPage: number, generation: number) => {
    if (!api || listBusy.current) return;
    listBusy.current = true;
    setLoading(true); setError(null);
    try {
      const result = await api.list({ ...query, page: nextPage });
      if (generation !== listGeneration.current) return;
      if (nextPage === 1) setCountSnapshot({ search: query.search, revision, counts: result.counts });
      const previous = cache.current.entries.get(cacheKey)?.list;
      const next = { ...result, counts: nextPage === 1 ? result.counts : previous?.counts ?? null,
        issues: nextPage === 1 ? result.issues : [...(previous?.issues ?? []), ...result.issues]
        .filter((issue, index, items) => items.findIndex(item => item.number === issue.number) === index) };
      rememberEntry(cache.current.entries, cacheKey, { list: next, page: nextPage }, MAX_CACHED_ISSUE_QUERIES);
      setList(next);
      setPage(nextPage);
    } catch (error) {
      if (generation === listGeneration.current) setError(errorMessage(error));
    } finally {
      if (generation === listGeneration.current) { listBusy.current = false; setLoading(false); }
    }
  }, [api, query.search, query.state, revision, cacheKey]);

  useEffect(() => {
    const generation = ++listGeneration.current;
    listBusy.current = false;
    if (cache.current.api !== api || cache.current.revision !== revision) {
      cache.current = { api, revision, entries: new Map(), details: new Map() };
    }
    const entry = cache.current.entries.get(cacheKey);
    if (entry) rememberEntry(cache.current.entries, cacheKey, entry, MAX_CACHED_ISSUE_QUERIES);
    setActiveKey(cacheKey); setList(entry?.list ?? null); setPage(entry?.page ?? 0);
    setSelected(null); setError(null); setLoading(false);
    if (entry) return () => { ++listGeneration.current; };
    if (api) void fetchList(1, generation);
    else setError('GitHub issue browsing is unavailable. Restart the app and try again.');
    return () => { ++listGeneration.current; };
  }, [api, fetchList, revision, cacheKey]);

  const fetchComments = useCallback(async (number: number, nextPage: number, generation: number) => {
    if (!api || commentsBusy.current) return;
    commentsBusy.current = true; setCommentsLoading(true); setCommentsError(null);
    try {
      const result = await api.comments(number, nextPage);
      if (generation !== detailGeneration.current) return;
      const entry = cache.current.details.get(number);
      if (!entry) return;
      const nextComments = [...(nextPage === 1 ? [] : entry.comments), ...result.comments]
        .filter((comment, index, items) => items.findIndex(item => item.id === comment.id) === index);
      rememberEntry(cache.current.details, number, { ...entry, comments: nextComments, commentPage: nextPage,
        commentsMore: result.hasMore, commentsError: null }, MAX_CACHED_ISSUE_DETAILS);
      setComments(nextComments); setCommentPage(nextPage); setCommentsMore(result.hasMore);
    } catch (error) {
      if (generation === detailGeneration.current) {
        const message = errorMessage(error);
        const entry = cache.current.details.get(number);
        if (entry) rememberEntry(cache.current.details, number, { ...entry, commentsError: message }, MAX_CACHED_ISSUE_DETAILS);
        setCommentsError(message);
      }
    } finally {
      if (generation === detailGeneration.current) { commentsBusy.current = false; setCommentsLoading(false); }
    }
  }, [api]);

  const fetchDetail = useCallback(async (number: number, generation: number) => {
    if (!api) return;
    setDetailLoading(true); setDetailError(null);
    try {
      const result = await api.read(number);
      if (generation !== detailGeneration.current) return;
      rememberEntry(cache.current.details, number, { detail: result, comments: [], commentPage: 0,
        commentsMore: false, commentsError: null }, MAX_CACHED_ISSUE_DETAILS);
      setDetail(result); setComments([]); setCommentPage(0); setCommentsMore(false); setCommentsError(null);
      if (result.commentCount > 0) void fetchComments(number, 1, generation);
    } catch (error) {
      if (generation === detailGeneration.current) setDetailError(errorMessage(error));
    } finally {
      if (generation === detailGeneration.current) setDetailLoading(false);
    }
  }, [api, fetchComments]);

  useEffect(() => {
    const generation = ++detailGeneration.current;
    commentsBusy.current = false;
    const entry = selected !== null && activeKey === cacheKey ? cache.current.details.get(selected) : undefined;
    setActiveDetail(selected); setDetail(entry?.detail ?? null); setDetailError(null);
    setComments(entry?.comments ?? []); setCommentPage(entry?.commentPage ?? 0);
    setCommentsMore(entry?.commentsMore ?? false); setCommentsLoading(false);
    setCommentsError(entry?.commentsError ?? null); setDetailLoading(false);
    if (selected !== null && activeKey === cacheKey) {
      if (entry) {
        rememberEntry(cache.current.details, selected, entry, MAX_CACHED_ISSUE_DETAILS);
        if (entry.detail.commentCount > 0 && entry.commentPage === 0 && !entry.commentsError) {
          void fetchComments(selected, 1, generation);
        }
      } else void fetchDetail(selected, generation);
    }
    return () => { ++detailGeneration.current; };
  }, [selected, fetchDetail, fetchComments, activeKey, cacheKey]);

  const open = async () => {
    if (!api || selected === null) return;
    const generation = detailGeneration.current;
    try { await api.open(selected); }
    catch (error) { if (generation === detailGeneration.current) setDetailError(errorMessage(error)); }
  };
  const visibleSelected = cacheMatches && activeKey === cacheKey ? selected : null;
  const savedDetail = visibleSelected === null ? undefined : cache.current.details.get(visibleSelected);
  const detailIsCurrent = visibleSelected !== null && activeDetail === visibleSelected;
  return {
    counts: cacheMatches && countSnapshot?.search === query.search && countSnapshot.revision === revision
      ? countSnapshot.counts : cached?.list.counts ?? null,
    list: cacheMatches && activeKey === cacheKey ? list : cached?.list ?? null,
    loading: cacheMatches && activeKey === cacheKey ? loading : !cached && !!api,
    error: cacheMatches && activeKey === cacheKey ? error : null,
    selected: visibleSelected, setSelected,
    detail: detailIsCurrent ? detail : savedDetail?.detail ?? null,
    detailLoading: detailIsCurrent ? detailLoading : visibleSelected !== null && !savedDetail,
    detailError: detailIsCurrent ? detailError : null,
    comments: detailIsCurrent ? comments : savedDetail?.comments ?? [],
    commentsLoading: detailIsCurrent ? commentsLoading : false,
    commentsError: detailIsCurrent ? commentsError : savedDetail?.commentsError ?? null,
    commentsMore: detailIsCurrent ? commentsMore : savedDetail?.commentsMore ?? false,
    commentPage: detailIsCurrent ? commentPage : savedDetail?.commentPage ?? 0, open,
    loadMore: () => fetchList((activeKey === cacheKey ? page : cached?.page ?? 0) + 1, listGeneration.current),
    retryDetail: () => selected === null ? undefined : fetchDetail(selected, detailGeneration.current),
    loadComments: () => selected === null ? undefined : fetchComments(selected, commentPage + 1, detailGeneration.current),
  };
}
