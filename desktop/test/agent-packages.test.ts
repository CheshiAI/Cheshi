import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync as createSymbolicLink } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { officialAgentPackages, readAgentPackage } from '../lib/agent-management/packages.mts';
import { resolveAgentInstructions } from '../lib/agent-management/instruction-files.mts';
import { createAgentRegistry } from '../lib/agent-management/registry.mts';
import { applyAgentPackage, parseAgentPackage, parseAgentPackageManifest } from '../shared/agent-package.ts';
import { specialistInput } from './agent-registry-fixtures.ts';

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function directory() { const path = mkdtempSync(join(tmpdir(), 'cheshi-packages-')); directories.push(path); return path; }
async function fails(operation: Promise<unknown>, message: string) {
  let error: unknown;
  try { await operation; } catch (reason) { error = reason; }
  expect(error).toBeInstanceOf(Error); expect((error as Error).message).toContain(message);
}

test('official portable packages include complete development and independent review workflows', async () => {
  const [development, review] = await officialAgentPackages();
  expect(development!.role).toBe('development');
  expect(development!.requestedPermissions).toEqual({ fileWrite: true, commandExecution: true });
  expect(development!.instructions).toContain('1. Review relevant documents');
  expect(development!.instructions).toContain('independent verification');
  expect(review!.role).toBe('verification');
  expect(review!.requestedPermissions).toEqual({ fileWrite: false, commandExecution: true });
  expect(review!.instructions).toContain('10. UI changes');
  expect(review!.instructions).toContain('Do not implement');
  expect(review!.requiredTools).toContain('verification');
});

test('package schema rejects unsupported capabilities, credentials, executable fields, and malformed permissions', async () => {
  const [definition] = await officialAgentPackages();
  for (const patch of [{ schemaVersion: 2 }, { id: '../escape' }, { version: 'latest' }, { instructionsFile: '../AGENTS.md' },
    { requiredTools: ['arbitrary-shell-plugin'] }, { requestedPermissions: { fileWrite: 'true', commandExecution: true } },
    { accountId: 'local-account' }, { token: 'test-only' }, { setupCommand: 'echo unexpected' }, { instructions: 'x'.repeat(20_001) },
    { instructions: 'binary\0text' }]) {
    expect(() => parseAgentPackage({ ...definition, ...patch })).toThrow();
  }
  expect(() => parseAgentPackageManifest({ ...definition })).toThrow('field');
});

test('local packages require both files and reject symlink escapes, binary input and oversized files', async () => {
  const root = directory(), folder = join(root, 'package'); mkdirSync(folder);
  const [definition] = await officialAgentPackages();
  const { instructions, ...manifest } = definition!;
  const filename = join(folder, 'agent.json'), rules = join(folder, 'instructions.md');
  writeFileSync(filename, JSON.stringify(manifest));
  await fails(readAgentPackage(filename), 'ENOENT');
  writeFileSync(rules, instructions);
  expect(await readAgentPackage(filename)).toEqual(definition!);
  await fails(readAgentPackage(join(folder, 'other.json')), 'agent.json');
  writeFileSync(rules, Buffer.from([0xff]));
  await fails(readAgentPackage(filename), 'byte');
  writeFileSync(rules, 'x'.repeat(256 * 1024 + 1));
  await fails(readAgentPackage(filename), '256 KiB');
  rmSync(rules); writeFileSync(join(root, 'outside.md'), 'outside');
  createSymbolicLink(join(root, 'outside.md'), rules);
  await fails(readAgentPackage(filename), 'inside');
});

test('installed snapshot survives source removal and registry reload without local account or permission replacement', async () => {
  const root = directory(), folder = join(root, 'package'); mkdirSync(folder);
  const [definition] = await officialAgentPackages();
  const { instructions, ...manifest } = definition!;
  writeFileSync(join(folder, 'agent.json'), JSON.stringify(manifest)); writeFileSync(join(folder, 'instructions.md'), instructions);
  const imported = await readAgentPackage(join(folder, 'agent.json'));
  const input = specialistInput();
  input.profile = applyAgentPackage(input.profile, imported, false, false);
  expect(input.profile.permissions).toEqual({ fileWrite: false, commandExecution: false });
  expect(input.profile.accountId).toBeNull();
  const filename = join(root, 'registry.json'), registry = createAgentRegistry(filename);
  const created = registry.save(input, '/project').snapshot.agents[0]!;
  rmSync(folder, { recursive: true });
  const restored = createAgentRegistry(filename).snapshot('/project').agents[0]!;
  expect(restored.package).toEqual(imported);
  expect(await resolveAgentInstructions(restored, restored.assignments[0]!)).toBe(`${instructions}\n\nProject instructions:\n${input.assignment.instructions}`);
  const customized = { ...restored, instructions: 'My reviewed instructions', accountId: 'default', model: 'custom-model' };
  const update = { ...imported, version: '1.1.0', instructions: 'New package rules' };
  const kept = applyAgentPackage(customized, update, true, true);
  expect(kept.instructions).toBe('My reviewed instructions');
  expect(kept.model).toBe('custom-model'); expect(kept.accountId).toBe('default');
  expect(kept.package?.instructions).toBe('New package rules');
  const replaced = applyAgentPackage(customized, update, true, false);
  expect(replaced.instructions).toBe('New package rules');
  const saved = registry.save({ ...input, id: created.id, revision: created.revision, profile: kept }, '/project');
  expect(saved.snapshot.agents[0]!.package?.version).toBe('1.1.0');
  expect(() => applyAgentPackage(customized, { ...update, id: 'other.package' }, true, false)).toThrow('same package ID');
});
