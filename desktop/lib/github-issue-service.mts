import {
  GITHUB_ISSUE_PAGE_SIZE, parseIssueNumber, parseIssuePage, parseIssueQuery,
  type GitHubIssueSummary, type GitHubIssueDetail, type GitHubIssueList, type GitHubIssueComments, type GitHubIssueQuery,
} from '../shared/github-issues.ts';
import type { CommandResult, GitCommandOptions } from './git-types.mts';

interface IssueContext { runGitHub(args: string[], options?: GitCommandOptions): Promise<CommandResult> }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('GitHub returned an invalid response.');
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== 'string') throw new Error('GitHub returned invalid text.');
  return value;
}
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('GitHub returned an invalid count.');
  return value;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('GitHub returned an invalid list.');
  return value;
}
function author(value: unknown): string { return value === null ? 'ghost' : string(record(value).login); }
async function json(context: IssueContext, args: string[]): Promise<unknown> {
  const result = await context.runGitHub(args);
  if (result.truncated) throw new Error('The GitHub response is too large. Narrow the search and try again.');
  return JSON.parse(result.stdout);
}
async function repository(context: IssueContext): Promise<string> {
  const value = record(await json(context, ['repo', 'view', '--json', 'nameWithOwner,url']));
  const name = string(value.nameWithOwner);
  if (!/^[\w.-]+\/[\w.-]+$/.test(name) || value.url !== `https://github.com/${name}`) {
    throw new Error('A GitHub.com repository is required to browse issues.');
  }
  return name;
}
function summary(value: unknown, repo: string): GitHubIssueSummary {
  const issue = record(value);
  const number = parseIssueNumber(issue.number);
  if (issue.pull_request !== undefined || issue.html_url !== `https://github.com/${repo}/issues/${number}`
    || (issue.state !== 'open' && issue.state !== 'closed')) throw new Error('GitHub returned an unexpected issue.');
  return {
    number, title: string(issue.title), state: issue.state, author: author(issue.user), updatedAt: string(issue.updated_at),
    labels: array(issue.labels).map(label => typeof label === 'string' ? label : string(record(label).name)),
    assignees: array(issue.assignees).map(author),
  };
}
function api(endpoint: string, fields: string[] = []): string[] {
  return ['api', '--hostname', 'github.com', '--method', 'GET', endpoint, ...fields.flatMap(field => ['-f', field])];
}
async function searchIssues(context: IssueContext, repo: string, query: GitHubIssueQuery, pageSize: number) {
  const search = [`repo:${repo}`, 'is:issue', query.state === 'all' ? '' : `is:${query.state}`,
    query.search ? `${JSON.stringify(query.search)} in:title,body` : ''].filter(Boolean).join(' ');
  return record(await json(context, api('search/issues', [
    `q=${search}`, 'sort=updated', 'order=desc', `per_page=${pageSize}`, `page=${query.page}`,
  ])));
}
function searchCount(result: Record<string, unknown>) {
  const total = count(result.total_count);
  if (typeof result.incomplete_results !== 'boolean') throw new Error('GitHub returned an invalid search status.');
  return { total, incomplete: result.incomplete_results };
}
export async function listGitHubIssues(context: IssueContext, request: unknown): Promise<GitHubIssueList> {
  const query = parseIssueQuery(request);
  const repo = await repository(context);
  const result = await searchIssues(context, repo, query, GITHUB_ISSUE_PAGE_SIZE);
  const { total, incomplete } = searchCount(result);
  const issues = array(result.items).map(item => summary(item, repo));
  let counts: GitHubIssueList['counts'] = null;
  let countsIncomplete = false;
  if (query.page === 1) {
    const countForState = async (state: 'open' | 'closed') =>
      state === query.state ? { total, incomplete }
        : searchCount(await searchIssues(context, repo, { ...query, state }, 1));
    const [open, closed] = await Promise.all([countForState('open'), countForState('closed')]);
    countsIncomplete = open.incomplete || closed.incomplete;
    if (!countsIncomplete) counts = { open: open.total, closed: closed.total, all: open.total + closed.total };
  }
  return { repository: repo, issues, total, hasMore: query.page * GITHUB_ISSUE_PAGE_SIZE < Math.min(total, 1000),
    incomplete: incomplete || countsIncomplete || total > 1000, counts };
}
export async function readGitHubIssue(context: IssueContext, value: unknown): Promise<GitHubIssueDetail> {
  const number = parseIssueNumber(value);
  const repo = await repository(context);
  const result = record(await json(context, api(`repos/${repo}/issues/${number}`)));
  const issue = summary(result, repo);
  if (issue.number !== number) throw new Error('GitHub returned a different issue.');
  return { ...issue, body: result.body === null ? '' : string(result.body), commentCount: count(result.comments) };
}
export async function readGitHubIssueComments(context: IssueContext, value: unknown, pageValue: unknown): Promise<GitHubIssueComments> {
  const number = parseIssueNumber(value);
  const page = parseIssuePage(pageValue);
  const repo = await repository(context);
  const result = array(await json(context, api(`repos/${repo}/issues/${number}/comments`, [
    `per_page=${GITHUB_ISSUE_PAGE_SIZE}`, `page=${page}`,
  ])));
  const comments = result.map(value => {
    const comment = record(value);
    return { id: parseIssueNumber(comment.id), author: author(comment.user),
      body: comment.body === null ? '' : string(comment.body), createdAt: string(comment.created_at) };
  });
  return { comments, hasMore: comments.length === GITHUB_ISSUE_PAGE_SIZE && page < 40 };
}
export async function gitHubIssueUrl(context: IssueContext, value: unknown): Promise<string> {
  const number = parseIssueNumber(value);
  return `https://github.com/${await repository(context)}/issues/${number}`;
}
