import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src';
import { ParseWorkerPool } from '../src/extraction/parse-pool';
import { StoreWriter } from '../src/extraction/store-writer';

async function expectRejection(
  operation: Promise<unknown>,
  validate: (error: unknown) => void,
): Promise<void> {
  try {
    await operation;
  } catch (error) {
    validate(error);
    return;
  }
  throw new Error('Expected operation to reject');
}

describe('bulk worker cleanup', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-worker-cleanup-'));
    fs.writeFileSync(path.join(root, 'index.ts'), 'export function answer() { return 42; }\n');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('closes the store writer and parse pool when storing rejects', async () => {
    const previousWorkerCount = process.env.CODEGRAPH_PARSE_WORKERS;
    const previousStoreWorkerSetting = process.env.CODEGRAPH_NO_STORE_WORKER;
    process.env.CODEGRAPH_PARSE_WORKERS = '1';
    delete process.env.CODEGRAPH_NO_STORE_WORKER;

    const originalClose = StoreWriter.prototype.close;
    const originalDestroy = ParseWorkerPool.prototype.destroy;
    const waitSpy = spyOn(StoreWriter.prototype, 'waitBelow')
      .mockRejectedValue(new Error('injected store failure'));
    const closeSpy = spyOn(StoreWriter.prototype, 'close')
      .mockImplementation(function (this: StoreWriter) {
        return originalClose.call(this);
      });
    const destroySpy = spyOn(ParseWorkerPool.prototype, 'destroy')
      .mockImplementation(function (this: ParseWorkerPool) {
        return originalDestroy.call(this);
      });
    const cg = CodeGraph.initSync(root);

    try {
      await expectRejection(cg.indexAll(), (error) => {
        if (!(error instanceof Error)) throw new Error('Expected an Error rejection');
        expect(error.message).toContain('injected store failure');
      });
      expect(waitSpy).toHaveBeenCalled();
      expect(closeSpy).toHaveBeenCalledTimes(1);
      expect(destroySpy).toHaveBeenCalledTimes(1);
    } finally {
      cg.close();
      destroySpy.mockRestore();
      closeSpy.mockRestore();
      waitSpy.mockRestore();
      if (previousWorkerCount === undefined) delete process.env.CODEGRAPH_PARSE_WORKERS;
      else process.env.CODEGRAPH_PARSE_WORKERS = previousWorkerCount;
      if (previousStoreWorkerSetting === undefined) delete process.env.CODEGRAPH_NO_STORE_WORKER;
      else process.env.CODEGRAPH_NO_STORE_WORKER = previousStoreWorkerSetting;
    }
  });
});
