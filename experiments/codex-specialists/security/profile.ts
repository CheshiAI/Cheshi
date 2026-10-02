import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

export const UPSTREAM_SHA256 = '6416b47770785a41ac59073cdc77d9fe98517df2799dc83ef207e622de3053f6';
const source = new URL('./vendor/moby-seccomp-default.json', import.meta.url);
const output = new URL('./codex-bwrap.json', import.meta.url);

type Argument = { index: number; value: number; valueTwo?: number; op: string };
export type SyscallRule = {
  names: string[]; action: string; args?: Argument[]; comment?: string;
  includes?: { caps?: string[]; arches?: string[] };
  excludes?: { caps?: string[]; arches?: string[] }; errnoRet?: number;
};
export type SeccompProfile = {
  defaultAction: string; defaultErrnoRet: number; archMap: unknown[]; syscalls: SyscallRule[];
};

export function baseline(): SeccompProfile {
  const contents = readFileSync(source, 'utf8');
  if (createHash('sha256').update(contents).digest('hex') !== UPSTREAM_SHA256) {
    throw new Error('The pinned Moby seccomp baseline changed. Review it before regeneration.');
  }
  // The exact upstream bytes are pinned above; parsing is the external data boundary.
  return JSON.parse(contents) as SeccompProfile;
}

export function buildProfile(): SeccompProfile {
  const profile = baseline();
  const newUser = 0x10000000;
  const newCgroup = 0x02000000;
  const namespaces = 0x7c020000; // USER, NS, PID, NET, IPC, UTS; exclude CGROUP and TIME.
  profile.syscalls.push(
    {
      names: ['clone'], action: 'SCMP_ACT_ALLOW',
      args: [{ index: 0, value: newUser | newCgroup, valueTwo: newUser, op: 'SCMP_CMP_MASKED_EQ' }],
      excludes: { arches: ['s390', 's390x'] },
      comment: 'bwrap creates a new user namespace; never grant a container capability.',
    },
    {
      names: ['clone'], action: 'SCMP_ACT_ALLOW',
      args: [{ index: 1, value: newUser | newCgroup, valueTwo: newUser, op: 'SCMP_CMP_MASKED_EQ' }],
      includes: { arches: ['s390', 's390x'] },
      comment: 'Same user-namespace rule with the s390 clone argument order.',
    },
    {
      names: ['unshare'], action: 'SCMP_ACT_ALLOW',
      args: [{ index: 0, value: (~namespaces) >>> 0, valueTwo: 0, op: 'SCMP_CMP_MASKED_EQ' }],
      comment: 'Allow only the namespace flags used for the inner Linux sandbox.',
    },
    {
      names: ['mount', 'umount2', 'pivot_root'], action: 'SCMP_ACT_ALLOW',
      comment: 'bwrap mounts its inner root; kernel capability and mount ownership checks still apply.',
    },
  );
  return profile;
}

export function serializedProfile(): string { return `${JSON.stringify(buildProfile(), null, 2)}\n`; }

if (import.meta.main) {
  const contents = serializedProfile();
  if (process.argv.includes('--check')) {
    if (readFileSync(output, 'utf8') !== contents) throw new Error('Regenerate security/codex-bwrap.json.');
    console.log('Pinned seccomp profile matches its generator.');
  } else {
    writeFileSync(output, contents);
    console.log('Generated security/codex-bwrap.json from the pinned Moby baseline.');
  }
}
