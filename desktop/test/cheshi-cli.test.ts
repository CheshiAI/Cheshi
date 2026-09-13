import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { product } from '../../config/product.mts';
import { codeGraphStorageDirectory } from '../../config/workspace-storage.mts';

const repositoryRoot = path.resolve(import.meta.dir, '../..');
const cliPath = path.join(repositoryRoot, 'cli', 'cheshi-cli.ts');

function runCli(args: string[], environment: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', ...environment },
  });
}

describe('cheshi-cli', () => {
  it('shows the product command surface', () => {
    const result = runCli(['--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('cheshi-cli <command>');
    expect(result.stdout).toContain('codegraph');
  });

  it('prints the Cheshi product version', () => {
    const result = runCli(['--version']);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(product.version);
  });

  it('uses central Cheshi storage for CodeGraph commands', () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cheshi-cli-data-'));
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cheshi-cli-workspace-'));
    try {
      const result = runCli(['codegraph', 'status', workspaceRoot, '--json'], {
        CODEGRAPH_DATA_ROOT: dataRoot,
      });

      expect(result.status).toBe(0);
      const status = JSON.parse(result.stdout) as {
        initialized: boolean;
        projectPath: string;
        indexPath: string;
      };
      expect(status.initialized).toBe(false);
      expect(status.projectPath).toBe(workspaceRoot);
      expect(status.indexPath).toBe(codeGraphStorageDirectory(dataRoot, workspaceRoot));
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true });
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('generates MCP configuration through the public CLI command', () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cheshi-cli-mcp-'));
    try {
      const result = runCli(
        ['codegraph', 'install', '--print-config', 'codex', '--location', 'global'],
        { CODEGRAPH_DATA_ROOT: dataRoot },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('command = "cheshi-cli"');
      expect(result.stdout).toContain('args = ["codegraph", "serve", "--mcp"]');
      expect(result.stdout).toContain(`CODEGRAPH_DATA_ROOT = "${dataRoot}"`);
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('uses the public CLI in installer guidance and central-storage instructions', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cheshi-cli-home-'));
    const dataRoot = path.join(tempHome, 'cheshi-data');
    try {
      const result = runCli(
        ['codegraph', 'install', '--target', 'codex', '--location', 'global', '--yes'],
        {
          HOME: tempHome,
          USERPROFILE: tempHome,
          CODEGRAPH_DATA_ROOT: dataRoot,
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('cheshi-cli codegraph init');

      const instructions = fs.readFileSync(path.join(tempHome, '.codex', 'AGENTS.md'), 'utf8');
      expect(instructions).toContain('cheshi-cli codegraph status /absolute/path/to/workspace --json');
      expect(instructions).toContain('cheshi-cli codegraph explore');
      expect(instructions).toContain('initialized: true');
      expect(instructions).not.toContain('a `.codegraph/` directory exists');
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
