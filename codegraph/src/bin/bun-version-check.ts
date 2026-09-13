/** Minimum Bun runtime verified by the local harness. */
export const MIN_BUN_VERSION = '1.3.14';

function versionTuple(version: string): [number, number, number] {
  const [major = 0, minor = 0, patch = 0] = version.split('.').map(Number);
  return [major, minor, patch];
}

/** True when the current runtime is missing Bun or is older than our floor. */
export function isUnsupportedBunVersion(version: string | undefined): boolean {
  if (!version) return true;
  const current = versionTuple(version);
  const minimum = versionTuple(MIN_BUN_VERSION);
  for (let i = 0; i < current.length; i++) {
    if (current[i]! !== minimum[i]!) return current[i]! < minimum[i]!;
  }
  return false;
}

/** Human-readable startup failure for a non-Bun or outdated Bun runtime. */
export function buildBunRuntimeBanner(version: string | undefined): string {
  const detected = version ? `Bun ${version}` : 'a non-Bun JavaScript runtime';
  return [
    '[CodeGraph] Unsupported JavaScript runtime',
    `Detected ${detected}. CodeGraph requires Bun ${MIN_BUN_VERSION} or newer.`,
    'Install or update Bun, then run the command with `bun`.',
  ].join('\n');
}
