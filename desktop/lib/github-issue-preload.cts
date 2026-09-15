import type { IpcRenderer } from 'electron';
import { parseIssueNumber, parseIssuePage, parseIssueQuery, type GitHubIssuesApi } from '../shared/github-issues.ts';

export function createGitHubIssuesApi(ipc: Pick<IpcRenderer, 'invoke'>): GitHubIssuesApi {
  return {
    list: query => ipc.invoke('cheshi:list-github-issues', parseIssueQuery(query)),
    read: number => ipc.invoke('cheshi:read-github-issue', parseIssueNumber(number)),
    comments: (number, page) => ipc.invoke('cheshi:read-github-issue-comments', parseIssueNumber(number), parseIssuePage(page)),
    async open(number) { await ipc.invoke('cheshi:open-github-issue', parseIssueNumber(number)); },
  };
}
