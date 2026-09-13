import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  codeGraphStorageDirectory,
  defaultApplicationDataDirectory,
  readWorkspaceRegistry,
  registerWorkspace,
  resolveCheshiUserDataDirectory,
} from '../../config/workspace-storage.mts';

describe('Cheshi workspace storage', () => {
  let dataRoot: string;
  let workspaceRoot: string;

  beforeEach(() => {
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cheshi-data-'));
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cheshi-workspace-'));
  });

  afterEach(() => {
    fs.rmSync(dataRoot, { recursive: true, force: true });
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it('uses the macOS Application Support directory by default', () => {
    expect(defaultApplicationDataDirectory('Cheshi', {
      platform: 'darwin',
      homeDirectory: '/Users/example',
      environment: {},
    })).toBe('/Users/example/Library/Application Support/Cheshi');
  });

  it('registers the selected workspace without creating an index', () => {
    const timestamp = '2026-08-19T00:00:00.000Z';
    const workspace = registerWorkspace(dataRoot, workspaceRoot, { setCurrent: true, timestamp });
    const registry = readWorkspaceRegistry(dataRoot);

    expect(registry.currentWorkspaceId).toBe(workspace.id);
    expect(registry.workspaces).toHaveLength(1);
    expect(registry.workspaces[0]).toEqual(workspace);
    expect(workspace.codeGraphPath).toBe(codeGraphStorageDirectory(dataRoot, workspaceRoot));
    expect(fs.existsSync(workspace.codeGraphPath)).toBe(false);
    expect(fs.existsSync(path.join(workspace.storagePath, 'workspace.json'))).toBe(true);
  });

  it('requires an absolute user-data override', () => {
    expect(() => resolveCheshiUserDataDirectory('Cheshi', {
      environment: { CHESHI_USER_DATA_DIR: 'relative/data' },
    })).toThrow(/CHESHI_USER_DATA_DIR must be an absolute path/);
  });
});
