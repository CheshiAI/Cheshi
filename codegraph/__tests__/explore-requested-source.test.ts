import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import CodeGraph from '../src';
import { ToolHandler } from '../src/mcp/tools';

function sourceLines(text: string, file: string): Map<number, string> {
  const result = new Map<number, string>();
  let currentFile = '';
  for (const line of text.split('\n')) {
    const header = /^\*\*`([^`]+)`\*\*/.exec(line);
    if (header) currentFile = header[1];
    const source = /^(\d+)\t(.*)$/.exec(line);
    if (source && currentFile === file) result.set(Number(source[1]), source[2]);
  }
  return result;
}

describe('explore preserves requested source under its output budget', () => {
  let directory: string;
  let graph: CodeGraph;
  let handler: ToolHandler;

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'codegraph-requested-source-'));
    const service = Array.from({ length: 1500 }, (_, i) => `// Response normalization documentation ${i}`);
    service.push('export class AuditService {');
    for (let i = 0; i < 80; i++) {
      service.push(`  unrelatedMethod${i}(value: string) {`);
      for (let j = 0; j < 8; j++) service.push(`    value += "unrelated-${i}-${j}";`);
      service.push('    return value;', '  }');
    }
    service.push('  startPluginWorkflow(value: string) {', '    return this.handleNotification(value);', '  }');
    service.push('  startAuditFlow(value: string) {', '    return this.routeAuditNotification(value);', '  }');
    service.push('  routeAuditNotification(value: string) {', '    return this.handleNotification(value + "ROUTE_BODY");', '  }');
    service.push('  handleNotification(value: string) {');
    for (let i = 0; i < 200; i++) service.push(`    value += "notification-${i}";`);
    service.push('    return value;', '  }', '}');
    writeFileSync(join(directory, 'service.ts'), service.join('\n'));
    writeFileSync(join(directory, 'entry.ts'),
      'import { AuditService } from "./service";\n' +
      'export function startAudit() { return new AuditService().startPluginWorkflow("audit"); }\n');
    const huge = ['export function hugeRequestedFunction(value: string) {'];
    for (let i = 0; i < 1200; i++) huge.push(`  value += "large-body-${i}-with-a-long-message";`);
    huge.push('  return value + smallTailFunction();', '}');
    huge.push('export function smallTailFunction() { return "SMALL_TAIL_BODY"; }');
    writeFileSync(join(directory, 'huge.ts'), huge.join('\n'));
    writeFileSync(join(directory, 'one-line.ts'),
      `export function oversizedSingleLine() { return "${'x'.repeat(30000)}"; }\n`);
    writeFileSync(join(directory, 'other.ts'),
      'export function otherRequestedFunction() { return "OTHER_REQUESTED_BODY"; }\n');
    writeFileSync(join(directory, 'noise.ts'),
      'export function start(value: string) {\n' +
      Array.from({ length: 140 }, (_, i) => `  value += "NOISE_START_BODY_${i}";`).join('\n') +
      '\n  return value;\n}\n');
    graph = CodeGraph.initSync(directory);
    await graph.indexAll();
    handler = new ToolHandler(graph);
  });

  afterAll(() => {
    graph?.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  async function explore(query: string, maxFiles = 4): Promise<string> {
    const result = await handler.execute('codegraph_explore', { query, maxFiles });
    expect(result.isError).not.toBe(true);
    return result.content.map((part) => part.text ?? '').join('\n');
  }

  function expectCompleteBody(text: string, name: string, file: string): void {
    const node = graph.getNodesByName(name).find((candidate) => candidate.filePath === file)!;
    const actual = sourceLines(text, file);
    const expected = readFileSync(join(directory, file), 'utf8').split('\n');
    for (let line = node.startLine; line <= node.endLine; line++) {
      expect(actual.get(line), `${name} line ${line}`).toBe(expected[line - 1]);
    }
  }

  for (const query of ['handleNotification', 'AuditService.handleNotification', 'service.ts handleNotification']) {
    it(`returns every line of the late method for ${query}`, async () => {
      const text = await explore(query, 1);
      expectCompleteBody(text, 'handleNotification', 'service.ts');
      expect(text).not.toContain('unrelated-0-0');
    });
  }

  it('keeps a short requested method out of its enclosing class range', async () => {
    const text = await explore('startPluginWorkflow', 1);
    expectCompleteBody(text, 'startPluginWorkflow', 'service.ts');
    expect(text).not.toContain('unrelated-0-0');
    expect(text.length).toBeLessThan(10000);
  });

  it('does not expand an exact method query into unrelated stem matches', async () => {
    const text = await explore('startPluginWorkflow');
    expectCompleteBody(text, 'startPluginWorkflow', 'service.ts');
    expect(text.includes('NOISE_START_BODY')).toBe(false);
    expect(text.length).toBeLessThan(10000);
  });

  it('includes an intermediate call-path body after the requested methods', async () => {
    const text = await explore('startAuditFlow handleNotification', 1);
    expectCompleteBody(text, 'startAuditFlow', 'service.ts');
    expectCompleteBody(text, 'handleNotification', 'service.ts');
    expectCompleteBody(text, 'routeAuditNotification', 'service.ts');
  });

  it('keeps continuation offsets when line-number display is disabled', async () => {
    const previous = process.env.CODEGRAPH_EXPLORE_LINENUMS;
    process.env.CODEGRAPH_EXPLORE_LINENUMS = '0';
    try {
      const text = await explore('hugeRequestedFunction', 1);
      expect(/^\d+\t/m.test(text)).toBe(false);
      expect(text.includes('Source incomplete')).toBe(true);
      expect(text.includes('"offset":')).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.CODEGRAPH_EXPLORE_LINENUMS;
      else process.env.CODEGRAPH_EXPLORE_LINENUMS = previous;
    }
  });

  it('gives an exact continuation for a method that cannot fit and preserves the other requested file', async () => {
    const text = await explore('hugeRequestedFunction otherRequestedFunction');
    expectCompleteBody(text, 'otherRequestedFunction', 'other.ts');
    const displayed = sourceLines(text, 'huge.ts');
    expect(displayed.size).toBeGreaterThan(0);
    expect(displayed.size).toBeLessThan(1203);
    const nextLine = Math.max(...displayed.keys()) + 1;
    expect(text).toContain(`"offset":${nextLine}`);
    expect(text).toContain('codegraph_node');
    expect(text).not.toContain('the source above is complete');
    expect(text).not.toContain('Complete source for');
    expect(text.length).toBeLessThanOrEqual(19500);
    expect(text.split('\n').filter((line) => /^```/.test(line)).length % 2).toBe(0);
    const response = await handler.execute('codegraph_node', { file: 'huge.ts', offset: nextLine, limit: 100 });
    expect(response.content[0].text).toContain(`${nextLine}\t`);
  });

  it('names a requested definition omitted by maxFiles and points to its source', async () => {
    const text = await explore('handleNotification otherRequestedFunction', 1);
    const missing = sourceLines(text, 'other.ts').size ? 'service.ts' : 'other.ts';
    expect(text).toContain(`"file":"${missing}"`);
    expect(text).toContain('Source incomplete');
  });

  it('preserves a later small definition in the same file as an oversized body', async () => {
    const text = await explore('hugeRequestedFunction smallTailFunction', 1);
    expectCompleteBody(text, 'smallTailFunction', 'huge.ts');
    const displayed = sourceLines(text, 'huge.ts');
    let nextLine = 1;
    while (displayed.has(nextLine)) nextLine++;
    expect(nextLine).toBeGreaterThan(1);
    expect(nextLine).toBeLessThan(1203);
    expect(text).toContain(`"offset":${nextLine}`);
    expect(text.length).toBeLessThanOrEqual(19500);
    expect(text).not.toContain('Full source for these symbols');
  });

  it('keeps an oversized source line intact and offers a continuation', async () => {
    const text = await explore('oversizedSingleLine otherRequestedFunction');
    expectCompleteBody(text, 'otherRequestedFunction', 'other.ts');
    expect(sourceLines(text, 'one-line.ts').size).toBe(0);
    expect(text).toContain('"file":"one-line.ts","offset":1,"limit":1');
    expect(text.length).toBeLessThanOrEqual(19500);
  });

  it('does not suggest stale index offsets for a requested file excluded by maxFiles', async () => {
    const query = 'handleNotification otherRequestedFunction';
    const initial = await explore(query, 1);
    const missing = sourceLines(initial, 'other.ts').size ? 'service.ts' : 'other.ts';
    const path = join(directory, missing);
    const original = readFileSync(path, 'utf8');
    const freshHandler = new ToolHandler(graph);
    try {
      writeFileSync(path, '// newly inserted line\n'.repeat(500) + original);
      const response = await freshHandler.execute('codegraph_explore', { query, maxFiles: 1 });
      expect(response.isError).not.toBe(true);
      const text = response.content.map((part) => part.text ?? '').join('\n');
      const notices = text.split('\n').filter((line) =>
        line.includes(`"file":"${missing}"`) && line.includes('codegraph_node'),
      );
      expect(notices.length).toBeGreaterThan(0);
      for (const notice of notices) expect(notice).not.toContain('"offset":');
      expect(text).toContain('changed on disk');
    } finally {
      freshHandler.closeAll();
      writeFileSync(path, original);
    }
  });
});
