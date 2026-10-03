import type { ExecFileException } from 'node:child_process';

export type DockerFailureKind = 'cli-missing' | 'engine-unavailable' | 'permission-denied' | 'timeout' | 'command-failed';
export class DockerCommandError extends Error {
  readonly kind: DockerFailureKind;
  constructor(kind: DockerFailureKind, message: string) {
    super(message); this.name = 'DockerCommandError'; this.kind = kind;
  }
}

/** Classify diagnostics without returning stderr, stdin, command arguments or credentials. */
export function dockerCommandError(error: ExecFileException, stderr: string, args: string[]): DockerCommandError {
  if (error.code === 'ENOENT') return new DockerCommandError('cli-missing', 'Docker CLI was not found. Install Docker CLI and try again.');
  if (error.code === 'EACCES' || error.code === 'EPERM') return new DockerCommandError('permission-denied', 'Permission denied while launching Docker CLI.');
  if (error.killed || error.code === 'ETIMEDOUT') return new DockerCommandError('timeout', 'Docker command timed out. Refresh its status before retrying.');
  // Match Docker transport diagnostics, not a build step or container command's output.
  const offset = args[0] === '--host' || args[0] === '--context' ? 2 : 0;
  const command = args[offset];
  const daemonQuery = command === 'container' && ['ls', 'inspect'].includes(args[offset + 1] ?? '');
  const diagnostic = stderr.trim();
  const contextName = command === 'context' && args[offset + 1] === 'inspect' && args.length === offset + 3
    ? args[offset + 2] : undefined;
  const contextPrefix = `context ${JSON.stringify(contextName)}: context not found`;
  const contextSuffix = diagnostic.startsWith(contextPrefix) ? diagnostic.slice(contextPrefix.length) : null;
  const missingContext = contextName !== undefined
    && contextSuffix !== null && (contextSuffix === '' || /^: open [^\r\n]+: no such file or directory$/.test(contextSuffix));
  if (daemonQuery && (/^(?:error during connect:.*|permission denied while trying to connect to the docker.*)$/is.test(diagnostic)
    && /permission denied/i.test(diagnostic))) {
    return new DockerCommandError('permission-denied', 'Permission denied while connecting to the selected Docker engine.');
  }
  if (missingContext || (daemonQuery && (/^Cannot connect to the Docker daemon\b/i.test(diagnostic)
    || /^(?:error during connect:|failed to connect to the docker API at ).*(?:connection refused|no such file or directory|is the docker daemon running)/is.test(diagnostic)))) {
    return new DockerCommandError('engine-unavailable', 'Docker engine is disconnected. Start the selected engine; status will refresh automatically.');
  }
  const operation = ['build', 'exec', 'container', 'context'].includes(command ?? '') ? command : 'command';
  const exit = typeof error.code === 'number' ? ` (exit ${error.code})` : '';
  return new DockerCommandError('command-failed', `Docker ${operation} failed${exit}. Check the selected engine and operation in Docker.`);
}
