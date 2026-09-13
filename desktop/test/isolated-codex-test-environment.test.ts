import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { isolatedCodexTestEnvironment } from './isolated-codex-test-environment';

test('isolated Codex fixtures remove inherited database and credential overrides at the process boundary', () => {
  const inherited = {
    CODEX_HOME: '/synthetic/original/home',
    CODEX_SQLITE_HOME: '/synthetic/original/database',
    CODEX_ACCESS_TOKEN: 'synthetic-access-token',
    CODEX_API_KEY: 'synthetic-codex-api-key',
    OPENAI_API_KEY: 'synthetic-openai-api-key',
    FIXTURE_INHERITED: 'preserved',
  };
  const environment = { ...process.env, ...inherited, ...isolatedCodexTestEnvironment('/synthetic/isolated/home') };
  const result = spawnSync(process.execPath, ['-e', `
    const keys = ['CODEX_SQLITE_HOME', 'CODEX_ACCESS_TOKEN', 'CODEX_API_KEY', 'OPENAI_API_KEY'];
    process.stdout.write(JSON.stringify({
      home: process.env.CODEX_HOME,
      inherited: process.env.FIXTURE_INHERITED,
      overrides: keys.filter(key => Object.hasOwn(process.env, key)),
    }));
  `], { env: environment, encoding: 'utf8' });

  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    home: '/synthetic/isolated/home', inherited: 'preserved', overrides: [],
  });
  expect(inherited.CODEX_SQLITE_HOME).toBe('/synthetic/original/database');
});
