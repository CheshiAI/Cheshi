import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { localFileLinkPath } from '../../shared/local-file-link.ts';
import type { Binding } from '../agent-orchestration/mailbox.mts';
import { WorkerWorkspaces } from './worker-workspaces.mts';

/** Resolve only the producing task’s retained workspace, including while its container sleeps. */
export function createWorkerFileLinks(options: { directory: string; openPath(path: string): Promise<string> }) {
  const workspaces = new WorkerWorkspaces(options.directory);
  return async (binding: Binding, href: string, taskId?: string): Promise<void> => {
    const path = localFileLinkPath(href);
    if (!path) throw new Error('Invalid Worker file link.');
    const local = path.startsWith('/workspace/') ? path.slice('/workspace/'.length) : path;
    if (isAbsolute(local) || local.split('/').some(part => part === '..' || part === '.git')) {
      throw new Error('The file link must stay inside this Homie’s workspace.');
    }
    const saved = (taskId ? await workspaces.forTask(binding, taskId) : await workspaces.existing(binding));
    if (!saved) throw new Error('The saved Homie workspace is unavailable.');
    const root = await realpath(saved.workspace), target = await realpath(join(root, local));
    const within = relative(root, target);
    if (isAbsolute(within) || within === '..' || within.startsWith(`..${sep}`) || within.split(sep).includes('.git')) {
      throw new Error('The file link must stay inside this Homie’s workspace.');
    }
    if (!(await stat(target)).isFile()) throw new Error('The link does not point to a file.');
    const error = await options.openPath(target);
    if (error) throw new Error(error);
  };
}
