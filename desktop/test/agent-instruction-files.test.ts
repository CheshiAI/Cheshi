import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync as createSymbolicLink } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readInstructionFile, resolveAgentInstructions } from '../lib/agent-management/instruction-files.mts';
import { parseInstructionFiles } from '../shared/agent-registry.ts';
import { specialistInput } from './agent-registry-fixtures.ts';

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() { const path = mkdtempSync(join(tmpdir(), 'cheshi-instructions-')); directories.push(path); return path; }
async function fails(operation: Promise<unknown>, message: string) {
  let error: unknown;
  try { await operation; } catch (reason) { error = reason; }
  expect(error).toBeInstanceOf(Error); expect((error as Error).message).toContain(message);
}

test('instruction references validate absolute Markdown paths and reject malformed or excessive inputs', () => {
  expect(parseInstructionFiles(['/one/AGENTS.md', '/one/AGENTS.md', '/two/RULES.MD'])).toEqual(['/one/AGENTS.md', '/two/RULES.MD']);
  for (const value of [null, 'file.md', [42], ['relative.md'], ['/tmp/file.txt'], ['/tmp/bad\0.md'], ['/tmp/bad\n.md'], Array(17).fill('/file.md')]) {
    expect(() => parseInstructionFiles(value)).toThrow();
  }
});
test('reads fresh instructions, deduplicates original paths, preserves files and keeps project scopes separate', async () => {
  const directory = fixture(), common = join(directory, 'common.md'), project = join(directory, 'AGENTS.md'), alias = join(directory, 'alias.md');
  writeFileSync(common, 'COMMON'); writeFileSync(project, 'PROJECT ONE'); createSymbolicLink(common, alias);
  const profile = { ...specialistInput().profile, instructionFiles: [common] };
  const assignment = { workspaceRoot: directory, instructions: 'Project text', instructionFiles: [project, alias] };
  const text = await resolveAgentInstructions(profile, assignment);
  expect(text.indexOf(profile.instructions)).toBeLessThan(text.indexOf('COMMON'));
  expect(text.indexOf('COMMON')).toBeLessThan(text.indexOf('Project text'));
  expect(text.match(/COMMON/g)).toHaveLength(1); expect(text).toContain('PROJECT ONE');
  writeFileSync(project, 'PROJECT UPDATED');
  expect(await resolveAgentInstructions(profile, assignment)).toContain('PROJECT UPDATED');
  expect(await resolveAgentInstructions(profile, { ...assignment, instructionFiles: [] })).not.toContain('PROJECT UPDATED');
  expect(readFileSync(common, 'utf8')).toBe('COMMON'); expect(readFileSync(project, 'utf8')).toBe('PROJECT UPDATED');
});
test('missing, non-file, invalid UTF-8 and oversized instructions fail with a source path', async () => {
  const directory = fixture(), path = join(directory, 'AGENTS.md');
  await fails(readInstructionFile(path), path);
  mkdirSync(path); await fails(readInstructionFile(path), 'Not a regular file'); rmSync(path, { recursive: true });
  writeFileSync(path, Buffer.from([0xff])); await fails(readInstructionFile(path), path);
  writeFileSync(path, 'bad\0text'); await fails(readInstructionFile(path), 'binary');
  writeFileSync(path, 'x'.repeat(256 * 1024 + 1)); await fails(readInstructionFile(path), '256 KiB');
  const files = Array.from({ length: 5 }, (_, index) => {
    const file = join(directory, `${index}.md`); writeFileSync(file, 'x'.repeat(256 * 1024)); return file;
  });
  await fails(resolveAgentInstructions({ ...specialistInput().profile, instructionFiles: files },
    { workspaceRoot: directory, instructions: '' }), '1 MiB');
});
