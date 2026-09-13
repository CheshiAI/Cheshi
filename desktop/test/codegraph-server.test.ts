import { describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import { createServer } from 'net';
import * as os from 'os';
import * as path from 'path';

import CodeGraph, { type EdgeKind } from '@cheshi/codegraph';
import { buildGraphSlice, startCodeGraphServer } from '@cheshi/codegraph-server';

async function reserveAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not allocate a CodeGraph server test port.'));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

describe('viewer graph slices', () => {
  it('keeps a bounded bidirectional slice and applies edge filters', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-viewer-'));
    let cg: CodeGraph | null = null;

    try {
      fs.writeFileSync(
        path.join(projectRoot, 'main.ts'),
        [
          'export function leaf(): number {',
          '  return 1;',
          '}',
          '',
          'export function root(): number {',
          '  return leaf();',
          '}',
          '',
        ].join('\n'),
      );

      cg = CodeGraph.initSync(projectRoot);
      await cg.indexAll();

      const root = cg.getNodesByKind('function').find((node) => node.name === 'root');
      expect(root).toBeDefined();
      if (!root) return;

      const edgeKinds = new Set<EdgeKind>(['calls']);
      const slice = buildGraphSlice(cg, root.id, {
        depth: 1,
        limit: 2,
        groupBy: 'language',
        edgeKinds,
      });

      expect(slice.rootId).toBe(root.id);
      expect(slice.nodes.length).toBeLessThanOrEqual(2);
      expect(slice.nodes.every((node) => node.group === 'typescript')).toBe(true);
      expect(slice.edges.every((edge) => edge.kind === 'calls')).toBe(true);
    } finally {
      cg?.close();
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('exposes multiple indexed projects and serves the selected project metadata', async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-viewer-projects-'));
    const primaryRoot = path.join(workspaceRoot, 'cheshire');
    const secondaryRoot = path.join(workspaceRoot, 'rabbit-hole');
    const staticRoot = path.join(workspaceRoot, 'viewer');
    fs.mkdirSync(primaryRoot);
    fs.mkdirSync(secondaryRoot);
    fs.mkdirSync(staticRoot);
    fs.mkdirSync(path.join(staticRoot, 'assets'));
    fs.writeFileSync(path.join(staticRoot, 'index.html'), '<!doctype html><title>viewer</title>');
    fs.writeFileSync(path.join(staticRoot, 'assets', 'main.js'), 'export const ready = true;\n');

    let primary: CodeGraph | null = null;
    let secondary: CodeGraph | null = null;
    let viewer: Awaited<ReturnType<typeof startCodeGraphServer>> | null = null;

    try {
      fs.writeFileSync(path.join(primaryRoot, 'main.ts'), 'export function crew(): number { return 1; }\n');
      fs.writeFileSync(path.join(secondaryRoot, 'main.ts'), 'export function rabbit(): number { return 2; }\n');

      primary = CodeGraph.initSync(primaryRoot);
      await primary.indexAll();
      primary.close();
      primary = null;

      secondary = CodeGraph.initSync(secondaryRoot);
      await secondary.indexAll();
      secondary.close();
      secondary = null;

      viewer = await startCodeGraphServer(primaryRoot, {
        port: await reserveAvailablePort(),
        projects: [secondaryRoot],
        staticRoot,
      });

      const projectsResponse = await fetch(`${viewer.url}/api/projects`);
      expect(projectsResponse.status).toBe(200);
      const projects = (await projectsResponse.json()) as Array<{
        id: string;
        name: string;
        projectRoot: string;
      }>;
      expect(projects).toHaveLength(2);
      const rabbitProject = projects.find((project) => project.projectRoot === secondaryRoot);
      expect(rabbitProject?.name).toBe('rabbit-hole');
      expect(rabbitProject).toBeDefined();
      if (!rabbitProject) return;

      const metaResponse = await fetch(`${viewer.url}/api/meta?project=${rabbitProject.id}`);
      expect(metaResponse.status).toBe(200);
      const meta = (await metaResponse.json()) as { projectId: string; projectRoot: string; stats: { nodeCount: number } };
      expect(meta.projectId).toBe(rabbitProject.id);
      expect(meta.projectRoot).toBe(secondaryRoot);
      expect(meta.stats.nodeCount).toBeGreaterThan(0);

      const assetResponse = await fetch(`${viewer.url}/assets/main.js`);
      expect(assetResponse.status).toBe(200);
      expect(assetResponse.headers.get('cache-control')).toBe('no-store');
    } finally {
      primary?.close();
      secondary?.close();
      viewer?.close();
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('serves API routes without built viewer assets in development mode', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-viewer-api-only-'));
    let cg: CodeGraph | null = null;
    let viewer: Awaited<ReturnType<typeof startCodeGraphServer>> | null = null;

    try {
      fs.writeFileSync(path.join(projectRoot, 'main.ts'), 'export const ready = true;\n');
      cg = CodeGraph.initSync(projectRoot);
      await cg.indexAll();
      cg.close();
      cg = null;

      viewer = await startCodeGraphServer(projectRoot, {
        port: await reserveAvailablePort(),
        serveStatic: false,
        staticRoot: path.join(projectRoot, 'missing-viewer-assets'),
      });

      const metaResponse = await fetch(`${viewer.url}/api/meta`);
      expect(metaResponse.status).toBe(200);
      const assetResponse = await fetch(`${viewer.url}/`);
      expect(assetResponse.status).toBe(404);
    } finally {
      cg?.close();
      viewer?.close();
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('serves bounded workspace file reads and revision-safe writes', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-viewer-workspace-'));
    let viewer: Awaited<ReturnType<typeof startCodeGraphServer>> | null = null;

    try {
      fs.writeFileSync(path.join(projectRoot, 'main.ts'), 'export const ready = true;\n');
      const writable = CodeGraph.initSync(projectRoot);
      await writable.indexAll();
      writable.close();

      viewer = await startCodeGraphServer(projectRoot, {
        port: await reserveAvailablePort(),
        serveStatic: false,
      });

      const listingResponse = await fetch(`${viewer.url}/api/workspace/files`);
      expect(listingResponse.status).toBe(200);
      const listing = (await listingResponse.json()) as { entries: Array<{ path: string; kind: string }> };
      expect(listing.entries.some((entry) => entry.path === 'main.ts' && entry.kind === 'file')).toBe(true);

      const readResponse = await fetch(`${viewer.url}/api/workspace/file?path=main.ts`);
      expect(readResponse.status).toBe(200);
      const initial = (await readResponse.json()) as { file: { revision: string; fileKind: string }; content: string };
      expect(initial.file.fileKind).toBe('text');
      expect(initial.content).toContain('ready');

      const writeResponse = await fetch(`${viewer.url}/api/workspace/file?path=main.ts`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: 'main.ts',
          content: 'export const changed = true;\n',
          expectedRevision: initial.file.revision,
        }),
      });
      expect(writeResponse.status).toBe(200);
      const written = (await writeResponse.json()) as { status: string; file: { revision: string } };
      expect(written.status).toBe('written');
      expect(written.file.revision).not.toBe(initial.file.revision);

      const conflictResponse = await fetch(`${viewer.url}/api/workspace/file?path=main.ts`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: 'main.ts',
          content: 'export const stale = true;\n',
          expectedRevision: initial.file.revision,
        }),
      });
      expect(conflictResponse.status).toBe(409);
      expect((await conflictResponse.json() as { status: string }).status).toBe('conflict');

      const traversalResponse = await fetch(`${viewer.url}/api/workspace/file?path=${encodeURIComponent('../outside.ts')}`);
      expect(traversalResponse.status).toBe(403);
    } finally {
      viewer?.close();
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
