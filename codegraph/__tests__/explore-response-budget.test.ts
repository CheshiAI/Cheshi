import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import CodeGraph from '../src';
import { ToolHandler, type ToolResult } from '../src/mcp/tools';
import { QueryPool } from '../src/mcp/query-pool';
import { __emitWatchEventForTests } from '../src/sync/watcher';

describe('explore bounds the response including watcher notices', () => {
  let directory: string;
  let graph: CodeGraph;
  let handler: ToolHandler;
  const pendingPaths = Array.from({ length: 520 }, (_, i) =>
    `pending-${String(i).padStart(3, '0')}-${'x'.repeat(100)}.ts`,
  );

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'codegraph-explore-response-'));
    for (const [i, path] of pendingPaths.entries()) {
      writeFileSync(join(directory, path), `export const pendingValue${i} = ${i};\n`);
    }
    const body = ['export function replyEnvelopeTarget(value: string) {'];
    for (const path of pendingPaths) body.push(`  value += "${path}";`);
    body.push('  return value;', '}');
    writeFileSync(join(directory, 'target.ts'), body.join('\n'));
    graph = CodeGraph.initSync(directory);
    await graph.indexAll();
    handler = new ToolHandler(graph);
    graph.watch({ debounceMs: 60000, inertForTests: true });
    await graph.waitUntilWatcherReady();
    for (const path of pendingPaths) {
      writeFileSync(join(directory, path), readFileSync(join(directory, path), 'utf8') + '// edited\n');
      __emitWatchEventForTests(directory, path);
    }
  });

  afterAll(() => {
    graph?.unwatch();
    handler?.closeAll();
    graph?.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  function expectBoundedSource(response: ToolResult) {
    expect(response.isError).not.toBe(true);
    const text = response.content.map((part) => part.text ?? '').join('\n');
    expect(text).toContain('pending sync');
    expect(text.length).toBeLessThanOrEqual(25000);
    const numbered = new Map(text.split('\n').flatMap((line) => {
      const match = /^(\d+)\t(.*)$/.exec(line);
      return match ? [[Number(match[1]), match[2]] as const] : [];
    }));
    const source = readFileSync(join(directory, 'target.ts'), 'utf8').split('\n');
    expect(numbered.size).toBeGreaterThan(0);
    for (const [line, value] of numbered) expect(value).toBe(source[line - 1]);
    const nextLine = Math.max(...numbered.keys()) + 1;
    expect(text).toContain(`"offset":${nextLine}`);
    expect(text.split('\n').filter((line) => line.startsWith('```')).length % 2).toBe(0);
    expect(Object.keys(response).every((key) => key === 'content' || key === 'isError')).toBe(true);
    return { text, nextLine };
  }

  it('keeps pending-file warnings, source, and exact continuations inside the final cap', async () => {
    expect(graph.getStats().fileCount).toBeGreaterThanOrEqual(500);
    expect(graph.getPendingFiles().length).toBe(pendingPaths.length);
    const response = await handler.execute('codegraph_explore', { query: 'replyEnvelopeTarget', maxFiles: 1 });
    const { nextLine } = expectBoundedSource(response);
    const continued = await handler.execute('codegraph_node', { file: 'target.ts', offset: nextLine, limit: 1 });
    expect(continued.isError).not.toBe(true);
    expect(continued.content[0].text).toContain(`${nextLine}\t`);
  });

  it('enforces the same final cap when a real query worker returns the source', async () => {
    const pool = new QueryPool({ root: directory, size: 1, softTimeoutMs: 5000 });
    try {
      const deadline = Date.now() + 5000;
      while (!pool.ready && pool.healthy && Date.now() < deadline) await Bun.sleep(10);
      expect(pool.ready).toBe(true);
      expect(pool.healthy).toBe(true);
      handler.setQueryPool(pool);
      const response = await handler.execute('codegraph_explore', { query: 'replyEnvelopeTarget', maxFiles: 1 });
      expectBoundedSource(response);
    } finally {
      handler.setQueryPool(null);
      await pool.destroy();
    }
  }, 10000);

  it('keeps the continuation accurate when line numbers are hidden after final clipping', async () => {
    const previous = process.env.CODEGRAPH_EXPLORE_LINENUMS;
    process.env.CODEGRAPH_EXPLORE_LINENUMS = '0';
    try {
      const response = await handler.execute('codegraph_explore', { query: 'replyEnvelopeTarget', maxFiles: 1 });
      expect(response.isError).not.toBe(true);
      const text = response.content[0].text;
      expect(text.length).toBeLessThanOrEqual(25000);
      expect(text).toContain('pending sync');
      expect(/^\d+\t/m.test(text)).toBe(false);
      const nextLine = Number(/"file":"target.ts","offset":(\d+)/.exec(text)?.[1]);
      expect(nextLine).toBeGreaterThan(1);
      const source = readFileSync(join(directory, 'target.ts'), 'utf8').split('\n');
      expect(text).toContain(source[nextLine - 2]);
      expect(text).not.toContain(source[nextLine - 1]);
    } finally {
      if (previous === undefined) delete process.env.CODEGRAPH_EXPLORE_LINENUMS;
      else process.env.CODEGRAPH_EXPLORE_LINENUMS = previous;
    }
  });
});
