import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { hasReadyCodeGraphIndex, InitialCodeGraphIndexes } from '../lib/codegraph-initial-index.mts';

type Options = Parameters<InitialCodeGraphIndexes['ensure']>[0];
type IndexerFactory = NonNullable<ConstructorParameters<typeof InitialCodeGraphIndexes>[0]>;

function createDeferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cheshi-initial-index-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  function options(name = 'project', signal = new AbortController().signal): Options {
    return {
      databasePath: path.join(root, 'data', name, 'codegraph.db'),
      workspaceRoot: path.join(root, name),
      dataRoot: path.join(root, 'data'),
      command: { executable: 'unused-injected-indexer', args: [] },
      signal,
    };
  }
  return { options };
}

function writeDatabase(options: Options, contents = 'complete index') {
  mkdirSync(path.dirname(options.databasePath), { recursive: true });
  writeFileSync(options.databasePath, contents);
}

function fakeIndexer(run: (method: 'initialize' | 'reindex', workspaceRoot: string, dataRoot: string) => Promise<void>) {
  let stops = 0;
  return {
    initialize: (workspaceRoot: string, dataRoot: string) => run('initialize', workspaceRoot, dataRoot),
    reindex: (workspaceRoot: string, dataRoot: string) => run('reindex', workspaceRoot, dataRoot),
    stop: async () => { stops += 1; },
    get stops() { return stops; },
  };
}

test('an existing ready index is reused without constructing a writer or notifying indexing', async (t) => {
  const { options } = fixture(t);
  const target = options();
  writeDatabase(target, 'existing contents');
  const indexes = new InitialCodeGraphIndexes(() => { throw new Error('must not create writer'); });
  await indexes.ensure({ ...target, onIndexing: () => assert.fail('must not report indexing') });
  assert.equal(hasReadyCodeGraphIndex(target.databasePath), true);
  assert.equal(readFileSync(target.databasePath, 'utf8'), 'existing contents');
});

test('a missing database is initialized with the workspace and central data root before becoming ready', async (t) => {
  const target = fixture(t).options();
  let notifications = 0;
  const indexes = new InitialCodeGraphIndexes((received) => {
    assert.equal(received.command, target.command);
    return fakeIndexer(async (method, workspaceRoot, dataRoot) => {
      assert.equal(method, 'initialize');
      assert.equal(workspaceRoot, target.workspaceRoot);
      assert.equal(dataRoot, target.dataRoot);
      assert.equal(existsSync(`${target.databasePath}.initializing`), true);
      writeDatabase(target);
      assert.equal(hasReadyCodeGraphIndex(target.databasePath), false);
    });
  });
  await indexes.ensure({ ...target, onIndexing: () => { notifications += 1; } });
  assert.equal(notifications, 1);
  assert.equal(hasReadyCodeGraphIndex(target.databasePath), true);
  assert.equal(existsSync(`${target.databasePath}.initializing`), false);
});

test('a ready database appearing before the scheduled writer starts is preserved', async (t) => {
  const target = fixture(t).options();
  const indexes = new InitialCodeGraphIndexes(() => fakeIndexer(async () => {
    assert.fail('must not overwrite the completed database');
  }));
  const ready = indexes.ensure(target);
  writeDatabase(target, 'completed by another operation');
  await ready;
  assert.equal(readFileSync(target.databasePath, 'utf8'), 'completed by another operation');
  assert.equal(existsSync(`${target.databasePath}.initializing`), false);
});

test('another window waits for the same writer even after its database file appears', async (t) => {
  const target = fixture(t).options();
  const started = createDeferred();
  const finish = createDeferred();
  let writers = 0;
  const indexes = new InitialCodeGraphIndexes(() => {
    writers += 1;
    return fakeIndexer(async () => {
      writeDatabase(target, 'partial contents');
      started.resolve();
      await finish.promise;
      writeDatabase(target);
    });
  });
  const first = indexes.ensure(target);
  await started.promise;
  let secondReady = false;
  const second = indexes.ensure({ ...target, databasePath: path.join(path.dirname(target.databasePath), '.', 'codegraph.db') })
    .then(() => { secondReady = true; });
  await setImmediate();
  assert.equal(writers, 1);
  assert.equal(secondReady, false);
  assert.equal(hasReadyCodeGraphIndex(target.databasePath), false);
  finish.resolve();
  await Promise.all([first, second]);
  assert.equal(secondReady, true);
  assert.equal(readFileSync(target.databasePath, 'utf8'), 'complete index');
});

test('different workspaces have independent writers and completion', async (t) => {
  const { options } = fixture(t);
  const firstTarget = options('first');
  const secondTarget = options('second');
  const finishFirst = createDeferred();
  const startedFirst = createDeferred();
  const roots: string[] = [];
  const indexes = new InitialCodeGraphIndexes((target) => fakeIndexer(async () => {
    roots.push(target.workspaceRoot);
    if (target.workspaceRoot === firstTarget.workspaceRoot) {
      startedFirst.resolve();
      await finishFirst.promise;
    }
    writeDatabase(target);
  }));
  const first = indexes.ensure(firstTarget);
  await startedFirst.promise;
  await indexes.ensure(secondTarget);
  assert.deepEqual(roots, [firstTarget.workspaceRoot, secondTarget.workspaceRoot]);
  assert.equal(hasReadyCodeGraphIndex(firstTarget.databasePath), false);
  assert.equal(hasReadyCodeGraphIndex(secondTarget.databasePath), true);
  finishFirst.resolve();
  await first;
});

