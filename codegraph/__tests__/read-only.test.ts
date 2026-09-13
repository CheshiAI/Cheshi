import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph, { DatabaseConnection, getDatabasePath } from '../src';

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

describe('read-only database opens', () => {
  let root: string;
  let dbPath: string;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-read-only-'));
    fs.writeFileSync(path.join(root, 'index.ts'), 'export function answer() { return 42; }\n');
    const cg = CodeGraph.initSync(root);
    await cg.indexAll();
    cg.close();
    dbPath = getDatabasePath(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('opens through CodeGraph without changing database files and rejects writes', async () => {
    const beforeStat = fs.statSync(dbPath);
    const beforeFiles = fs.readdirSync(path.dirname(dbPath)).sort();

    const cg = await CodeGraph.open(root, { readOnly: true });
    try {
      expect(cg.searchNodes('answer').length).toBeGreaterThan(0);
      expect(() => cg.clear()).toThrow(/read-only mode/);
      await expectRejection(cg.sync(), (error) => {
        if (!(error instanceof Error)) throw new Error('Expected sync to reject with an Error');
        expect(error.message).toMatch(/read-only mode/);
      });
    } finally {
      cg.close();
    }

    const afterStat = fs.statSync(dbPath);
    expect(afterStat.size).toBe(beforeStat.size);
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
    expect(fs.readdirSync(path.dirname(dbPath)).sort()).toEqual(beforeFiles);
  });

  it('passes the read-only flag to SQLite itself', () => {
    const db = DatabaseConnection.open(dbPath, { readOnly: true });
    try {
      expect(db.isReadOnly()).toBe(true);
      expect(() => {
        db.getDb().prepare('UPDATE project_metadata SET value = ? WHERE key = ?').run('changed', 'index_state');
      }).toThrow();
    } finally {
      db.close();
    }
  });

  it('reads committed rows from a live WAL instead of taking a stale immutable snapshot', () => {
    const writer = DatabaseConnection.open(dbPath);
    try {
      writer.setWalAutocheckpoint(0);
      writer.getDb().prepare(
        'INSERT OR REPLACE INTO project_metadata (key, value, updated_at) VALUES (?, ?, ?)',
      ).run('read_only_wal_probe', 'visible', Date.now());
      expect(fs.statSync(`${dbPath}-wal`).size).toBeGreaterThan(0);

      const reader = DatabaseConnection.open(dbPath, { readOnly: true });
      try {
        const row = reader.getDb().prepare(
          'SELECT value FROM project_metadata WHERE key = ?',
        ).get('read_only_wal_probe') as { value: string } | undefined;
        expect(row?.value).toBe('visible');
      } finally {
        reader.close();
      }
    } finally {
      writer.close();
    }
  });

  it('does not repair a missing .gitignore while opening read-only', async () => {
    const gitignore = path.join(root, '.codegraph', '.gitignore');
    fs.unlinkSync(gitignore);

    const cg = await CodeGraph.open(root, { readOnly: true });
    cg.close();

    expect(fs.existsSync(gitignore)).toBe(false);
  });

  it('rejects sync-on-open before opening a read-only connection', async () => {
    await expectRejection(CodeGraph.open(root, { readOnly: true, sync: true }), (error) => {
      if (!(error instanceof Error)) throw new Error('Expected open to reject with an Error');
      expect(error.message).toMatch(/Cannot sync.*read-only mode/);
    });
  });

  it('refuses to migrate an old schema in read-only mode', () => {
    const writable = DatabaseConnection.open(dbPath);
    writable.getDb().exec('DELETE FROM schema_versions WHERE version = (SELECT MAX(version) FROM schema_versions)');
    writable.close();
    const before = fs.statSync(dbPath);

    expect(() => DatabaseConnection.open(dbPath, { readOnly: true })).toThrow(/requires migration/);

    const after = fs.statSync(dbPath);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });
});
