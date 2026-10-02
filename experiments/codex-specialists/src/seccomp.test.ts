import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { baseline, buildProfile, serializedProfile } from '../security/profile.ts';

test('preserves every pinned upstream rule and default denial', () => {
  const original = baseline();
  const profile = buildProfile();
  expect(profile.defaultAction).toBe('SCMP_ACT_ERRNO');
  expect(profile.defaultErrnoRet).toBe(1);
  expect(profile.archMap).toEqual(original.archMap);
  expect(profile.syscalls.slice(0, original.syscalls.length)).toEqual(original.syscalls);
  const additions = profile.syscalls.slice(original.syscalls.length);
  expect([...new Set(additions.flatMap(rule => rule.names))].sort())
    .toEqual(['clone', 'mount', 'pivot_root', 'umount2', 'unshare']);
  expect(additions.filter(rule => rule.names.includes('clone')).every(rule =>
    rule.args?.[0]?.valueTwo === 0x10000000)).toBe(true);
});

test('generated deployment profile matches the reviewed generator', () => {
  const deployed = readFileSync(new URL('../security/codex-bwrap.json', import.meta.url), 'utf8');
  expect(deployed).toBe(serializedProfile());
});
