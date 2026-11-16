import path from 'node:path';
import { realpathSync } from 'node:fs';
import type { CodexChatService } from './codex-chat-service.mts';

const workspaces = new Map<string, { deleting: boolean; pendingMutations: number; services: Set<() => CodexChatService[]> }>();
function workspaceKey(cwd: string): string {
  let key = path.resolve(cwd);
  try { key = realpathSync.native(key); } catch { /* A removed folder still needs its activity released. */ }
  return process.platform === 'darwin' || process.platform === 'win32' ? key.toLowerCase() : key;
}
const backgroundJobs = new Map<string, number>();
const deletingFolders = new Set<string>();
function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep) || b.startsWith(a.endsWith(path.sep) ? a : a + path.sep);
}
export function holdWorkspaceJob(cwd: string): () => void {
  const key = workspaceKey(cwd);
  if ([...deletingFolders].some(folder => overlaps(folder, key))) throw new Error('The workspace folder is being deleted.');
  backgroundJobs.set(key, (backgroundJobs.get(key) ?? 0) + 1);
  return () => { const count = (backgroundJobs.get(key) ?? 1) - 1; if (count) backgroundJobs.set(key, count); else backgroundJobs.delete(key); };
}
export async function withWorkspaceFolderDeletion<T>(cwd: string, operation: () => Promise<T>): Promise<T> {
  const key = workspaceKey(cwd);
  if ([...backgroundJobs.keys()].some(folder => overlaps(folder, key))) throw new Error('Stop scheduled tasks using this folder before deleting it.');
  deletingFolders.add(key);
  try { return await operation(); } finally { deletingFolders.delete(key); }
}
export function codexWorkspaceActivity(cwd: string) {
  const key = workspaceKey(cwd);
  let state = workspaces.get(key);
  if (!state) { state = { deleting: false, pendingMutations: 0, services: new Set() }; workspaces.set(key, state); }
  return state;
}
export function registerWorkspaceChatServices(cwd: string, services: () => CodexChatService[]): () => void {
  const state = codexWorkspaceActivity(cwd); state.services.add(services);
  return () => { state.services.delete(services); };
}
export function assertWorkspaceThreadIdle(cwd: string, threadId: string): void {
  for (const source of codexWorkspaceActivity(cwd).services) {
    if (source().some(service => service.activeTurns.has(threadId) || service.pendingTurnStarts.has(threadId))) {
      throw new Error('This conversation is already running in another chat pane or scheduled task.');
    }
  }
}
