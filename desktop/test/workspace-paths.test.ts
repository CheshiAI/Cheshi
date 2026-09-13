import { describe, expect, it } from 'bun:test';

import {
  workspaceDirectoriesAffectedByChanges,
  workspaceParentDirectory,
} from '../frontend/src/shared/workspacePaths';

describe('workspace path helpers', () => {
  it('finds parent directories for root and nested paths', () => {
    expect(workspaceParentDirectory('README.md')).toBe('.');
    expect(workspaceParentDirectory('desktop/frontend/src')).toBe('desktop/frontend');
  });

  it('refreshes only loaded directories affected by changed paths', () => {
    const loadedDirectories = ['.', 'desktop', 'desktop/frontend', 'collapsed'];

    expect(workspaceDirectoriesAffectedByChanges(
      loadedDirectories,
      ['README.md', 'desktop/frontend/new-file.ts', 'unloaded/deep/file.ts'],
      false,
    )).toEqual(['.', 'desktop/frontend']);
  });

  it('includes a changed path when that directory is already loaded', () => {
    expect(workspaceDirectoriesAffectedByChanges(
      ['.', 'desktop', 'desktop/frontend'],
      ['desktop/frontend'],
      false,
    )).toEqual(['desktop', 'desktop/frontend']);
  });

  it('refreshes every loaded directory after watcher overflow', () => {
    expect(workspaceDirectoriesAffectedByChanges(
      ['.', 'desktop', 'desktop/frontend'],
      [],
      true,
    )).toEqual(['.', 'desktop', 'desktop/frontend']);
  });
});
