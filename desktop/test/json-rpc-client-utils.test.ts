import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import test from 'node:test';
import { setImmediate as waitForNextTurn } from 'node:timers/promises';

import {
  JsonRpcRequestTracker,
  SerializedProcessWriter,
  SingleFlight,
} from '../lib/json-rpc-client-utils.mts';
import { loadForgeConfiguration } from './forge-test-helpers.ts';

test('reuses an in-flight operation and starts a new one after completion', async () => {
  const flight = new SingleFlight();
  let operationCount = 0;
  const createOperation = async () => {
    operationCount += 1;
    await waitForNextTurn();
    return `ready-${operationCount}`;
  };

  const first = flight.run(createOperation);
  const second = flight.run(createOperation);
  assert.equal(operationCount, 1);

  assert.equal(await first, 'ready-1');
  assert.equal(await second, 'ready-1');

  assert.equal(await flight.run(createOperation), 'ready-2');
  assert.equal(operationCount, 2);
});

test('permits a retry after an operation fails', async () => {
  const flight = new SingleFlight();
  const failure = new Error('start failed');
  let operationCount = 0;
  const failOperation = async () => {
    operationCount += 1;
    await waitForNextTurn();
    throw failure;
  };
  const first = flight.run(failOperation);
  const second = flight.run(failOperation);

  const results = await Promise.allSettled([first, second]);
  assert.equal(operationCount, 1);
  assert.deepEqual(results, [
    { status: 'rejected', reason: failure },
    { status: 'rejected', reason: failure },
  ]);
  assert.equal(await flight.run(async () => 'recovered'), 'recovered');
});

test('tracks JSON-RPC responses and cleans up a failed send', async () => {
  const tracker = new JsonRpcRequestTracker(
    (method) => new Error(`Request timed out: ${method}.`),
  );
  const requests: unknown[] = [];
  const response = tracker.request('initialize', { root: true }, 1_000, async (request) => {
    requests.push(request);
  });

  assert.deepEqual(requests, [{ id: 1, method: 'initialize', params: { root: true } }]);
  tracker.resolve(1, { ready: true });
  assert.deepEqual(await response, { ready: true });

  const failure = new Error('send failed');
  await assert.rejects(
    tracker.request('shutdown', undefined, 1_000, async () => { throw failure; }),
    failure,
  );
});

test('rejects all outstanding JSON-RPC requests after a client failure', async () => {
  const tracker = new JsonRpcRequestTracker(
    (method) => new Error(`Request timed out: ${method}.`),
  );
  const first = tracker.request('first', undefined, 1_000, async () => {});
  const second = tracker.request('second', undefined, 1_000, async () => {});
  const resultsPromise = Promise.allSettled([first, second]);
  const failure = new Error('client stopped');

  tracker.rejectAll(failure);

  assert.deepEqual(await resultsPromise, [
    { status: 'rejected', reason: failure },
    { status: 'rejected', reason: failure },
  ]);
});

test('serializes process writes and rejects an unavailable input', async () => {
  const chunks: string[] = [];
  const callbacks: Array<(error?: Error | null) => void> = [];
  const input = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callbacks.push(callback);
    },
  });
  const writer = new SerializedProcessWriter(
    () => input,
    () => new Error('input unavailable'),
  );
  const first = writer.write('first');
  const second = writer.write('second');

  await waitForNextTurn();
  assert.deepEqual(chunks, ['first']);
  const completeFirstWrite = callbacks.shift();
  if (!completeFirstWrite) throw new Error('The first write callback was not captured.');
  completeFirstWrite();
  await first;

  await waitForNextTurn();
  assert.deepEqual(chunks, ['first', 'second']);
  const completeSecondWrite = callbacks.shift();
  if (!completeSecondWrite) throw new Error('The second write callback was not captured.');
  completeSecondWrite();
  await second;

  const unavailableWriter = new SerializedProcessWriter(
    () => null,
    () => new Error('input unavailable'),
  );
  await assert.rejects(unavailableWriter.write('unavailable'), /input unavailable/u);
});

test('rejects a broken process pipe without an uncaught stream error', async () => {
  const failure = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
  const input = new Writable({
    write(_chunk, _encoding, callback) {
      callback(failure);
    },
  });
  const writer = new SerializedProcessWriter(
    () => input,
    () => new Error('input unavailable'),
  );

  await assert.rejects(writer.write('request'), failure);
  await waitForNextTurn();
  assert.equal(input.errored, failure);
});

test('includes the shared JSON-RPC utilities in packaged desktop builds', async () => {
  const configuration = await loadForgeConfiguration();
  const shouldIgnore = configuration.packagerConfig.ignore;
  if (typeof shouldIgnore !== 'function') throw new Error('Forge ignore configuration is unavailable.');
  assert.equal(shouldIgnore('/desktop/lib/json-rpc-client-utils.mts'), false);
});
