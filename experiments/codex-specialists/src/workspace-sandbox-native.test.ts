import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AppServerClient } from './app-server-client.ts';
import { assertWritableWorkspace } from './workspace-sandbox.ts';

// Opt-in fixture: mount an EMPTY directory at /workspace in the worker image,
// using its normal read-only root, user, capabilities and seccomp/AppArmor policy.
// No credentials or model request. Never point this fixture at a real project.
const fixture = process.env.CHESHI_SANDBOX_FIXTURE;
test.skipIf(process.platform !== 'linux' || !['writable', 'read-only'].includes(fixture ?? ''))(
  'native bind-mount preflight and protected paths match actual VM permissions', async () => {
    const workspace = '/workspace';
    expect(readdirSync(workspace)).toEqual([]);
    if (fixture === 'read-only') {
      expect(() => assertWritableWorkspace(workspace)).toThrow('Workspace is not writable');
      expect(readdirSync(workspace)).toEqual([]);
      return;
    }
    assertWritableWorkspace(workspace);
    const home = mkdtempSync('/tmp/cheshi-native-workspace-');
    mkdirSync(join(home, 'codex'));
    const previous = process.cwd();
    process.chdir(workspace);
    const client = new AppServerClient('codex', { PATH: process.env.PATH, HOME: home, CODEX_HOME: join(home, 'codex') });
    const execute = (source: string) => client.request('command/exec', {
      cwd: workspace, command: ['node', '-e', source], timeoutMs: 10000,
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: [workspace], networkAccess: false,
        excludeTmpdirEnvVar: true, excludeSlashTmp: true },
    });
    try {
      await client.initialize();
      const start = await execute("console.log('started')");
      expect(start.exitCode).toBe(0);
      // Also protect pre-existing metadata, including a normal Git repository.
      for (const name of ['.git', '.agents', '.codex', '.aws']) mkdirSync(join(workspace, name), { recursive: true });
      const result = await execute(`
        const fs = require('node:fs');
        fs.writeFileSync('/workspace/allowed.txt', 'allowed');
        for (const name of ['.git', '.agents', '.codex', '.aws']) {
          let denied = false;
          try { fs.writeFileSync('/workspace/' + name + '/denied.txt', 'forbidden'); }
          catch (error) { if (!['EROFS', 'EACCES', 'EPERM'].includes(error.code)) throw error; denied = true; }
          if (!denied) throw new Error('Protected write unexpectedly succeeded: ' + name);
        }
        console.log('ordinary write allowed; metadata writes denied');
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('metadata writes denied');
      expect(existsSync(join(workspace, 'allowed.txt'))).toBe(true);
      for (const name of ['.git', '.agents', '.codex', '.aws']) {
        expect(existsSync(join(workspace, name, 'denied.txt'))).toBe(false);
      }
    } finally {
      await client.close();
      process.chdir(previous);
      rmSync(home, { recursive: true, force: true });
      for (const name of ['.git', '.agents', '.codex', '.aws', 'allowed.txt']) {
        rmSync(join(workspace, name), { recursive: true, force: true });
      }
    }
  }, 30000,
);
