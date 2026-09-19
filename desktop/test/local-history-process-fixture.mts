import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { acquireLocalHistory } from '../lib/local-history-runtime.mts';
import { withLocalHistoryLock } from '../lib/local-history-lock.mts';

const options = JSON.parse(process.argv[2]!) as {
  workspaceRoot: string;
  directory: string;
  mode: 'capture' | 'hold';
  paths?: string[];
};

if (options.mode === 'hold') {
  await withLocalHistoryLock(options.directory, async () => {
    await writeFile(path.join(options.directory, 'history.json.12345678-1234-1234-1234-123456789012.tmp'), 'interrupted');
    await writeFile(path.join(options.directory, `${'0'.repeat(64)}.txt`), 'uncommitted blob');
    process.send?.({ ready: true });
    await new Promise<void>((resolve) => process.once('message', () => resolve()));
  });
} else {
  const errors: string[] = [];
  const history = acquireLocalHistory({ ...options, onError: error => errors.push(error.message) });
  try {
    // Both apps load the same initial manifest before the parent releases them.
    await history.list('initial.txt');
    const start = new Promise<void>((resolve) => process.once('message', () => resolve()));
    process.send?.({ ready: true });
    await start;
    for (const filePath of options.paths ?? []) await history.readFile(filePath);
    process.send?.({ errors });
  } finally {
    await history.dispose();
  }
}
process.disconnect?.();
