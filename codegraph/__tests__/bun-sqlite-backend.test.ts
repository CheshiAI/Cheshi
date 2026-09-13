import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src';

describe('bun:sqlite backend — real index + queries', () => {
  let dir: string;
  let cg: CodeGraph;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-bunsqlite-'));
    fs.writeFileSync(path.join(dir, 'a.ts'), 'export function helper(): number { return 1; }\n');
    fs.writeFileSync(
      path.join(dir, 'b.ts'),
      "import { helper } from './a';\nexport function main(): number { return helper(); }\n"
    );
    cg = await CodeGraph.init(dir, { index: true });
  });

  afterAll(() => {
    cg?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('uses bun:sqlite in WAL mode', () => {
    expect(cg.getBackend()).toBe('bun-sqlite');
    expect(cg.getJournalMode()).toBe('wal');
  });

  it('writes named parameters and indexes both files', () => {
    const stats = cg.getStats();
    expect(stats.fileCount).toBe(2);
    expect(stats.nodeCount).toBeGreaterThan(0);
  });

  it('supports FTS5 search and cross-file traversal', () => {
    const helper = cg.searchNodes('helper').find(result => result.node.name === 'helper');
    expect(helper).toBeTruthy();
    expect(cg.getCallers(helper!.node.id).map(caller => caller.node.name)).toContain('main');
  });
});
