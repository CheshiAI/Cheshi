import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { watchFileContents } from '../../scripts/watch-file-contents.mts';

async function waitFor(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(message);
}

test('reports content changes but ignores reads and same-content writes', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'cheshi-content-watch-'));
  const watchedPath = path.join(directory, 'main.mts');
  writeFileSync(watchedPath, 'first\n');
  const changes: string[] = [];
  const watchers = watchFileContents([watchedPath], (filePath) => changes.push(filePath));

  try {
    readFileSync(watchedPath);
    writeFileSync(watchedPath, 'first\n');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(changes, []);

    writeFileSync(watchedPath, 'second\n');
    await waitFor(() => changes.length === 1, 'Expected the changed content to be reported.');
    assert.deepEqual(changes, [watchedPath]);
  } finally {
    for (const watcher of watchers) watcher.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('continues watching after atomic file replacements', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'cheshi-content-watch-'));
  const watchedPath = path.join(directory, 'main.mts');
  writeFileSync(watchedPath, 'first\n');
  const changes: string[] = [];
  const watchers = watchFileContents([watchedPath], (filePath) => changes.push(filePath));

  try {
    for (const [index, content] of ['second\n', 'third\n'].entries()) {
      const replacementPath = path.join(directory, `replacement-${index}.tmp`);
      writeFileSync(replacementPath, content);
      renameSync(replacementPath, watchedPath);
      await waitFor(
        () => changes.length === index + 1,
        `Expected atomic replacement ${index + 1} to be reported.`,
      );
    }
    assert.deepEqual(changes, [watchedPath, watchedPath]);
  } finally {
    for (const watcher of watchers) watcher.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
