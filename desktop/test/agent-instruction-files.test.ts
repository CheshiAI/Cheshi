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
test('reads saved project AGENTS.md on each application without changing files or crossing project scopes', async () => {
  const directory = fixture(), other = fixture(), project = join(directory, 'AGENTS.md');
  const profile = specialistInput().profile;
  const assignment = { workspaceRoot: directory, instructions: '' };
  expect(await resolveAgentInstructions(profile, assignment)).toBe(profile.instructions);
  writeFileSync(project, 'PROJECT ONE');
  expect(await resolveAgentInstructions(profile, assignment)).toBe(`${profile.instructions}\n\nProject instructions (AGENTS.md):\nPROJECT ONE`);
  writeFileSync(project, 'PROJECT UPDATED');
  expect(await resolveAgentInstructions(profile, assignment)).toContain('PROJECT UPDATED');
  expect(await resolveAgentInstructions(profile, { ...assignment, workspaceRoot: other })).toBe(profile.instructions);
  expect(readFileSync(project, 'utf8')).toBe('PROJECT UPDATED');
  rmSync(project);
  expect(await resolveAgentInstructions(profile, assignment)).toBe(profile.instructions);
  const external = join(other, 'private.md'); writeFileSync(external, 'PRIVATE'); createSymbolicLink(external, project);
  await fails(resolveAgentInstructions(profile, assignment), 'symbolic links');
});
test('legacy overrides block execution and retain the original values for migration', async () => {
  const directory = fixture(), profile = specialistInput().profile;
  const assignment = { workspaceRoot: directory, instructions: '' };
  for (const overrides of [{ instructions: 'Old rules' }, { instructionFiles: ['/missing/linked.md'] }]) {
    const legacy = { ...assignment, ...overrides }, original = JSON.stringify(legacy);
    await fails(resolveAgentInstructions(profile, legacy), 'need migration');
    expect(JSON.stringify(legacy)).toBe(original);
  }
  await fails(resolveAgentInstructions({ ...profile, instructionFiles: ['/missing/common.md'] }, assignment), 'need migration');
});
test('missing, non-file, invalid UTF-8 and oversized instructions fail with a source path', async () => {
  const directory = fixture(), path = join(directory, 'AGENTS.md');
  await fails(readInstructionFile(path), path);
  mkdirSync(path); await fails(readInstructionFile(path), 'Not a regular file'); rmSync(path, { recursive: true });
  writeFileSync(path, Buffer.from([0xff])); await fails(readInstructionFile(path), path);
  writeFileSync(path, 'bad\0text'); await fails(readInstructionFile(path), 'binary');
  writeFileSync(path, 'x'.repeat(256 * 1024 + 1)); await fails(readInstructionFile(path), '256 KiB');
  await fails(resolveAgentInstructions(specialistInput().profile, { workspaceRoot: directory, instructions: '' }), '256 KiB');
});
