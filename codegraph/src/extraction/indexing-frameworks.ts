import * as fs from 'fs';
import * as path from 'path';
import { detectFrameworks } from '../resolution/frameworks';
import type { ResolutionContext } from '../resolution/types';
import { validatePathWithinRoot } from '../utils';
import type { ExtractionState } from './indexing-state';
import { scanDirectory } from './scan-directory';


/**
   * Build a filesystem-backed ResolutionContext sufficient for framework
   * detection. Graph-query methods (getNodesByName etc.) return empty because
   * the DB hasn't been populated yet, but detect() only uses readFile,
   * fileExists, and getAllFiles, so that's fine.
   */
export function buildDetectionContext(this: ExtractionState, files: string[]): ResolutionContext {
  const rootDir = this.rootDir;
  return {
    getNodesInFile: () => [],
    getNodesByName: () => [],
    getNodesByQualifiedName: () => [],
    getNodesByKind: () => [],
    getNodesByLowerName: () => [],
    getImportMappings: () => [],
    getAllFiles: () => files,
    getProjectRoot: () => rootDir,
    fileExists: (relativePath: string) => {
      const full = validatePathWithinRoot(rootDir, relativePath);
      if (!full) return false;
      try {
        return fs.existsSync(full);
      } catch {
        return false;
      }
    },
    readFile: (relativePath: string) => {
      const full = validatePathWithinRoot(rootDir, relativePath);
      if (!full) return null;
      try {
        return fs.readFileSync(full, 'utf-8');
      } catch {
        return null;
      }
    },
    // Monorepo support — needed by framework detect()s that probe
    // subpackage manifests (e.g. fabric-view looking at
    // packages/<sub>/package.json when the root manifest is just a
    // workspace declaration). Matches the resolver-context shape.
    listDirectories: (relativePath: string) => {
      const target =
        relativePath === '.' || relativePath === ''
          ? rootDir
          : path.join(rootDir, relativePath);
      try {
        return fs
          .readdirSync(target, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);
      } catch {
        return [];
      }
    },
  };
}

/**
   * Detect frameworks on demand using the current scanned files (or a fresh
   * scan if none are provided). Cached on the orchestrator so repeat calls
   * inside a single run don't re-scan.
   */
export function ensureDetectedFrameworks(this: ExtractionState, files?: string[]): string[] {
  if (this.detectedFrameworkNames !== null) return this.detectedFrameworkNames;
  const fileList = files ?? scanDirectory(this.rootDir);
  const context = this.buildDetectionContext(fileList);
  this.detectedFrameworkNames = detectFrameworks(context).map((r) => r.name);
  return this.detectedFrameworkNames;
}
