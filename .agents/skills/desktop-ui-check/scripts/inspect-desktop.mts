import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { InspectorClient } from './inspector-client.mts';
import { inspectPanes, runRendererSession, type DesktopUI, type SessionResult } from './renderer-session.mts';

export function locateMainProcess(output: string, workspace: string): number {
  const executable = `${workspace}/desktop/.development/Cheshi Development.app/Contents/MacOS/Electron`;
  const matches = output.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) return [];
    const command = match[2]!.replace(/\/$/, '');
    return command === `${executable} ${workspace}` ? [Number(match[1])] : [];
  });
  if (matches.length !== 1) throw new Error(`Expected one running Cheshi main process in this checkout; found ${matches.length}`);
  return matches[0]!;
}

export function listenerPids(output: string): number[] {
  return [...new Set(output.split('\n').filter(line => /^p\d+$/.test(line)).map(line => Number(line.slice(1))))];
}

function portOwners(port: number) {
  try {
    return listenerPids(execFileSync('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'], { encoding: 'utf8' }));
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    if (failure.status === 1 && !failure.stdout && !failure.stderr) return [];
    throw new Error('Cannot inspect listener ownership; check process permissions');
  }
}

export function assertPortOwner(owners: number[], pid: number) {
  if (owners.length !== 1 || owners[0] !== pid) throw new Error('Inspector port is not exclusively owned by the selected app');
}

async function inspectorUrl(port: number) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500), redirect: 'error' });
  if (!response.ok) throw new Error('Inspector discovery failed');
  const entries = await response.json() as { webSocketDebuggerUrl?: string }[];
  if (entries.length !== 1 || !entries[0]?.webSocketDebuggerUrl) throw new Error('Expected one Node Inspector target');
  const url = new URL(entries[0].webSocketDebuggerUrl);
  if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || Number(url.port) !== port) throw new Error('Unexpected Inspector endpoint');
  return url.href;
}

export async function runCheck(options: { workspace: string; port: number; timeoutMs: number; scenario: (ui: DesktopUI) => Promise<unknown> }) {
  if (process.platform !== 'darwin') throw new Error('This runner currently targets the macOS Cheshi development app');
  const workspace = realpathSync(options.workspace);
  const readProcesses = () => execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  const pid = locateMainProcess(readProcesses(), workspace);
  const owners = portOwners(options.port);
  let openedInspector = false;
  let identityVerified = false;
  let client: InspectorClient | undefined;
  const key = `__cheshiUICheck_${crypto.randomUUID().replaceAll('-', '')}`;
  const cancel = () => { void client?.evaluate(`globalThis[${JSON.stringify(key)}]?.abort()`).catch(() => {}); };
  try {
    if (owners.length) assertPortOwner(owners, pid);
    else {
      if (options.port !== 9229) throw new Error('SIGUSR1 uses port 9229; custom ports must already be open');
      if (locateMainProcess(readProcesses(), workspace) !== pid) throw new Error('Main process changed before connection');
      process.kill(pid, 'SIGUSR1');
      openedInspector = true;
      const deadline = Date.now() + 3000;
      while (!portOwners(options.port).length && Date.now() < deadline) await Bun.sleep(50);
      assertPortOwner(portOwners(options.port), pid);
    }
    const url = await inspectorUrl(options.port);
    assertPortOwner(portOwners(options.port), pid);
    client = await InspectorClient.connect(url);
    const identity = await client.evaluate<{ pid: number; executable: string; argv: string[] }>(
      '({pid:process.pid,executable:process.execPath,argv:process.argv})');
    if (identity.pid !== pid || identity.executable !== `${workspace}/desktop/.development/Cheshi Development.app/Contents/MacOS/Electron`
      || identity.argv[1]?.replace(/\/$/, '') !== workspace) throw new Error('Connected process identity mismatch');
    identityVerified = true;
    process.on('SIGINT', cancel);
    process.on('SIGTERM', cancel);
    return await client.evaluate<SessionResult>(`(${runRendererSession.toString()})(${JSON.stringify({ key, timeoutMs: options.timeoutMs })}, ${JSON.stringify(options.scenario.toString())})`, options.timeoutMs + 15000);
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    try {
      if (openedInspector) {
        if (client && identityVerified) {
          await client.evaluate("setTimeout(() => process.mainModule.require('node:inspector').close(), 50); true");
        } else {
          console.error('Inspector activation was attempted but safe cleanup could not be confirmed; inspect the selected app before retrying.');
        }
      }
    } finally { client?.close(); }
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: bun inspect-desktop.mts [--workspace PATH] [--scenario editor-maximize|PATH] [--port 9229] [--timeout-ms 20000]');
    return;
  }
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i]!, value = args[i + 1];
    if (!['--workspace', '--scenario', '--port', '--timeout-ms'].includes(name) || !value || values.has(name)) throw new Error('Invalid or duplicate argument; use --help');
    values.set(name, value);
  }
  const port = Number(values.get('--port') ?? 9229), timeoutMs = Number(values.get('--timeout-ms') ?? 20000);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) throw new Error('Invalid port or timeout (1000–60000 ms)');
  let scenario = inspectPanes;
  const name = values.get('--scenario');
  if (name) {
    const path = name === 'editor-maximize' ? fileURLToPath(new URL('../scenarios/editor-maximize.mts', import.meta.url)) : resolve(name);
    scenario = (await import(pathToFileURL(path).href)).default;
    if (typeof scenario !== 'function') throw new Error('Scenario must default-export an async function');
  }
  const report = await runCheck({ workspace: values.get('--workspace') ?? process.cwd(), port, timeoutMs, scenario });
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

if (import.meta.main) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
