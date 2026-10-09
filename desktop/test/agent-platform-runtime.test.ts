import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSpecialistRuntime } from '../lib/agent-management/runtime.mts';
import { createAgentRegistry } from '../lib/agent-management/registry.mts';
import { specialistInput, specialistModels } from './agent-registry-fixtures.ts';
import { assertFailure } from './agent-platform-fixtures.ts';
import createForgeConfiguration from '../../forge.config.mts';

test('isolated profiles retain account, model, instructions and project permissions, and invalidate changed settings', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cheshi-platform-profile-')));
  const home = join(root, 'account'); mkdirSync(home);
  const registry = createAgentRegistry(join(root, 'registry.json'));
  const input = specialistInput();
  input.profile = { ...input.profile, accountId: 'fixture-account', model: 'model-fixture', reasoningEffort: 'high', serviceTier: 'priority' };
  input.assignment.permissions = { fileWrite: true, commandExecution: true };
  const { agentId } = registry.save(input, root);
  const unused = async (): Promise<never> => { throw new Error('Unexpected worker operation'); };
  let accountReads = 0;
  const runtime = createSpecialistRuntime({ directory: join(root, 'runtime'), buildContext: '/build', registry,
    getProjectDocMaxBytes: () => 8192, account: async id => { accountReads++; expect(id).toBe('fixture-account'); return { home, models: specialistModels() }; },
    management: { details: unused, engines: unused, snapshot: unused, control: unused }, run: unused });
  try {
    await assertFailure(runtime.platformProfile(root, agentId, 'other-account'), /assignment/);
    expect(accountReads).toBe(0);
    const profile = await runtime.platformProfile(root, agentId, 'fixture-account');
    expect(profile.configuration).toMatchObject({ profileId: agentId, accountId: 'fixture-account', model: 'model-fixture',
      reasoningEffort: 'high', serviceTier: 'priority', projectDocMaxBytes: 8192, enabledTools: [], permissions: input.assignment.permissions });
    expect(profile.configuration.instructions).toContain(input.profile.instructions);
    expect(profile.configuration.instructions).toContain(input.assignment.instructions);
    // Preparing a profile is credential-free; credentials are read just before starting its owned container.
    await assertFailure(profile.credentials(), /Sign in/);
    writeFileSync(join(home, 'auth.json'), JSON.stringify({ tokens: { access_token: 'test-only', refresh_token: 'test-only', id_token: 'test-only', account_id: 'test-only' }, excluded: 'discard' }));
    expect(JSON.parse(await profile.credentials()).excluded).toBeUndefined();
    registry.save({ ...input, id: agentId, revision: 1, assignment: { ...input.assignment, permissions: { fileWrite: false, commandExecution: true } } }, root);
    expect(() => profile.assertCurrent()).toThrow('settings changed');
    await assertFailure(profile.credentials(), /settings changed/);
    await assertFailure(runtime.platformProfile(root, agentId, 'fixture-account'), /permissions/);
    expect(readFileSync(join(root, 'registry.json'), 'utf8')).not.toContain('test-only');
  } finally { await runtime.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test('isolated chat modules and their local runtime imports are packaged and load in native strip-only Node', async () => {
  const ignore = (await createForgeConfiguration()).packagerConfig?.ignore;
  if (typeof ignore !== 'function') throw new Error('Expected the packaging allowlist.');
  const shouldIgnore = ignore;
  const entrypoints = ['desktop/lib/agent-platform/chat-service.mts', 'desktop/lib/agent-chats/isolated-tasks.mts',
    'desktop/lib/agent-management/runtime.mts', 'desktop/lib/agent-chats/ipc.mts'];
  const seen = new Set<string>();
  function visit(filename: string) {
    if (seen.has(filename)) return;
    seen.add(filename);
    expect(shouldIgnore(`/${filename}`)).toBe(false);
    const source = readFileSync(new URL(`../../${filename}`, import.meta.url), 'utf8');
    // This graph uses ordinary static imports; omit type-only edges erased by native Node.
    for (const match of source.matchAll(/^import\s+(?!type\b)[\s\S]*?from\s+['"]([^'"]+)['"]/gm)) {
      const target = match[1]!;
      if (!target.startsWith('.')) continue;
      const resolved = new URL(target, new URL(`../../${filename}`, import.meta.url));
      visit(resolved.pathname.slice(new URL('../../', import.meta.url).pathname.length));
    }
  }
  entrypoints.forEach(visit);
  expect(seen.size).toBeGreaterThan(20);
  const modules = entrypoints.map(file => new URL(`../../${file}`, import.meta.url).href);
  const result = spawnSync('node', ['--input-type=module', '-e', `for (const url of ${JSON.stringify(modules)}) await import(url);`],
    { encoding: 'utf8', timeout: 30_000 });
  expect(result.error).toBeUndefined(); expect(result.stderr).toBe(''); expect(result.status).toBe(0);
});
