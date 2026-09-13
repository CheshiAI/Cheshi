/**
 * PPID watchdog regression test (#277).
 *
 * On Linux, when an MCP host (Claude Code, opencode, …) is SIGKILL'd by the
 * OOM killer / a force-quit / a container teardown, the kernel does NOT
 * propagate the death to its `codegraph serve --mcp` child. The child gets
 * reparented to init/systemd, its stdin stays half-open in some
 * configurations, and the existing `stdin.on('end' | 'close')` handlers
 * never fire — the server lingers indefinitely, holding inotify watches,
 * file descriptors, and the SQLite WAL.
 *
 * `src/mcp/index.ts` polls `process.ppid` and shuts down the moment it
 * diverges from the value observed at startup. This test stands up a
 * four-tier process tree (test runner → wrapper → {stdin-holder, codegraph}) and
 * SIGKILL's the wrapper. The stdin-holder is a long-lived sibling whose
 * `stdout` pipe is dup'd into codegraph's `stdin`. After the wrapper dies
 * the pipe stays open (stdin-holder still owns the write-end), so the
 * existing stdin close handlers do **not** fire — the only thing that can
 * terminate codegraph then is the PPID watchdog.
 *
 * Windows is excluded — `process.kill(pid, 'SIGKILL')` does not actually
 * deliver SIGKILL there, and the per-OS reparenting semantics the watchdog
 * relies on are POSIX-specific.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const BIN = path.resolve(__dirname, '../src/bin/codegraph.ts');

//noinspection DuplicatedCode
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (!isAlive(pid)) return resolve(true);
      if (Date.now() - start > timeoutMs) return resolve(false);
      setTimeout(tick, 100);
    };
    tick();
  });
}

describe.skipIf(process.platform === 'win32')('MCP PPID watchdog (#277)', () => {
  let wrapper: ChildProcessWithoutNullStreams | null = null;
  let childPid: number | null = null;
  let stdinHolderPid: number | null = null;
  let tempDir: string | null = null;

  afterEach(() => {
    if (wrapper && !wrapper.killed) {
      try { wrapper.kill('SIGKILL'); } catch { /* already gone */ }
    }
    // Belt and suspenders — don't leak processes if an assertion failed.
    for (const pid of [childPid, stdinHolderPid]) {
      if (pid !== null && isAlive(pid)) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
      }
    }
    wrapper = null;
    childPid = null;
    stdinHolderPid = null;
    if (tempDir !== null) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("shuts down when its parent is SIGKILL'd and stdin stays open", async () => {
    // The POSIX shell wrapper:
    //   1. Spawns a "stdin-holder" — a tiny long-lived Bun process whose
    //      `stdout` is connected to codegraph's `stdin` through an OS FIFO.
    //      As long as the stdin-holder is alive (it is — it's an orphan after
    //      the wrapper dies), codegraph's stdin never sees EOF.
    //   2. Spawns codegraph with that pipe as fd 0 and its stderr redirected
    //      to a tmp file that survives the wrapper, then reports both PIDs.
    //   3. Idles until SIGKILL'd from the test.
    //
    // CODEGRAPH_PPID_POLL_MS=200 keeps the PPID watchdog responsive in test;
    // CODEGRAPH_NO_WATCHDOG=1 disables only the unrelated main-thread
    // liveness child. The production PPID default is 5000ms.
    // Bun's Node-compatible child_process.spawn does not support passing a
    // ChildProcess Readable as another child's stdio fd. A named POSIX FIFO
    // preserves the same kernel-level topology without a parent-side stream
    // pump (which would close codegraph's stdin when the wrapper is killed).
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ppid-watchdog-'));
    const stderrLog = path.join(tempDir, 'codegraph.stderr.log');
    const stdinFifo = path.join(tempDir, 'stdin.fifo');
    // The wrapper waits 800ms before reporting the PIDs so the codegraph
    // child has time to finish its async start() (dynamic import + transport
    // setup + watchdog registration). Otherwise the test races: it
    // SIGKILL's the wrapper before the watchdog interval is installed, and
    // nothing terminates codegraph.
    const wrapperSrc = `
      set -eu
      unset CODEGRAPH_HOST_PPID
      mkfifo "$CG_WATCHDOG_FIFO"
      "$CG_BUN_EXEC" -e 'setInterval(() => {}, 60000)' \
        </dev/null >"$CG_WATCHDOG_FIFO" 2>/dev/null &
      stdin_holder_pid=$!
      CODEGRAPH_PPID_POLL_MS=200 CODEGRAPH_NO_DAEMON=1 CODEGRAPH_NO_WATCHDOG=1 \
        "$CG_BUN_EXEC" "$CG_WATCHDOG_BIN" serve --mcp \
        <"$CG_WATCHDOG_FIFO" >/dev/null 2>>"$CG_WATCHDOG_STDERR" &
      child_pid=$!
      sleep 0.8
      printf '{"pid":%s,"stdinHolderPid":%s}\n' "$child_pid" "$stdin_holder_pid"
      wait
    `;
    wrapper = spawn('/bin/sh', ['-c', wrapperSrc], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CG_BUN_EXEC: process.execPath,
        CG_WATCHDOG_BIN: BIN,
        CG_WATCHDOG_FIFO: stdinFifo,
        CG_WATCHDOG_STDERR: stderrLog,
      },
    }) as ChildProcessWithoutNullStreams;

    const pids = await new Promise<{ pid: number; stdinHolderPid: number }>((resolve, reject) => {
      let buf = '';
      let wrapperStderr = '';
      const timer = setTimeout(
        () => reject(new Error(`wrapper did not report PIDs in time\nstderr:\n${wrapperStderr}`)),
        10000,
      );
      wrapper!.stderr.on('data', (chunk: Buffer) => {
        wrapperStderr += chunk.toString('utf8');
      });
      wrapper!.stdout.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        const m = buf.match(/\{"pid":(\d+),"stdinHolderPid":(\d+)}/);
        if (m) {
          clearTimeout(timer);
          resolve({ pid: parseInt(m[1], 10), stdinHolderPid: parseInt(m[2], 10) });
        }
      });
      wrapper!.on('exit', () => {
        clearTimeout(timer);
        reject(new Error(`wrapper exited before reporting PIDs\nstderr:\n${wrapperStderr}`));
      });
    });
    childPid = pids.pid;
    stdinHolderPid = pids.stdinHolderPid;

    expect(isAlive(childPid)).toBe(true);
    expect(isAlive(stdinHolderPid)).toBe(true);

    // SIGKILL the wrapper — no cleanup runs, just like a real OOM kill.
    // codegraph and the stdin-holder both get reparented to init/systemd.
    // Crucially, the pipe between them stays open, so codegraph's stdin
    // doesn't close: only the watchdog can take it down.
    wrapper.kill('SIGKILL');

    // Watchdog runs every 200ms in this test → 5s gives ~25 polls of headroom.
    const exited = await waitForExit(childPid, 5000);
    const stderrContent = fs.existsSync(stderrLog) ? fs.readFileSync(stderrLog, 'utf-8') : '<no stderr captured>';
    expect(
      exited,
      `codegraph child (pid=${childPid}) did not exit within 5s after wrapper was SIGKILL'd.\nstderr:\n${stderrContent}`,
    ).toBe(true);
    // The watchdog announces itself before tearing down — assert that the
    // shutdown came from the parent-death path, not from any other signal.
    expect(stderrContent).toMatch(/Parent process exited.*shutting down/);

    // The stdin-holder is now an orphan — kill it explicitly so it doesn't
    // outlive the test. It's still tracked in `stdinHolderPid` for the
    // afterEach safety net, but we tidy up proactively here too.
    if (isAlive(stdinHolderPid)) {
      try { process.kill(stdinHolderPid, 'SIGKILL'); } catch { /* race */ }
    }
  }, 20000);
});
