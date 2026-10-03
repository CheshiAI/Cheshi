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