test('failed partial initialization stays unreadable and is reindexed on retry', async (t) => {
  const target = fixture(t).options();
  const methods: string[] = [];
  const indexes = new InitialCodeGraphIndexes(() => fakeIndexer(async (method) => {
    methods.push(method);
    if (methods.length === 1) {
      writeDatabase(target, 'partial contents');
      throw new Error('worker failed');
    }
    writeDatabase(target);
  }));
  await assert.rejects(indexes.ensure(target), /worker failed/);
  assert.equal(existsSync(`${target.databasePath}.initializing`), true);
  assert.equal(hasReadyCodeGraphIndex(target.databasePath), false);
  await indexes.ensure(target);
  assert.deepEqual(methods, ['initialize', 'reindex']);
  assert.equal(hasReadyCodeGraphIndex(target.databasePath), true);
});

test('successful worker exit without a database remains a retryable initialization failure', async (t) => {
  const target = fixture(t).options();
  const methods: string[] = [];
  const indexes = new InitialCodeGraphIndexes(() => fakeIndexer(async (method) => {
    methods.push(method);
    if (methods.length > 1) writeDatabase(target);
  }));
  await assert.rejects(indexes.ensure(target), /did not create an index/);
  assert.equal(hasReadyCodeGraphIndex(target.databasePath), false);
  assert.equal(existsSync(`${target.databasePath}.initializing`), true);
  await indexes.ensure(target);
  assert.deepEqual(methods, ['initialize', 'initialize']);
});

test('closing one subscribing window does not stop indexing needed by another window', async (t) => {
  const target = fixture(t).options();
  const closed = new AbortController();
  const started = createDeferred();
  const finish = createDeferred();
  const indexer = fakeIndexer(async () => {
    started.resolve();
    await finish.promise;
    writeDatabase(target);
  });
  const indexes = new InitialCodeGraphIndexes(() => indexer);
  const first = indexes.ensure({ ...target, signal: closed.signal });
  const firstRejected = assert.rejects(first, /window closed/);
  const second = indexes.ensure(target);
  await started.promise;
  closed.abort(new Error('window closed'));
  await firstRejected;
  assert.equal(indexer.stops, 0);
  finish.resolve();
  await second;
  assert.equal(hasReadyCodeGraphIndex(target.databasePath), true);
  assert.equal(indexer.stops, 0);
});

test('closing all windows stops their writer and a new window waits for it before retrying', async (t) => {
  const target = fixture(t).options();
  const firstClosed = new AbortController();
  const secondClosed = new AbortController();
  const started = createDeferred();
  const work = createDeferred();
  const stopping = createDeferred();
  const stopped = createDeferred();
  const methods: string[] = [];
  let writers = 0;
  let stops = 0;
  const factory: IndexerFactory = () => {
    writers += 1;
    if (writers > 1) return fakeIndexer(async (method) => { methods.push(method); writeDatabase(target); });
    return {
      initialize: async () => {
        methods.push('initialize');
        writeDatabase(target, 'partial contents');
        started.resolve();
        await work.promise;
      },
      reindex: async () => assert.fail('first writer must initialize'),
      stop: async () => {
        stops += 1;
        stopping.resolve();
        await stopped.promise;
        work.reject(new Error('worker stopped'));
      },
    };
  };
  const indexes = new InitialCodeGraphIndexes(factory);
  const firstRejected = assert.rejects(indexes.ensure({ ...target, signal: firstClosed.signal }), /first closed/);
  const secondRejected = assert.rejects(indexes.ensure({ ...target, signal: secondClosed.signal }), /second closed/);
  await started.promise;
  firstClosed.abort(new Error('first closed'));
  await firstRejected;
  assert.equal(stops, 0);
  secondClosed.abort(new Error('second closed'));
  await stopping.promise;
  const retry = indexes.ensure(target);
  await setImmediate();
  assert.equal(writers, 1);
  assert.equal(stops, 1);
  assert.equal(hasReadyCodeGraphIndex(target.databasePath), false);
  stopped.resolve();
  await Promise.all([secondRejected, retry]);
  assert.equal(writers, 2);
  assert.deepEqual(methods, ['initialize', 'reindex']);
  assert.equal(hasReadyCodeGraphIndex(target.databasePath), true);
});

test('an already closed window never creates a writer or an incomplete marker', async (t) => {
  const target = fixture(t).options();
  const closed = new AbortController();
  closed.abort(new Error('already closed'));
  const indexes = new InitialCodeGraphIndexes(() => { throw new Error('must not create writer'); });
  await assert.rejects(indexes.ensure({ ...target, signal: closed.signal }), /already closed/);
  assert.equal(existsSync(`${target.databasePath}.initializing`), false);
});
