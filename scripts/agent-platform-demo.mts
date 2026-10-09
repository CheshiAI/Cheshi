import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentPlatform } from '../desktop/lib/agent-platform/service.mts';
import { git } from '../desktop/lib/agent-platform/git-workspaces.mts';
import { createPlatformDockerExecutor } from '../desktop/lib/agent-management/platform-executor.mts';
import type { ExecutionPlan } from '../desktop/lib/agent-platform/contracts.mts';

async function main(): Promise<void> {
  const engineId = process.argv[2];
  if (!engineId || engineId === '--help') {
    console.log('Usage: bun run scripts/agent-platform-demo.mts docker:<context> [local-image]');
    console.log('Runs deterministic worker commands in Docker; uses no model credentials or GitHub writes.');
    return;
  }
  const executor = await createPlatformDockerExecutor({ engineId, permissions: { commandExecution: true, fileWrite: true } });
  const image = await executor.resolveImage(process.argv[3] ?? 'cheshi-specialist:1');
  const root = mkdtempSync(join(tmpdir(), 'cheshi-platform-demo-'));
  const repository = join(root, 'source'); mkdirSync(repository);
  await git(repository, ['init', '-b', 'main']);
  writeFileSync(join(repository, 'api.json'), '{"value":1}\n');
  writeFileSync(join(repository, 'consumer.mjs'), "import { readFileSync } from 'node:fs';\nconst api = JSON.parse(readFileSync('api.json', 'utf8'));\nif (api.value !== 1) throw new Error('API contract mismatch');\n");
  writeFileSync(join(repository, 'README.md'), 'Fixture project\n');
  await git(repository, ['add', '.']); await git(repository, ['commit', '-m', '[init] create demo fixture']);
  const platform = await AgentPlatform.open({ repository, directory: join(root, 'platform'), baseRef: 'refs/heads/main', maxConcurrent: 4, executor });
  const plan: ExecutionPlan = { image, command: ['bun', 'consumer.mjs'], timeoutMs: 30_000, cpus: 1, memoryMb: 128 };
  function enqueue(id: string, filename: string, content: string, reason: string, dependencies: string[] = []) {
    platform.enqueue({ id, assignee: `worker-${id}`, goal: reason, reason, criteria: ['The combined consumer still accepts the API response.'],
      scope: [filename], dependencies, execution: { ...plan, command: ['bun', '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(filename)}, ${JSON.stringify(content)});`] } });
  }
  try {
    enqueue('api', 'api.json', '{"result":1}\n', 'Rename the response field.');
    enqueue('consumer', 'consumer.mjs', "import { readFileSync } from 'node:fs';\nconst api = JSON.parse(readFileSync('api.json', 'utf8'));\nif (api.value !== 1) throw new Error('API contract mismatch');\nconsole.log('consumer verified');\n", 'Add a consumer diagnostic.');
    enqueue('docs', 'README.md', 'The API returns one result.\n', 'Document the API.');
    const results = await Promise.all(['api', 'consumer', 'docs'].map(id => platform.runTask(id)));
    if (results.some(task => task.status !== 'succeeded')) throw new Error('Inspect task errors in the retained platform state.');
    const first = await platform.prepareCandidate(['api', 'consumer', 'docs'], [plan]);
    const failed = await platform.verifyCandidate(first.id);
    if (failed.status !== 'failed' || failed.checks[0]?.receipt?.exitCode !== 1) throw new Error('Expected the combined contract check to fail.');
    console.log('Detected the API/consumer conflict after a clean Git merge.');
    enqueue('repair', 'consumer.mjs', "import { readFileSync } from 'node:fs';\nconst api = JSON.parse(readFileSync('api.json', 'utf8'));\nif (api.result !== 1) throw new Error('API contract mismatch');\nconsole.log('consumer verified');\n", 'Use the renamed response field after examining the failed check.', ['api', 'consumer']);
    if ((await platform.runTask('repair')).status !== 'succeeded') throw new Error('Repair worker failed.');
    const repaired = await platform.prepareCandidate(['api', 'consumer', 'docs', 'repair'], [plan]);
    if ((await platform.verifyCandidate(repaired.id)).status !== 'passed') throw new Error('Combined candidate did not pass.');
    const publication = await platform.publication(repaired.id);
    writeFileSync(join(root, 'publication.json'), JSON.stringify(publication, null, 2), { mode: 0o600 });
    console.log(`Verified candidate: ${publication.headCommit}`);
    const worktrees = (await git(publication.managedRepository, ['worktree', 'list', '--porcelain', '-z']))
      .split('\0').filter(field => field.startsWith('worktree '));
    console.log(`Shared repository: ${publication.managedRepository}`);
    console.log(`Linked worktrees: ${worktrees.length - 1}; integration branch: ${publication.branch}`);
  } finally {
    console.log(`Demo repository, workspaces and evidence retained at: ${root}`);
    const state = platform.snapshot();
    const ids = [...state.tasks.flatMap(task => task.attempts.map(attempt => attempt.id)), ...state.candidates.flatMap(c => c.checks.map(check => check.id))];
    for (const id of ids) {
      // Unknown or running executions must remain available for inspection.
      if (await executor.inspect(id) === 'stopped') await executor.cleanup(id);
    }
  }
}

await main();
