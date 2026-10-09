import { expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, symlinkSync as createSymbolicLink } from 'node:fs';
import { join } from 'node:path';
import { AgentPlatform } from '../lib/agent-platform/service.mts';
import { git, revision } from '../lib/agent-platform/git-workspaces.mts';
import { assertFailure, createDeferred, executor, fixture, plan, receipt, taskInput } from './agent-platform-fixtures.ts';

test('parallel claims are exclusive across service instances and never edit the source checkout', async () => {
  const entered = createDeferred<void>(), release = createDeferred<void>();
  const f = await fixture(executor(async request => {
    entered.resolve(); await release.promise;
    writeFileSync(join(request.workspace, `${request.command[0]}.txt`), 'implemented\n');
    return receipt(request);
  }), 1);
  try {
    const original = await revision(f.repository, 'HEAD');
    f.platform.enqueue(taskInput('first')); f.platform.enqueue(taskInput('second'));
    const running = f.platform.runTask('first'); await entered.promise;
    const other = await AgentPlatform.open(f.options);
    await assertFailure(other.runTask('first'), /not queued/);
    await assertFailure(other.runTask('second'), /slots are full/);
    expect((await other.inspectInterrupted()).tasks[0]!.status).toBe('running');
    release.resolve();
    const completed = await running;
    expect(completed.status).toBe('succeeded');
    expect(completed.attempts[0]!.resultCommit).not.toBe(original);
    expect(await revision(f.repository, 'HEAD')).toBe(original);
    expect(await git(f.repository, ['status', '--porcelain'])).toBe('');
    expect(existsSync(join(f.repository, 'first.txt'))).toBe(false);
    expect(other.snapshot().tasks[0]!.attempts).toHaveLength(1);
    expect(other.enqueue(taskInput('first')).status).toBe('succeeded');
    expect(() => other.enqueue({ ...taskInput('first'), reason: 'changed request' })).toThrow('different request');
  } finally { release.resolve(); f.dispose(); }
});

test('dependencies wait, run on predecessor results and remain connected to candidate provenance', async () => {
  const f = await fixture(executor(async request => {
    if (request.writable) {
      if (request.command[0] === 'consumer') expect(readFileSync(join(request.workspace, 'api.txt'), 'utf8')).toBe('v2');
      writeFileSync(join(request.workspace, `${request.command[0]}.txt`), 'v2');
    }
    return receipt(request);
  }));
  try {
    f.platform.enqueue(taskInput('api')); f.platform.enqueue(taskInput('consumer', ['consumer.txt'], ['api']));
    expect(f.platform.coordination()[1]!.waitingOn).toEqual(['api']);
    await assertFailure(f.platform.runTask('consumer'), /no successful result/);
    const api = await f.platform.runTask('api');
    const consumer = await f.platform.runTask('consumer');
    expect(consumer.status).toBe('succeeded');
    expect(consumer.attempts[0]!.dependencyCommits).toEqual([api.attempts[0]!.resultCommit!]);
    await assertFailure(f.platform.prepareCandidate(['consumer'], [plan]), /Include all dependency/);
    const candidate = await f.platform.prepareCandidate(['consumer', 'api'], [plan]);
    expect(candidate.status).toBe('prepared'); expect(candidate.taskIds).toEqual(['api', 'consumer']);
    expect((await f.platform.verifyCandidate(candidate.id)).status).toBe('passed');
    const publication = await f.platform.publication(candidate.id);
    expect(publication.tasks.map(t => t.reason)).toEqual(['Requested behavior api', 'Requested behavior consumer']);
    expect(publication.checks[0]!.receipt!.image).toBe(plan.image);
  } finally { f.dispose(); }
});

