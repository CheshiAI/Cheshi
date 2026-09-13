import { describe, it, expect } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * #1139: every Git subprocess call must be time-bounded. A stuck Git
 * (network filesystem, wedged fsmonitor daemon) otherwise blocks the caller
 * forever — worst on the daemon's main event loop, where `gitWorktreeRoot`/
 * `gitCommonDir` run (memoized) while serving MCP clients and an unbounded
 * hang would trip the 60s liveness watchdog and SIGKILL a healthy daemon.
 * `extraction/index.ts` already passes a timeout on every git call; these
 * tests pin the same convention on the stragglers it flagged.
 */

const SUBPROCESS_MODULES: string[] = [
  'src/sync/worktree.ts',
  'src/sync/git-hooks.ts',
];

const MAX_GIT_TIMEOUT_MS = 30_000;

function subprocessCallSites(source: string): string[] {
  return source.split(/\bexec(?:File)?Sync\(/).slice(1);
}

function timeoutFromCallSite(callSite: string): number | null {
  // Every current call keeps its options object close to the invocation. A
  // bounded slice also prevents a later call's timeout from satisfying this
  // call accidentally.
  const match = callSite.slice(0, 400).match(/\btimeout\s*:\s*([0-9][0-9_]*)/);
  return match ? Number(match[1]!.replaceAll('_', '')) : null;
}

describe('no exec*Sync call site in these modules is unbounded (#1139)', () => {
  // A source-level sweep covers exported helpers and the non-exported
  // `gitHooksDir` without installing a process-wide child_process module mock.
  // Bun runs test files in one process, so such a module mock could leak into
  // later suites and invalidate their real subprocess behavior.
  it.each(SUBPROCESS_MODULES)('%s passes a bounded timeout at every exec*Sync call site', (rel) => {
    const src = fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
    const sites = subprocessCallSites(src);
    expect(sites.length).toBeGreaterThan(0);
    for (const [index, site] of sites.entries()) {
      const timeout = timeoutFromCallSite(site);
      if (timeout === null) {
        throw new Error(`${rel} exec*Sync call ${index + 1} has no numeric timeout`);
      }
      expect(timeout).toBeGreaterThan(0);
      expect(timeout).toBeLessThanOrEqual(MAX_GIT_TIMEOUT_MS);
    }
  });
});
