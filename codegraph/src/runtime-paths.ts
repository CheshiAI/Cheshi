import * as path from 'node:path';

export const CODEGRAPH_RUNTIME_ROOT_ENV = 'CODEGRAPH_RUNTIME_ROOT';

export function codeGraphRuntimePath(...segments: string[]): string | null {
  const runtimeRoot = process.env[CODEGRAPH_RUNTIME_ROOT_ENV]?.trim();
  return runtimeRoot ? path.join(runtimeRoot, ...segments) : null;
}
