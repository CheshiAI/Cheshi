import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test.skipIf(process.platform !== 'darwin')('AppKit hides only the top decoration and restores its original visibility', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'cheshi-top-highlight-'));
  const native = fileURLToPath(new URL('../native/electron-libghostty/', import.meta.url));
  try {
    const executable = path.join(directory, 'top-highlight-test');
    const compile = spawnSync('/usr/bin/xcrun', ['clang++', '-std=c++17', '-fobjc-arc',
      '-framework', 'AppKit', '-I', path.join(native, 'include'),
      path.join(native, 'src/window_top_highlight.mm'), path.join(native, 'test/window_top_highlight.mm'),
      '-o', executable], { encoding: 'utf8', timeout: 60_000 });
    expect({ status: compile.status, error: compile.error?.message, stderr: compile.stderr })
      .toEqual({ status: 0, error: undefined, stderr: '' });
    // Hidden standalone windows only; never connects to the user's app or data.
    const result = spawnSync(executable, [], { encoding: 'utf8', timeout: 20_000 });
    assertNativeRun(result);
    expect(result.stdout).toContain('Native top highlight targeting, frame preservation and restoration passed.');
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 90_000);

function assertNativeRun(result: ReturnType<typeof spawnSync>): void {
  if (result.status !== 0) {
    throw new Error(`Native test failed (${result.signal ?? result.status}): ${result.error?.message ?? ''}\n${result.stderr}`);
  }
}
