import { existsSync } from 'node:fs';
import path from 'node:path';

import { product } from '../../../config/product.mts';
import {
  CODEGRAPH_DATA_ROOT_ENV,
  resolveCodeGraphDataRoot,
  resolveCheshiUserDataDirectory,
} from '../../../config/workspace-storage.mts';

/**
 * Point CodeGraph at Cheshi's central workspace storage and packaged grammar
 * runtime. This is shared by the public CLI wrapper and Cheshi-only developer
 * tools so neither path silently falls back to a repository-local index.
 */
export function configureCheshiCodeGraphEnvironment(): void {
  const configuredDataRoot = resolveCodeGraphDataRoot();
  process.env[CODEGRAPH_DATA_ROOT_ENV] = configuredDataRoot
    ?? resolveCheshiUserDataDirectory(product.dataDirectory);

  const adjacentTreeSitterWasm = path.join(path.dirname(process.execPath), 'tree-sitter.wasm');
  if (!process.env.CODEGRAPH_TREE_SITTER_WASM && existsSync(adjacentTreeSitterWasm)) {
    process.env.CODEGRAPH_TREE_SITTER_WASM = adjacentTreeSitterWasm;
  }
}
