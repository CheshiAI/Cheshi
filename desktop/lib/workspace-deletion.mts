import { lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { codeGraphStorageDirectory, readWorkspaceRegistry, unregisterWorkspace, type WorkspaceRecord } from '../../config/workspace-storage.mts';

export interface DeleteRegisteredWorkspaceOptions {
  dataRoot: string;
  id: unknown;
  protectedPaths?: readonly string[];
  confirm: (entry: WorkspaceRecord, exists: boolean) => Promise<boolean>;
  trashItem: (root: string) => Promise<void>;
  withDeletionLock: (root: string, operation: () => Promise<boolean>) => Promise<boolean>;
}

interface DirectoryIdentity {
  device: bigint;
  inode: bigint;
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function containsPath(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function canonicalPath(candidate: string): string {
  let existing = path.resolve(candidate);
  const suffix: string[] = [];
  for (;;) {
    try {
      return path.join(realpathSync.native(existing), ...suffix);
    } catch (error) {
      if (!isMissing(error) || existing === path.dirname(existing)) throw error;
      suffix.unshift(path.basename(existing));
      existing = path.dirname(existing);
    }
  }
}

function requireSafeRoot(root: string, options: DeleteRegisteredWorkspaceOptions): void {
  if (!path.isAbsolute(root) || path.resolve(root) !== root || canonicalPath(root) !== root) {
    throw new Error('The workspace path changed or contains a symbolic link. Refresh the workspace list.');
  }
  const dataRoot = canonicalPath(options.dataRoot);
  const protectedPaths = [homedir(), dataRoot, ...(options.protectedPaths ?? [])].map(canonicalPath);
  if (root === path.parse(root).root || protectedPaths.some((protectedPath) => containsPath(root, protectedPath))
    || containsPath(dataRoot, root)) {
    throw new Error('This folder is protected and cannot be deleted from the workspace list.');
  }
}

function directoryIdentity(root: string): DirectoryIdentity | null {
  let stats;
  try {
    stats = lstatSync(root, { bigint: true });
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error('The registered workspace is no longer a regular folder. Refresh the workspace list.');
  }
  return { device: stats.dev, inode: stats.ino };
}

function registeredWorkspace(dataRoot: string, id: unknown): WorkspaceRecord {
  if (typeof id !== 'string' || !id.trim()) throw new Error('A registered workspace ID is required.');
  const matches = readWorkspaceRegistry(dataRoot).workspaces.filter((entry) => entry.id === id);
  if (matches.length !== 1) throw new Error('Workspace not found. Refresh the workspace list.');
  return matches[0]!;
}

function requireUnchangedRegistration(options: DeleteRegisteredWorkspaceOptions, entry: WorkspaceRecord): void {
  if (registeredWorkspace(options.dataRoot, entry.id).rootPath !== entry.rootPath) {
    throw new Error('The registered workspace changed. Refresh the workspace list and try again.');
  }
  const nested = readWorkspaceRegistry(options.dataRoot).workspaces.some((other) => other.id !== entry.id
    && path.isAbsolute(other.rootPath) && containsPath(entry.rootPath, path.resolve(other.rootPath)));
  if (nested) throw new Error('This folder contains another registered workspace. Remove that workspace first.');
}

function requireUnchangedDirectory(before: DirectoryIdentity | null, after: DirectoryIdentity | null): void {
  if (before?.device !== after?.device || before?.inode !== after?.inode) {
    throw new Error('The workspace folder changed while awaiting confirmation. Refresh the workspace list and try again.');
  }
}

function codeGraphDirectory(dataRoot: string, entry: WorkspaceRecord): string {
  // Derive the target from the workspace identity, never from registry-provided storage paths.
  const target = codeGraphStorageDirectory(canonicalPath(dataRoot), entry.rootPath);
  if (path.basename(path.dirname(target)) !== entry.id || canonicalPath(target) !== target) {
    throw new Error('The CodeGraph storage path changed or contains a symbolic link. Deletion was stopped.');
  }
  return target;
}

export async function deleteRegisteredWorkspace(options: DeleteRegisteredWorkspaceOptions): Promise<boolean> {
  const entry = registeredWorkspace(options.dataRoot, options.id);
  requireSafeRoot(entry.rootPath, options);
  return options.withDeletionLock(entry.rootPath, async () => {
    requireUnchangedRegistration(options, entry);
    const before = directoryIdentity(entry.rootPath);
    const indexPath = codeGraphDirectory(options.dataRoot, entry);
    const indexBefore = directoryIdentity(indexPath);
    if (await options.confirm(entry, before !== null) !== true) return false;
    requireSafeRoot(entry.rootPath, options);
    requireUnchangedRegistration(options, entry);
    requireUnchangedDirectory(before, directoryIdentity(entry.rootPath));
    codeGraphDirectory(options.dataRoot, entry);
    requireUnchangedDirectory(indexBefore, directoryIdentity(indexPath));
    if (before !== null) await options.trashItem(entry.rootPath);
    codeGraphDirectory(options.dataRoot, entry);
    requireUnchangedDirectory(indexBefore, directoryIdentity(indexPath));
    if (indexBefore !== null) {
      try { await options.trashItem(indexPath); }
      catch (cause) {
        throw new Error('The project folder was removed, but its CodeGraph index could not be moved to Trash. The workspace remains listed so you can retry.', { cause });
      }
    }
    unregisterWorkspace(options.dataRoot, entry);
    return true;
  });
}
