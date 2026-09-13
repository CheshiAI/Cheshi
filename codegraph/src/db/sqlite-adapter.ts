/**
 * SQLite Adapter
 *
 * Thin wrapper over Bun's built-in `bun:sqlite`, exposed through a small
 * better-sqlite3-shaped interface so the rest of the codebase is
 * storage-agnostic.
 *
 * `bun:sqlite` is real SQLite with WAL + FTS5, so there is no native build
 * step and no wasm fallback.
 */

import { Database } from 'bun:sqlite';
import { pathToFileURL } from 'node:url';

interface SqliteOpenOptions {
  readOnly?: boolean;
  immutable?: boolean;
}

export interface SqliteStatement {
  run(...params: any[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: any[]): any;
  all(...params: any[]): any[];
  /**
   * Lazily yield result rows one at a time instead of materializing the whole
   * set with `all()`. Use for unbounded scans (e.g. every function/method node)
   * so memory stays O(1) in the row count rather than O(rows) — see #610, where
   * `all()`-ing every symbol on a dense project spiked the heap into an OOM.
   */
  iterate(...params: any[]): IterableIterator<any>;
}

export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  pragma(str: string, options?: { simple?: boolean }): any;
  transaction<T>(fn: (...args: any[]) => T): (...args: any[]) => T;
  close(): void;
  readonly open: boolean;
}

/**
 * The active SQLite backend. Only one now (`bun:sqlite`); kept as a named type
 * so `codegraph status` and the per-instance reporting have a stable shape.
 */
export type SqliteBackend = 'bun-sqlite';

/**
 * Wraps Bun's built-in `bun:sqlite` to match the better-sqlite3 interface the
 * rest of the code expects.
 *
 * Bun's SQLite driver supports WAL, FTS5, mmap, and `@named` params natively.
 * `strict: true` preserves the existing bare-key binding contract (`@name` in
 * SQL with `{ name: value }` in TypeScript).
 */
class BunSqliteAdapter implements SqliteDatabase {
  private _db: Database;
  private _txDepth = 0;
  private _open = true;

  constructor(dbPath: string, opts: SqliteOpenOptions = {}) {
    const readOnly = opts.readOnly === true;
    // A clean WAL-mode database often has no `-wal` sidecar. SQLite's plain
    // READONLY open then tries to establish WAL shared-memory state and can
    // fail on genuinely read-only media (or even with a leftover `-shm` and no
    // `-wal`). `immutable=1` is the supported no-sidecar snapshot mode. The
    // caller enables it only when there are no WAL frames to replay.
    const filename = readOnly && opts.immutable === true
      ? (() => {
          const url = pathToFileURL(dbPath);
          url.searchParams.set('immutable', '1');
          return url.href;
        })()
      : dbPath;
    this._db = new Database(filename, readOnly
      ? { readonly: true, strict: true }
      : { create: true, readwrite: true, strict: true });
  }

  get open(): boolean {
    return this._open;
  }

  prepare(sql: string): SqliteStatement {
    // bun:sqlite matches better-sqlite3's calling convention (variadic
    // positional args, or a single object for @named params), so params forward
    // through unchanged.
    const stmt = this._db.prepare(sql);
    return {
      run(...params: any[]) {
        const r = stmt.run(...params);
        return {
          changes: Number(r?.changes ?? 0),
          lastInsertRowid: r?.lastInsertRowid ?? 0,
        };
      },
      get(...params: any[]) {
        // better-sqlite3 returns `undefined` when a query has no row, while
        // bun:sqlite returns `null`. QueryBuilder's absence checks were built
        // against the former contract, so normalize the one semantic mismatch
        // at the adapter boundary instead of teaching every query both shapes.
        const row = stmt.get(...params);
        return row === null ? undefined : row;
      },
      all(...params: any[]) {
        return stmt.all(...params);
      },
      iterate(...params: any[]) {
        return stmt.iterate(...params);
      },
    };
  }

  exec(sql: string): void {
    this._db.run(sql);
  }

  pragma(str: string, options?: { simple?: boolean }): any {
    const trimmed = str.trim();
    // Write pragma ("key = value"): bun:sqlite is real SQLite, so every pragma
    // (WAL, mmap, synchronous, …) applies as-is.
    if (trimmed.includes('=')) {
      this._db.run(`PRAGMA ${trimmed}`);
      return;
    }
    // Read pragma. Default: the row object (e.g. { journal_mode: 'wal' }).
    // `{ simple: true }` returns just the single column value, like better-sqlite3.
    const row = this._db.prepare(`PRAGMA ${trimmed}`).get();
    if (options?.simple) {
      return row && typeof row === 'object' ? Object.values(row)[0] : row;
    }
    return row;
  }

  transaction<T>(fn: (...args: any[]) => T): (...args: any[]) => T {
    return (...args: any[]) => {
      // Nested call (a transaction()-wrapped helper invoked from inside another
      // transaction): run the body directly inside the enclosing transaction.
      // BEGIN would throw "cannot start a transaction within a transaction",
      // so no existing caller ever relied on nested rollback granularity —
      // flattening is behavior-preserving and free.
      if (this._txDepth > 0) {
        this._txDepth++;
        try {
          return fn(...args);
        } finally {
          this._txDepth--;
        }
      }
      this._db.run('BEGIN');
      this._txDepth = 1;
      try {
        const result = fn(...args);
        this._db.run('COMMIT');
        this._txDepth = 0;
        return result;
      } catch (error) {
        // Preserve the operation's original failure when SQLite has already
        // ended the transaction (for example after an interrupted write).
        // A cleanup error must not replace the useful root cause with
        // "cannot rollback - no transaction is active".
        try {
          this._db.run('ROLLBACK');
        } catch {
          // The transaction is already gone; there is nothing left to roll
          // back. The original error is rethrown below.
        }
        this._txDepth = 0;
        throw error;
      }
    };
  }

  close(): void {
    if (!this._open) return;
    this._db.close();
    this._open = false;
  }
}

/**
 * Create a database connection backed by `bun:sqlite`.
 *
 * Returns the active backend alongside the db so each `DatabaseConnection` can
 * report it per-instance — MCP can open multiple project DBs in one process, so
 * a process-global would race.
 */
export function createDatabase(dbPath: string, opts?: SqliteOpenOptions): { db: SqliteDatabase; backend: SqliteBackend } {
  try {
    return { db: new BunSqliteAdapter(dbPath, opts), backend: 'bun-sqlite' };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(
      'Failed to open SQLite via Bun\'s built-in bun:sqlite module.\n' +
      'CodeGraph requires Bun 1.3.14 or newer.\n' +
      `Underlying error: ${msg}`
    );
  }
}
