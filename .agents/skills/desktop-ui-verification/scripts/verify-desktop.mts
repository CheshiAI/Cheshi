import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runCheck } from '../../desktop-ui-check/scripts/inspect-desktop.mts';
import { compileScenario, type VerificationResult, type VerificationScenario } from './verification.mts';

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: bun verify-desktop.mts --scenario PATH [--workspace PATH] [--output-dir PATH] [--phase before|after|current] [--port 9229] [--timeout-ms 20000]');
    return;
  }
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i]!, value = args[i + 1];
    if (!['--workspace', '--scenario', '--output-dir', '--phase', '--port', '--timeout-ms'].includes(name)
      || !value || values.has(name)) throw new Error('Invalid or duplicate argument; use --help');
    values.set(name, value);
  }
  const scenarioPath = values.get('--scenario');
  if (!scenarioPath) throw new Error('--scenario is required');
  const port = Number(values.get('--port') ?? 9229), timeoutMs = Number(values.get('--timeout-ms') ?? 20000);
  const phase = values.get('--phase') ?? 'current';
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(timeoutMs)
    || timeoutMs < 1000 || timeoutMs > 60000) throw new Error('Invalid port or timeout (1000–60000 ms)');
  if (!['before', 'after', 'current'].includes(phase)) throw new Error('Invalid phase');
  const scenario = (await import(pathToFileURL(resolve(scenarioPath)).href)).default as VerificationScenario;
  const compiled = compileScenario(scenario);
  const scenarioHash = createHash('sha256').update(compiled.toString()).digest('hex');
  // Unique directory prevents overwriting earlier before/after evidence.
  const directory = join(resolve(values.get('--output-dir') ?? '/tmp/cheshi-ui-verification'), crypto.randomUUID());
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const report = await runCheck({ workspace: values.get('--workspace') ?? process.cwd(), port, timeoutMs, scenario: compiled });
  const result = report.result as VerificationResult | undefined;
  const screenshots: string[] = [];
  for (const shot of result?.screenshots ?? []) {
    const path = join(directory, `${shot.name}.png`);
    await writeFile(path, Buffer.from(shot.data, 'base64'), { mode: 0o600 });
    screenshots.push(path);
  }
  const output = {
    ...report,
    result: result && { checks: result.checks, actions: result.actions, screenshots },
    scenario: scenario.name, scenarioHash, phase,
    visualReview: screenshots.length ? 'pending: open and inspect the screenshots' : 'not performed',
    // A failure before capture does not establish that restoration was verified.
    restoration: report.ok ? 'verified' : 'see error and cleanupErrors; do not infer restoration success',
  };
  const reportPath = join(directory, 'report.json');
  await writeFile(reportPath, JSON.stringify(output, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ ...output, reportPath }, null, 2));
  if (!report.ok) process.exitCode = 1;
}

if (import.meta.main) main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