test('overlapping work is visible and conflicting commits cannot become a verified candidate', async () => {
  const f = await fixture(executor(async request => {
    writeFileSync(join(request.workspace, 'shared.txt'), `${request.command[0]}\n`); return receipt(request);
  }));
  try {
    f.platform.enqueue(taskInput('alpha', ['shared.txt'])); f.platform.enqueue(taskInput('beta', ['shared.txt']));
    expect(f.platform.coordination()[0]!.overlaps).toEqual(['beta']);
    const tasks = await Promise.all([f.platform.runTask('alpha'), f.platform.runTask('beta')]);
    expect(tasks.map(t => t.status)).toEqual(['succeeded', 'succeeded']);
    const candidate = await f.platform.prepareCandidate(['alpha', 'beta'], [plan]);
    expect(candidate.status).toBe('conflict'); expect(candidate.error).toContain('shared.txt');
    await assertFailure(f.platform.verifyCandidate(candidate.id), /prepared candidate/);
    expect(readFileSync(join(f.repository, 'shared.txt'), 'utf8')).toBe('baseline\n');
  } finally { f.dispose(); }
});

test('changed paths must stay within scope and retries preserve earlier evidence', async () => {
  const f = await fixture(executor(async request => {
    writeFileSync(join(request.workspace, 'shared.txt'), 'outside scope'); return receipt(request);
  }));
  try {
    f.platform.enqueue(taskInput('bounded', ['allowed/']));
    const task = await f.platform.runTask('bounded');
    expect(task.status).toBe('failed'); expect(task.attempts[0]!.error).toContain('exceed the task scope');
    expect(task.attempts[0]!.resultCommit).toBeNull();
    f.platform.retry('bounded', 'Retry confirmed failed attempt');
    expect((await f.platform.runTask('bounded')).attempts).toHaveLength(2);
  } finally { f.dispose(); }
});

test('lost execution receipts stay unknown after restart and cannot be automatically retried', async () => {
  let calls = 0;
  const f = await fixture(executor(async () => { calls++; throw new Error('Disconnected after dispatch'); }));
  try {
    f.platform.enqueue(taskInput('uncertain'));
    expect((await f.platform.runTask('uncertain')).status).toBe('unknown');
    const reopened = await AgentPlatform.open(f.options);
    expect(() => reopened.retry('uncertain', 'try again')).toThrow('confirmed failed');
    await assertFailure(reopened.runTask('uncertain'), /not queued/);
    expect((await reopened.inspectInterrupted()).tasks[0]!.status).toBe('unknown');
    expect(calls).toBe(1);
  } finally { f.dispose(); }
});

test('an interrupted persisted run is inspected without dispatching or inventing success', async () => {
  const f = await fixture(executor(async request => receipt(request)));
  try {
    f.platform.enqueue(taskInput('interrupted'));
    await f.platform.runTask('interrupted'); // No file changes: confirmed failure.
    const saved = f.platform.snapshot(), t = saved.tasks[0]!;
    t.status = 'running'; t.attempts[0]!.status = 'running'; t.attempts[0]!.receipt = null;
    writeFileSync(join(f.directory, 'state.json'), JSON.stringify(saved));
    const reopened = await AgentPlatform.open(f.options);
    const state = await reopened.inspectInterrupted();
    expect(state.tasks[0]!.status).toBe('unknown');
    expect(state.tasks[0]!.attempts[0]!.resultCommit).toBeNull();
  } finally { f.dispose(); }
});

test('combined changes can fail checks even when Git reports a clean merge', async () => {
  const f = await fixture(executor(async request => {
    if (request.writable) {
      if (request.command[0] === 'api') writeFileSync(join(request.workspace, 'api.json'), '{"result":1}');
      else writeFileSync(join(request.workspace, 'consumer.mjs'), "import {readFileSync} from 'node:fs'; const api=JSON.parse(readFileSync('api.json','utf8')); if(api.value!==1)throw Error('contract mismatch');console.log('consumer ok');");
      return receipt(request);
    }
    return await new Promise(resolve => {
      execFile('node', ['consumer.mjs'], { cwd: request.workspace, timeout: 5000 }, (error, stdout, stderr) => {
        resolve(receipt(request, error ? 1 : 0, stdout + stderr));
      });
    });
  }));
  try {
    writeFileSync(join(f.repository, 'api.json'), '{"value":1}');
    writeFileSync(join(f.repository, 'consumer.mjs'), "console.log('baseline');");
    await git(f.repository, ['add', '.']); await git(f.repository, ['commit', '-m', '[test] add api fixture']);
    f.platform.enqueue(taskInput('api', ['api.json'])); f.platform.enqueue(taskInput('consumer', ['consumer.mjs']));
    await Promise.all([f.platform.runTask('api'), f.platform.runTask('consumer')]);
    const candidate = await f.platform.prepareCandidate(['api', 'consumer'], [plan]);
    expect(candidate.status).toBe('prepared');
    const checked = await f.platform.verifyCandidate(candidate.id);
    expect(checked.status).toBe('failed'); expect(checked.checks[0]!.receipt!.output).toContain('contract');
    await assertFailure(f.platform.publication(candidate.id), /verified candidate/);
  } finally { f.dispose(); }
});

