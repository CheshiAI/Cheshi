import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

interface LockDatabase {
  exec(sql: string): unknown;
  close(): void;
}

async function openLockDatabase(filename: string): Promise<LockDatabase> {
  if (process.versions.bun) {
    const { Database } = await import('bun:sqlite');
    return new Database(filename, { create: true });
  }
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(filename);
}

function isBusy(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if ('code' in error && error.code === 'SQLITE_BUSY') return true;
  return 'errcode' in error && typeof error.errcode === 'number' && (error.errcode & 0xff) === 5;
}

function assertWaitAllowed(deadline: number): void {
  if (performance.now() >= deadline) {
    throw new Error('Local history is busy in another app; retry after its current operation finishes.');
  }
}

/**
 * SQLite supplies an OS-backed writer lock, including release on process death.
 * No history is stored in this database. Never unlink it: replacing its inode
 * while another app has it open would create independent locks for one store.
 */
export async function withLocalHistoryLock<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const database = await openLockDatabase(path.join(directory, '.writer-lock.sqlite'));
  try {
    // Poll asynchronously so a competing connection in this process can finish
    // its filesystem awaits. A synchronous busy timeout would block that owner.
    database.exec('PRAGMA busy_timeout = 0');
    const deadline = performance.now() + 10_000;
    for (;;) {
      try {
        database.exec('BEGIN IMMEDIATE');
        break;
      } catch (error) {
        if (!isBusy(error)) throw error;
        assertWaitAllowed(deadline);
        await delay(15);
      }
    }
    return await operation();
  } finally {
    // Closing rolls back the empty transaction and releases the kernel lock.
    database.close();
  }
}
