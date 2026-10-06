import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { findNearestCodeGraphRoot } from '../directory';

/** Read-only MCP delegates freshness to Cheshi's authenticated, workspace-bound owner. */
export async function awaitManagedCodeGraphSync(projectPath?: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const endpoint = env.CHESHI_CODEGRAPH_SYNC_URL;
  if (!endpoint) return;
  const token = env.CHESHI_CODEGRAPH_SYNC_TOKEN;
  const workspace = env.CHESHI_CODEGRAPH_SYNC_WORKSPACE;
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || !token || !workspace) {
    throw new Error('Invalid managed CodeGraph synchronization configuration.');
  }
  // Never turn a cross-project read into permission to index another project.
  if (projectPath) {
    const queryRoot = findNearestCodeGraphRoot(projectPath) ?? resolve(projectPath);
    // Preserve existing cross-project read access without granting it automatic writes.
    if (resolve(queryRoot) !== resolve(workspace) && await realpath(queryRoot).catch(() => queryRoot) !== await realpath(workspace)) return;
  }
  const response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, redirect: 'error' });
  await response.body?.cancel();
  if (response.status !== 204) throw new Error('CodeGraph synchronization failed. Use source files until synchronization succeeds.');
}
