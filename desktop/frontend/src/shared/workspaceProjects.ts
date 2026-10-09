import { useEffect, useState } from 'react';
import { cheshiDesktop, type CheshiDesktopApi } from '../cheshiDesktop';
import type { WorkspaceProject } from '../../../shared/workspace-projects';

export const primaryProject: WorkspaceProject = { id: 'primary', name: cheshiDesktop?.workspaceName ?? 'Workspace',
  rootPath: cheshiDesktop?.workspaceRoot ?? '', primary: true, available: true };

export function useWorkspaceProjects(desktop = cheshiDesktop) {
  const [projects, setProjects] = useState<WorkspaceProject[]>([{ ...primaryProject, name: desktop?.workspaceName ?? primaryProject.name, rootPath: desktop?.workspaceRoot ?? primaryProject.rootPath }]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const api = desktop?.workspaceProjects;
    if (!api) return;
    let stopped = false;
    let revision = 0;
    const refresh = () => {
      const request = ++revision;
      void api.list().then(value => {
        if (!stopped && request === revision) { setProjects(value); setError(null); }
      }).catch(error => { if (!stopped && request === revision) setError(String(error)); });
    };
    const unsubscribe = api.onChanged(refresh);
    refresh();
    return () => { stopped = true; unsubscribe(); };
  }, [desktop]);
  return { projects, error };
}

const gitMethods = [
  'getGitSnapshot', 'getGitBranchCommits', 'getGitDiff', 'stageGitPaths', 'unstageGitPaths',
  'prepareGitDiscard', 'discardGitChanges', 'commitGitChanges', 'checkoutGitBranch', 'createGitBranch',
  'updateGitBranch', 'fetchGitRepository', 'pushGitCurrentBranch', 'listGitHubPullRequests',
  'getGitHubPullRequestDetails', 'getGitHubPullRequestDiff', 'addGitHubPullRequestComment',
  'addGitHubPullRequestReviewComment', 'submitGitHubPullRequestReview', 'createGitHubPullRequest',
  'checkoutGitHubPullRequest', 'mergeGitHubPullRequest', 'deleteGitHubPullRequestBranch',
  'getGitHubPullRequestBranchCleanupStatus', 'cleanupGitHubPullRequestBranch', 'openGitHubPullRequest',
] as const satisfies readonly (keyof CheshiDesktopApi)[];

/** Every invocation carries its project, including async operations after a UI switch. */
export function projectGitApi(base: CheshiDesktopApi | undefined, project: WorkspaceProject): CheshiDesktopApi | undefined {
  if (!base?.workspaceProjects || project.primary) return base;
  const invoke = (channel: string, ...args: unknown[]) => base.workspaceProjects!.invoke(project.id, channel, args);
  const git = Object.fromEntries(gitMethods.map(method => {
    const channel = 'cheshi:' + method.replace('GitHub', 'Github').replace(/[A-Z]/gu, letter => '-' + letter.toLowerCase());
    return [method, (...args: unknown[]) => invoke(channel, ...args)];
  })) as Pick<CheshiDesktopApi, typeof gitMethods[number]>;
  return { ...base, ...git, workspaceRoot: project.rootPath, workspaceName: project.name,
    githubIssues: { list: query => invoke('cheshi:list-github-issues', query) as ReturnType<CheshiDesktopApi['githubIssues']['list']>,
      read: number => invoke('cheshi:read-github-issue', number) as ReturnType<CheshiDesktopApi['githubIssues']['read']>,
      comments: (number, page) => invoke('cheshi:read-github-issue-comments', number, page) as ReturnType<CheshiDesktopApi['githubIssues']['comments']>,
      open: async number => { await invoke('cheshi:open-github-issue', number); } } };
}
