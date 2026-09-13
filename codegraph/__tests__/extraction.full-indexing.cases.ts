import { CodeGraph } from '../src';
import { cleanupTempDir, createTempDir } from './extraction.fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

export function registerFullIndexingTests(): void {


  describe('Full Indexing', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = createTempDir();
    });

    afterEach(() => {
      cleanupTempDir(tempDir);
    });

    it('should index a TypeScript file', async () => {
      // Create test file
      const srcDir = path.join(tempDir, 'src');
      fs.mkdirSync(srcDir);
      fs.writeFileSync(
        path.join(srcDir, 'utils.ts'),
        `
export function add(a: number, b: number): number {
  return a + b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}
`
      );

      // Initialize and index
      const cg = CodeGraph.initSync(tempDir);
      const result = await cg.indexAll();

      expect(result.success).toBe(true);
      expect(result.filesIndexed).toBe(1);
      expect(result.nodesCreated).toBeGreaterThanOrEqual(2);

      // Check nodes were stored
      const nodes = cg.getNodesInFile('src/utils.ts');
      expect(nodes.length).toBeGreaterThanOrEqual(2);

      const addFunc = nodes.find((n) => n.name === 'add');
      expect(addFunc).toBeDefined();
      expect(addFunc?.kind).toBe('function');

      cg.close();
    });

    it('should index multiple files', async () => {
      // Create test files
      const srcDir = path.join(tempDir, 'src');
      fs.mkdirSync(srcDir);

      fs.writeFileSync(
        path.join(srcDir, 'math.ts'),
        `export function add(a: number, b: number) { return a + b; }`
      );

      fs.writeFileSync(
        path.join(srcDir, 'string.ts'),
        `export function capitalize(s: string) { return s.toUpperCase(); }`
      );

      // Initialize and index
      const cg = CodeGraph.initSync(tempDir);
      const result = await cg.indexAll();

      expect(result.success).toBe(true);
      expect(result.filesIndexed).toBe(2);

      const files = cg.getFiles();
      expect(files.length).toBe(2);

      cg.close();
    });

    it('should track file hashes for incremental updates', async () => {
      // Create initial file
      const srcDir = path.join(tempDir, 'src');
      fs.mkdirSync(srcDir);
      fs.writeFileSync(path.join(srcDir, 'main.ts'), `export const x = 1;`);

      // Initialize and index
      const cg = CodeGraph.initSync(tempDir);
      await cg.indexAll();

      // Check file is tracked
      const file = cg.getFile('src/main.ts');
      expect(file).toBeDefined();
      expect(file?.contentHash).toBeDefined();

      // Modify file
      fs.writeFileSync(path.join(srcDir, 'main.ts'), `export const x = 2;`);

      // Check for changes
      const changes = cg.getChangedFiles();
      expect(changes.modified).toContain('src/main.ts');

      cg.close();
    });

    it('should sync and detect changes', async () => {
      // Create initial file
      const srcDir = path.join(tempDir, 'src');
      fs.mkdirSync(srcDir);
      fs.writeFileSync(
        path.join(srcDir, 'main.ts'),
        `export function original() { return 1; }`
      );

      // Initialize and index
      const cg = CodeGraph.initSync(tempDir);
      await cg.indexAll();

      const initialNodes = cg.getNodesInFile('src/main.ts');
      expect(initialNodes.some((n) => n.name === 'original')).toBe(true);

      // Modify file
      fs.writeFileSync(
        path.join(srcDir, 'main.ts'),
        `export function updated() { return 2; }`
      );

      // Sync
      const syncResult = await cg.sync();
      expect(syncResult.filesModified).toBe(1);

      // Check nodes were updated
      const updatedNodes = cg.getNodesInFile('src/main.ts');
      expect(updatedNodes.some((n) => n.name === 'updated')).toBe(true);
      expect(updatedNodes.some((n) => n.name === 'original')).toBe(false);

      cg.close();
    });

    it('should count file-level tracked YAML files as indexed', async () => {
      fs.writeFileSync(path.join(tempDir, 'app.yaml'), 'name: test\n');
      fs.writeFileSync(path.join(tempDir, 'routes.yml'), 'route: value\n');

      const cg = CodeGraph.initSync(tempDir);
      const result = await cg.indexAll();

      expect(result.success).toBe(true);
      expect(result.filesIndexed).toBe(2);
      expect(result.filesSkipped).toBe(0);
      expect(cg.getFiles().map((f) => f.path).sort()).toEqual(['app.yaml', 'routes.yml']);

      cg.close();
    });

    it('should count file-level tracked YAML/Twig files as indexed in indexFiles()', async () => {
      fs.writeFileSync(path.join(tempDir, 'app.yaml'), 'name: test\n');
      fs.writeFileSync(path.join(tempDir, 'view.twig'), '{{ title }}\n');

      const cg = CodeGraph.initSync(tempDir);
      const result = await cg.indexFiles(['app.yaml', 'view.twig']);

      expect(result.success).toBe(true);
      expect(result.filesIndexed).toBe(2);
      expect(result.filesSkipped).toBe(0);

      const tracked = cg.getFiles().map((f) => `${f.path}:${f.language}`).sort();
      expect(tracked).toEqual(['app.yaml:yaml', 'view.twig:twig']);

      cg.close();
    });

    it('should count file-level tracked .properties files as indexed', async () => {
      fs.writeFileSync(path.join(tempDir, 'application.properties'), 'server.port=8080\n');
      fs.writeFileSync(path.join(tempDir, 'log.properties'), 'log.level=INFO\n');

      const cg = CodeGraph.initSync(tempDir);
      const result = await cg.indexAll();

      expect(result.success).toBe(true);
      expect(result.filesIndexed).toBe(2);
      expect(result.filesSkipped).toBe(0);

      cg.close();
    });

    it('should count the full file-level tracked class (yaml/twig/properties) in indexFiles()', async () => {
      fs.writeFileSync(path.join(tempDir, 'app.yaml'), 'name: test\n');
      fs.writeFileSync(path.join(tempDir, 'view.twig'), '{{ title }}\n');
      fs.writeFileSync(path.join(tempDir, 'application.properties'), 'server.port=8080\n');

      const cg = CodeGraph.initSync(tempDir);
      const result = await cg.indexFiles(['app.yaml', 'view.twig', 'application.properties']);

      expect(result.success).toBe(true);
      expect(result.filesIndexed).toBe(3);
      expect(result.filesSkipped).toBe(0);

      const tracked = cg.getFiles().map((f) => `${f.path}:${f.language}`).sort();
      expect(tracked).toEqual(['app.yaml:yaml', 'application.properties:properties', 'view.twig:twig']);

      cg.close();
    });
  });
}
