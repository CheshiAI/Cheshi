/**
 * SQLite backend reporting.
 *
 * bun:sqlite (Bun's built-in real SQLite) is the sole backend. Pin that
 * DatabaseConnection / CodeGraph report it and come up in WAL.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DatabaseConnection } from '../src';
import { CodeGraph } from '../src';

describe('DatabaseConnection — backend reporting', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-backend-'));
  });

  afterEach(() => {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports the bun-sqlite backend in WAL for an initialized DB', () => {
    const conn = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    expect(conn.getBackend()).toBe('bun-sqlite');
    expect(conn.getJournalMode()).toBe('wal');
    conn.close();
  });

  it('normalizes a missing statement row to the adapter undefined contract', () => {
    const conn = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    expect(conn.getDb().prepare('SELECT 1 WHERE 0').get()).toBeUndefined();
    conn.close();
  });

  it('CodeGraph.getBackend() delegates to the underlying DatabaseConnection', async () => {
    fs.writeFileSync(path.join(dir, 'x.ts'), `export function x(): void {}\n`);
    const cg = await CodeGraph.init(dir, { index: true });
    try {
      expect(cg.getBackend()).toBe('bun-sqlite');
    } finally {
      cg.close();
    }
  });
});
