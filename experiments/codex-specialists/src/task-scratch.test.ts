import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, symlinkSync as createSymbolicLink, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCRATCH_PROFILE, TaskScratch } from './task-scratch.ts';

test('rejects ignored scratch overrides, project write roots, or weaker network and temp policies', () => {
  const scratch = new TaskScratch();
  try {
    const sandbox = { type: 'workspaceWrite', writableRoots: [scratch.directory], networkAccess: false,
      excludeTmpdirEnvVar: true, excludeSlashTmp: true };
    for (const changed of [{ writableRoots: ['/workspace'] }, { writableRoots: ['/tmp/previous-scratch'] },
      { writableRoots: [scratch.directory, '/workspace'] }, { networkAccess: true }, { excludeSlashTmp: false },
      { excludeTmpdirEnvVar: false }]) {
      expect(() => scratch.assertApplied({ activePermissionProfile: { id: SCRATCH_PROFILE }, sandbox: { ...sandbox, ...changed } })).toThrow('not applied');
    }
  } finally { scratch.dispose(); }
});

test('temporary-file APIs use isolated scratch and cleanup never follows child symlinks', () => {
  const outside = mkdtempSync(join(tmpdir(), 'cheshi-scratch-target-'));
  const scratch = new TaskScratch();
  try {
    const original = join(outside, 'original'); writeFileSync(original, 'keep');
    createSymbolicLink(outside, join(scratch.directory, 'external'));
    const actual = execFileSync(process.execPath, ['-e',
      "const fs=require('node:fs'),os=require('node:os'),path=require('node:path');console.log(fs.mkdtempSync(path.join(os.tmpdir(),'cheshi-test-storage-')));"],
    { env: { ...process.env, TMPDIR: scratch.directory, TMP: scratch.directory, TEMP: scratch.directory }, encoding: 'utf8' }).trim();
    expect(actual.startsWith(`${scratch.directory}/cheshi-test-storage-`)).toBe(true);
    expect(existsSync(actual)).toBe(true);
    scratch.dispose();
    expect(existsSync(actual)).toBe(false);
    expect(readFileSync(original, 'utf8')).toBe('keep');
  } finally { scratch.dispose(); rmSync(outside, { recursive: true, force: true }); }
});

test('designated task results survive turns without granting writes outside disposable scratch', () => {
  const archive = mkdtempSync(join(tmpdir(), 'cheshi-output-'));
  const first = new TaskScratch(undefined, archive);
  let second: TaskScratch | undefined;
  try {
    writeFileSync(join(first.output!.directory, 'report.md'), 'observed results');
    writeFileSync(join(first.directory, 'temporary-secret'), 'do not archive');
    first.dispose();
    expect(existsSync(first.directory)).toBe(false);
    second = new TaskScratch(undefined, archive);
    expect(readFileSync(join(second.output!.directory, 'report.md'), 'utf8')).toBe('observed results');
    expect(existsSync(join(second.output!.directory, 'temporary-secret'))).toBe(false);
    const profile = second.config('/workspace')[`permissions.${SCRATCH_PROFILE}`] as { filesystem: Record<string, string> };
    expect(profile.filesystem).toEqual({ ':root': 'read', '/workspace': 'read', [second.directory]: 'write' });
    writeFileSync(join(second.output!.directory, 'report.md'), 'continued results');
    second.dispose();
    const pointer = JSON.parse(readFileSync(join(archive, 'latest.json'), 'utf8'));
    expect(readFileSync(join(archive, pointer.snapshot, 'report.md'), 'utf8')).toBe('continued results');
  } finally { first.dispose(); second?.dispose(); rmSync(archive, { recursive: true, force: true }); }
});

test('output links are rejected and the original scratch remains available for recovery', () => {
  const archive = mkdtempSync(join(tmpdir(), 'cheshi-output-'));
  const scratch = new TaskScratch(undefined, archive);
  try {
    createSymbolicLink('/etc/passwd', join(scratch.output!.directory, 'external'));
    expect(() => scratch.dispose()).toThrow('links');
    expect(existsSync(scratch.directory)).toBe(true);
    expect(existsSync(join(archive, 'latest.json'))).toBe(false);
  } finally {
    rmSync(scratch.directory, { recursive: true, force: true });
    rmSync(archive, { recursive: true, force: true });
  }
});
