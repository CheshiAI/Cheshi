import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { runDocker } from '../lib/agent-management/docker.mts';
import { preparePackEnvironment } from '../lib/agent-management/pack-environment.mts';
import type { AgentPackage } from '../shared/agent-package';

test.skipIf(process.env.CHESHI_TEST_HOMIE_PACK_DOCKER !== '1')('Docker runs pack programs and scripts and discovers private skills without project or account mounts', async () => {
  const prefix = ['--context', 'colima-cheshi'];
  const name = `cheshi-homie-pack-test-${randomUUID()}`;
  let image: string | undefined;
  const pack: AgentPackage = { schemaVersion: 1, id: 'test.homie', version: '1.0.0', name: 'Pack test', role: 'custom',
    description: 'Isolated pack runtime test', instructionsFile: 'instructions.md', instructions: 'Use the pack skill.',
    model: { model: null, reasoningEffort: null, serviceTier: null }, requiredTools: [], requestedPermissions: { fileWrite: false, commandExecution: true },
    resources: { programs: ['jq'], files: [
      { path: 'skills/check/SKILL.md', content: `---\nname: check\ndescription: Check a test payload.\n---\nTest ${name}.\n` },
      { path: 'skills/check/scripts/check.sh', content: 'printf \'{"ok":true}\' | jq -r .ok\n' },
    ] } };
  try {
    image = await preparePackEnvironment(runDocker, prefix, 'cheshi-specialist:1', pack);
    const install = await readFile(new URL('../../experiments/codex-specialists/src/homie-pack-skills.ts', import.meta.url), 'utf8');
    const script = install + `\nimport { AppServerClient } from '/app/src/app-server-client.ts';
      await installHomieSkills('/tmp/home');
      const client = new AppServerClient();
      let discovered = false;
      try {
        await client.initialize();
        const catalog = await client.request('skills/list', { cwds: ['/tmp'], forceReload: true });
        discovered = catalog.data?.some(entry => entry.skills?.some(skill => skill.name === 'check' && skill.path.includes('cheshi-homie-check')));
      } finally { await client.close(); }
      const skill = await Bun.file('/tmp/home/skills/cheshi-homie-check/SKILL.md').text();
      const result = Bun.spawnSync(['sh', '/opt/cheshi/homie-pack/skills/check/scripts/check.sh']);
      let readOnly = false;
      try { await Bun.write('/opt/cheshi/homie-pack/skills/check/SKILL.md', 'changed'); } catch { readOnly = true; }
      console.log(JSON.stringify({ skill: skill.includes(${JSON.stringify(name)}), output: result.stdout.toString().trim(), status: result.exitCode, readOnly, discovered }));`;
    const result = await runDocker([...prefix, 'run', '--rm', '--name', name, '--read-only', '--network', 'none', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges:true', '--pids-limit', '64', '--memory', '256m', '--tmpfs', '/tmp:rw,nosuid,nodev,size=32m,mode=1777',
      '--env', 'CODEX_HOME=/tmp/home', '--entrypoint', 'bun', image, '-e', script]);
    expect(JSON.parse(result.trim())).toEqual({ skill: true, output: 'true', status: 0, readOnly: true, discovered: true });
  } finally {
    await runDocker([...prefix, 'container', 'rm', '--force', name]).catch(() => {});
    if (image) await runDocker([...prefix, 'image', 'rm', image]);
  }
}, 600_000);