test('base changes during a check invalidate the result and later branch movement invalidates publication', async () => {
  let moveBase = true;
  const f = await fixture(executor(async request => {
    if (request.writable) writeFileSync(join(request.workspace, 'feature.txt'), 'feature');
    else if (moveBase) {
      writeFileSync(join(f.repository, 'outside.txt'), 'another author');
      await git(f.repository, ['add', '.']); await git(f.repository, ['commit', '-m', '[feature] change base']);
    }
    return receipt(request);
  }));
  try {
    f.platform.enqueue(taskInput('feature')); await f.platform.runTask('feature');
    const first = await f.platform.prepareCandidate(['feature'], [plan]);
    expect((await f.platform.verifyCandidate(first.id)).status).toBe('stale');
    moveBase = false;
    const second = await f.platform.prepareCandidate(['feature'], [plan]);
    expect((await f.platform.verifyCandidate(second.id)).status).toBe('passed');
    await git(f.repository, ['commit', '--allow-empty', '-m', '[test] advance base']);
    await assertFailure(f.platform.publication(second.id), /base branch changed/);
    expect(f.platform.snapshot().candidates[1]!.status).toBe('stale');
  } finally { f.dispose(); }
});

test('modified candidate contents and receipts from another run cannot pass verification', async () => {
  let mismatch = false;
  const f = await fixture(executor(async request => {
    if (request.writable) writeFileSync(join(request.workspace, 'feature.txt'), 'feature');
    else writeFileSync(join(request.workspace, 'feature.txt'), 'unexpected edit');
    const result = receipt(request);
    return mismatch ? { ...result, id: 'wrong-run' } : result;
  }));
  try {
    f.platform.enqueue(taskInput('feature')); await f.platform.runTask('feature');
    const candidate = await f.platform.prepareCandidate(['feature'], [plan]);
    expect((await f.platform.verifyCandidate(candidate.id)).status).toBe('failed');
    mismatch = true;
    f.platform.enqueue(taskInput('other', ['feature.txt']));
    expect((await f.platform.runTask('other')).status).toBe('unknown');
  } finally { f.dispose(); }
});

test('invalid state, scope traversal and source-contained data directories are rejected', async () => {
  const f = await fixture(executor(async request => receipt(request)));
  try {
    expect(() => f.platform.enqueue(taskInput('bad', ['../outside']))).toThrow('relative');
    expect(() => f.platform.enqueue(taskInput('bad', ['.git/config']))).toThrow('relative');
    await assertFailure(AgentPlatform.open({ ...f.options, directory: join(f.repository, 'data') }), /outside/);
    createSymbolicLink(f.repository, join(f.root, 'alias'));
    await assertFailure(AgentPlatform.open({ ...f.options, directory: join(f.root, 'alias', 'data') }), /outside/);
    expect(existsSync(join(f.repository, 'data'))).toBe(false);
    await assertFailure(AgentPlatform.open({ ...f.options, executor: { ...f.options.executor, identity: 'test:other-engine' } }), /changed platform configuration/);
    mkdirSync(join(f.directory, 'state.lock'));
    expect(() => f.platform.enqueue(taskInput('locked'))).toThrow();
    expect(existsSync(join(f.directory, 'state.lock'))).toBe(true);
    writeFileSync(join(f.directory, 'state.json'), '{broken');
    expect(() => f.platform.snapshot()).toThrow();
  } finally { f.dispose(); }
});
