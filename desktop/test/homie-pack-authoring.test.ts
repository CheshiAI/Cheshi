import { expect, test } from 'bun:test';
import { createHomiePack, createPackSkill, readSelectedPackFiles, type SelectedPackFile } from '../frontend/src/features/agents/homiePackAuthoring';
import { parseAgentPackage } from '../shared/agent-package';
import { HOMIE_PACK_BYTES } from '../shared/homie-pack';
import { specialistAgent } from './agent-registry-fixtures';

function file(name: string, content: string, webkitRelativePath = ''): SelectedPackFile {
  const buffer = new TextEncoder().encode(content);
  return { name, size: buffer.length, webkitRelativePath, arrayBuffer: async () => buffer.buffer };
}
async function fails(operation: Promise<unknown>, message: string) {
  let error: unknown;
  try { await operation; } catch (cause) { error = cause; }
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain(message);
}

test('pack identity is generated independently of display names and host identity', () => {
  const profile = { ...specialistAgent(), name: '검증 호미' };
  const first = createHomiePack(profile, profile.permissions), second = createHomiePack(profile, profile.permissions);
  expect(parseAgentPackage(first).name).toBe(profile.name);
  expect(first.id).not.toBe(second.id);
  expect(first).not.toHaveProperty('accountId');
  expect(first).not.toHaveProperty('assignments');
});
test('skill creation escapes metadata and resolves generated folder collisions', () => {
  const first = createPackSkill([], '검증 호미', 'Use for "review":\nchanges.', 'Review the diff.');
  const second = createPackSkill([first], '검증 호미', 'More checks.', 'Inspect tests.');
  expect(first.path).toBe('skills/skill/SKILL.md');
  expect(second.path).toBe('skills/skill-2/SKILL.md');
  expect(first.content).toContain('description: "Use for \\"review\\":\\nchanges."');
});
test('selected file and skill folder imports preserve relative layout', async () => {
  expect(await readSelectedPackFiles([file('check.ts', 'console.log(1)')], 'scripts', [])).toEqual([{ path: 'scripts/check.ts', content: 'console.log(1)' }]);
  const skill = await readSelectedPackFiles([file('SKILL.md', 'Review', 'review/SKILL.md'), file('check.sh', 'exit 0', 'review/scripts/check.sh')], 'skills', []);
  expect(skill.map(item => item.path)).toEqual(['skills/review/SKILL.md', 'skills/review/scripts/check.sh']);
});
test('invalid selected files fail the complete batch without replacing existing assets', async () => {
  const existing = [{ path: 'scripts/check.ts', content: 'original' }];
  await fails(readSelectedPackFiles([file('CHECK.ts', 'replacement')], 'scripts', existing), 'Duplicate');
  await fails(readSelectedPackFiles([file('../escape', 'x')], 'resources', existing), 'relative path');
  await fails(readSelectedPackFiles([file('image.png', '\0binary')], 'resources', existing), 'Binary');
  await fails(readSelectedPackFiles([file('helper.sh', 'x', 'review/helper.sh')], 'skills', existing), 'SKILL.md');
  expect(existing).toEqual([{ path: 'scripts/check.ts', content: 'original' }]);
});
test('oversized imports are rejected before reading file contents', async () => {
  let read = false;
  await fails(readSelectedPackFiles([{ name: 'huge.txt', size: HOMIE_PACK_BYTES + 1,
    arrayBuffer: async () => { read = true; return new ArrayBuffer(0); } }], 'resources', []), '8 MiB');
  expect(read).toBe(false);
});
