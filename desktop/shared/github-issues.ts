export type GitHubIssueState = 'open' | 'closed' | 'all';
export type GitHubIssueCounts = Record<GitHubIssueState, number>;
export interface GitHubIssueQuery { search: string; state: GitHubIssueState; page: number }
export interface GitHubIssueSummary {
  number: number;
  title: string;
  state: 'open' | 'closed';
  author: string;
  updatedAt: string;
  labels: string[];
  assignees: string[];
}
export interface GitHubIssueDetail extends GitHubIssueSummary { body: string; commentCount: number }
export interface GitHubIssueComment { id: number; author: string; body: string; createdAt: string }
export interface GitHubIssueList {
  repository: string;
  issues: GitHubIssueSummary[];
  total: number;
  hasMore: boolean;
  incomplete: boolean;
  counts: GitHubIssueCounts | null;
}
export interface GitHubIssueComments { comments: GitHubIssueComment[]; hasMore: boolean }
export interface GitHubIssuesApi {
  list(query: GitHubIssueQuery): Promise<GitHubIssueList>;
  read(number: number): Promise<GitHubIssueDetail>;
  comments(number: number, page: number): Promise<GitHubIssueComments>;
  open(number: number): Promise<void>;
}
export const GITHUB_ISSUE_PAGE_SIZE = 25;
export function parseIssueNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new TypeError('Invalid issue number.');
  return value;
}
export function parseIssuePage(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 40) throw new TypeError('Invalid issue page.');
  return value;
}
export function parseIssueQuery(value: unknown): GitHubIssueQuery {
  if (!value || typeof value !== 'object') throw new TypeError('Invalid issue query.');
  const query = value as Record<string, unknown>;
  if (typeof query.search !== 'string' || query.search.length > 200 || /[\x00-\x1f]/.test(query.search)
    || (query.state !== 'open' && query.state !== 'closed' && query.state !== 'all')) throw new TypeError('Invalid issue query.');
  return { search: query.search.trim(), state: query.state as GitHubIssueState, page: parseIssuePage(query.page) };
}
