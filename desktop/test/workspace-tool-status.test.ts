import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync as createSymbolicLink, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { desktopToolPath, getWorkspaceToolStatus } from '../lib/workspace-tool-status.mts';

test('Finder PATH gains Homebrew locations without replacing user precedence or adding duplicates', () => {
  assert.equal(desktopToolPath('/custom/bin:/usr/bin:/opt/homebrew/bin', 'darwin'),
    '/custom/bin:/usr/bin:/opt/homebrew/bin:/usr/local/bin:/bin');
  assert.equal(desktopToolPath(undefined, 'darwin'), '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin');
  assert.equal(desktopToolPath('/usr/bin', 'linux'), '/usr/bin');
});

test('macOS detects Homebrew tools even when launched from Finder without shell setup', () => {
  const installed = new Set(['/opt/homebrew/bin/brew', '/opt/homebrew/bin/gh', '/usr/local/bin/codex']);
  assert.deepEqual(getWorkspaceToolStatus({ env: { PATH: '/usr/bin:/bin' }, platform: 'darwin', homeDirectory: '/nonexistent-cheshi-test-home', executable: (file) => installed.has(file) }),
    { platform: 'darwin', brew: true, gh: true, codex: true, ohMyZsh: false });
});

test('detection distinguishes missing tools, refreshes installed files and never executes them', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cheshi-tool-status-'));
  const options = { env: { PATH: root }, platform: 'linux' };
  try {
    assert.deepEqual(getWorkspaceToolStatus(options), { platform: 'linux', brew: false, gh: false, codex: false, ohMyZsh: false });
    writeFileSync(path.join(root, 'gh'), 'not a runnable script', { mode: 0o755 });
    mkdirSync(path.join(root, 'brew'));
    writeFileSync(path.join(root, 'codex'), 'not executable', { mode: 0o644 });
    assert.deepEqual(getWorkspaceToolStatus(options), { platform: 'linux', brew: false, gh: true, codex: false, ohMyZsh: false });
    chmodSync(path.join(root, 'codex'), 0o755);
    assert.equal(getWorkspaceToolStatus(options).codex, true);
    rmSync(path.join(root, 'gh'));
    assert.equal(getWorkspaceToolStatus(options).gh, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Homebrew-style symlinks and explicit Codex executable override are respected', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cheshi-tool-symlink-'));
  try {
    const binary = path.join(root, 'custom codex');
    writeFileSync(binary, '', { mode: 0o755 });
    createSymbolicLink(binary, path.join(root, 'codex'));
    const options = { env: { PATH: root }, platform: 'linux' };
    assert.equal(getWorkspaceToolStatus(options).codex, true);
    assert.equal(getWorkspaceToolStatus({ ...options, env: { PATH: '', CHESHI_CODEX: binary } }).codex, true);
    assert.equal(getWorkspaceToolStatus({ ...options, env: { PATH: root, CHESHI_CODEX: '/missing/override' } }).codex, false);
    rmSync(binary);
    assert.equal(getWorkspaceToolStatus(options).codex, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('empty and relative PATH entries do not detect executables from the workspace', () => {
  const inspected: string[] = [];
  const status = getWorkspaceToolStatus({ env: { PATH: ':.:./bin' }, platform: 'linux', executable: (file) => { inspected.push(file); return true; } });
  assert.deepEqual(status, { platform: 'linux', brew: false, gh: false, codex: false, ohMyZsh: false });
  assert.deepEqual(inspected, []);
});

test('Windows detects executable extensions without adding macOS paths', () => {
  const status = getWorkspaceToolStatus({ env: { PATH: 'C:\\tools', PATHEXT: '.EXE;.CMD' }, platform: 'win32',
    executable: (file) => ['C:\\tools\\gh.exe', 'C:\\tools\\codex.cmd'].includes(file) });
  assert.deepEqual(status, { platform: 'win32', brew: false, gh: true, codex: true, ohMyZsh: false });
});

test('Oh My Zsh detection checks readable entrypoints, refreshes, and respects a custom ZSH path', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cheshi-optional-shell-'));
  const options = { env: { PATH: '' }, platform: 'darwin', homeDirectory: root, executable: () => false };
  try {
    const directory = path.join(root, '.oh-my-zsh');
    mkdirSync(directory);
    assert.equal(getWorkspaceToolStatus(options).ohMyZsh, false);
    const entrypoint = path.join(directory, 'oh-my-zsh.sh');
    writeFileSync(entrypoint, 'This file must never be executed.');
    assert.equal(getWorkspaceToolStatus(options).ohMyZsh, true);
    rmSync(entrypoint);
    assert.equal(getWorkspaceToolStatus(options).ohMyZsh, false);
    const custom = path.join(root, 'custom zsh');
    mkdirSync(custom);
    writeFileSync(path.join(custom, 'oh-my-zsh.sh'), 'Not shell code.');
    assert.equal(getWorkspaceToolStatus({ ...options, env: { PATH: '', ZSH: custom } }).ohMyZsh, true);
    assert.equal(getWorkspaceToolStatus({ ...options, env: { PATH: '', ZSH: './custom zsh' } }).ohMyZsh, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
