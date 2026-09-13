import * as fs from 'node:fs';

const [parentPidValue, timeoutValue, capValue, ...progressPaths] = process.argv.slice(2);
const parentPid = Number(parentPidValue);
const timeoutMs = Number(timeoutValue);
const capMs = Number(capValue);

if (
  !Number.isInteger(parentPid)
  || parentPid <= 0
  || !Number.isFinite(timeoutMs)
  || timeoutMs <= 0
  || !Number.isFinite(capMs)
  || capMs < timeoutMs
) {
  process.stderr.write('Invalid CodeGraph watchdog arguments.\n');
  process.exit(2);
}

const seconds = Math.round(timeoutMs / 1000);

function killParent(extra = ''): void {
  const message = `[${new Date().toISOString()}] [CodeGraph] Main thread unresponsive for ~${seconds}s${extra} — killing the wedged process so a fresh one can start (#850). Disable with CODEGRAPH_NO_WATCHDOG=1.\n`;
  try {
    fs.writeSync(2, Buffer.from(message));
  } catch {
    // The parent may already have closed stderr.
  }
  try {
    process.kill(parentPid, 'SIGKILL');
  } catch {
    // The parent already exited.
  }
  process.exit(0);
}

function progressSnapshot(): string {
  let snapshot = '';
  for (const progressPath of progressPaths) {
    try {
      const stats = fs.statSync(progressPath);
      snapshot += `${stats.size}:${stats.mtimeMs};`;
    } catch {
      snapshot += 'x;';
    }
  }
  return snapshot;
}

let lastSnapshot = progressPaths.length > 0 ? progressSnapshot() : '';
let lastSnapshotAt = Date.now();
let silentSince: number | null = null;
let timer = setTimeout(onTimeout, timeoutMs);

function onTimeout(): void {
  if (progressPaths.length === 0) killParent();
  const now = Date.now();
  silentSince ??= now - timeoutMs;
  const currentSnapshot = progressSnapshot();
  if (currentSnapshot !== lastSnapshot && now - silentSince < capMs) {
    lastSnapshot = currentSnapshot;
    timer = setTimeout(onTimeout, timeoutMs);
    return;
  }
  const extra = currentSnapshot !== lastSnapshot
    ? ` despite ongoing disk activity (hard cap ${Math.round(capMs / 1000)}s reached)`
    : '';
  killParent(extra);
}

process.stdin.on('data', () => {
  silentSince = null;
  if (progressPaths.length > 0) {
    const now = Date.now();
    if (now - lastSnapshotAt >= 1000) {
      lastSnapshot = progressSnapshot();
      lastSnapshotAt = now;
    }
  }
  clearTimeout(timer);
  timer = setTimeout(onTimeout, timeoutMs);
});
process.stdin.on('end', () => process.exit(0));
process.stdin.on('error', () => process.exit(0));
process.stdin.resume();
