import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph, { getDatabasePath } from '../src';
import { MCPEngine } from '../src/mcp/engine';
import { mcpReadOnlyEnabled } from '../src/mcp/runtime-options';
import { getCodeGraphState, getToolHandlerState } from './helpers/internal-state';

describe('app-managed read-only MCP', () => {
  let temporaryRoot: string;
  let project: string;
  let otherProject: string;
  let previousDataRoot: string | undefined;
  let previousReadOnly: string | undefined;
  const engines: MCPEngine[] = [];

  beforeEach(async () => {
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cheshi-mcp-read-only-'));
    previousDataRoot = process.env.CODEGRAPH_DATA_ROOT;
    previousReadOnly = process.env.CODEGRAPH_MCP_READ_ONLY;
    process.env.CODEGRAPH_DATA_ROOT = path.join(temporaryRoot, 'data');
    project = path.join(temporaryRoot, 'workspace');
    otherProject = path.join(temporaryRoot, 'other-workspace');
    for (const root of [project, otherProject]) {
      fs.mkdirSync(root);
      fs.writeFileSync(path.join(root, 'index.ts'), 'export function indexedAnswer() { return 42; }\n');
      const graph = CodeGraph.initSync(root);
      await graph.indexAll();
      graph.close();
    }
    process.env.CODEGRAPH_MCP_READ_ONLY = '1';
  });

  afterEach(() => {
    for (const engine of engines.splice(0)) engine.stop();
    if (previousDataRoot === undefined) delete process.env.CODEGRAPH_DATA_ROOT;
    else process.env.CODEGRAPH_DATA_ROOT = previousDataRoot;
    if (previousReadOnly === undefined) delete process.env.CODEGRAPH_MCP_READ_ONLY;
    else process.env.CODEGRAPH_MCP_READ_ONLY = previousReadOnly;
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  function createEngine(): MCPEngine {
    const engine = new MCPEngine({ watch: true, queryPool: true });
    engines.push(engine);
    return engine;
  }

  function assertReadOnly(graph: CodeGraph): void {
    expect(getCodeGraphState(graph).db.isReadOnly()).toBe(true);
    expect(graph.searchNodes('indexedAnswer').length).toBeGreaterThan(0);
    expect(() => graph.clear()).toThrow(/read-only mode/);
  }

  it('requires an explicit environment opt-in', () => {
    for (const raw of [undefined, '', '0', 'false', 'true']) {
      expect(mcpReadOnlyEnabled({ CODEGRAPH_MCP_READ_ONLY: raw })).toBe(false);
    }
    expect(mcpReadOnlyEnabled({ CODEGRAPH_MCP_READ_ONLY: '1' })).toBe(true);
  });

  it('opens the default index without catch-up sync, watchers, or query workers', async () => {
    const dbPath = getDatabasePath(project);
    const before = fs.readFileSync(dbPath);
    const beforeEntries = fs.readdirSync(path.dirname(dbPath)).sort();
    fs.writeFileSync(path.join(project, 'index.ts'), 'export function changedAfterIndex() {}\n');
    const sync = spyOn(CodeGraph.prototype, 'sync');
    const watch = spyOn(CodeGraph.prototype, 'watch');
    try {
      const engine = createEngine();
      await engine.ensureInitialized(project);
      const state = getToolHandlerState(engine.getToolHandler());
      assertReadOnly(state.getCodeGraph());
      expect(state.getCodeGraph().searchNodes('changedAfterIndex')).toHaveLength(0);
      expect(state.queryPool).toBeNull();
      expect(state.catchUpGate).toBeNull();
      expect(sync).not.toHaveBeenCalled();
      expect(watch).not.toHaveBeenCalled();
      engine.stop();
      expect(fs.readFileSync(dbPath)).toEqual(before);
      expect(fs.readdirSync(path.dirname(dbPath)).sort()).toEqual(beforeEntries);
    } finally {
      sync.mockRestore();
      watch.mockRestore();
    }
  });

  it('keeps synchronous retry, cross-project access, and replaced indexes read-only', () => {
    const engine = createEngine();
    engine.retryInitializeSync(project);
    const state = getToolHandlerState(engine.getToolHandler());
    for (const requestedRoot of [undefined, otherProject]) {
      const graph = state.getCodeGraph(requestedRoot);
      assertReadOnly(graph);
      const dbPath = getDatabasePath(graph.getProjectRoot());
      const replacement = `${dbPath}.replacement`;
      fs.copyFileSync(dbPath, replacement);
      fs.renameSync(replacement, dbPath);
      expect(state.getCodeGraph(requestedRoot)).toBe(graph);
      assertReadOnly(graph);
    }
    expect(state.queryPool).toBeNull();
    expect(state.catchUpGate).toBeNull();
  });

  it('leaves standalone synchronous opens writable without an explicit option', () => {
    const graph = CodeGraph.openSync(project);
    try {
      expect(getCodeGraphState(graph).db.isReadOnly()).toBe(false);
    } finally {
      graph.close();
    }
  });

  it('starts a direct read-only server even when an inherited daemon flag is set', async () => {
    const beforeEntries = fs.readdirSync(path.dirname(getDatabasePath(project))).sort();
    const child = spawn(process.execPath, [
      path.resolve(import.meta.dir, '../src/bin/cheshi-codegraph.ts'),
      'serve', '--mcp', '--path', project,
    ], {
      cwd: project,
      env: { ...process.env, CODEGRAPH_DAEMON_INTERNAL: '1', CODEGRAPH_MCP_DEBUG: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      let stdout = '';
      const timeout = setTimeout(() => reject(new Error(`MCP handshake timed out: ${stderr}`)), 5_000);
      child.on('error', reject);
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
        const lines = stdout.split('\n');
        stdout = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const message = JSON.parse(line) as Record<string, unknown>;
          if (message.id !== 1) continue;
          clearTimeout(timeout);
          resolve(message);
        }
      });
    });
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'read-only-test', version: '1' },
      } })}\n`);
      expect((await response).result).toBeDefined();
      expect(stderr).toContain('Direct mode: CODEGRAPH_MCP_READ_ONLY set');
    } finally {
      const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
      child.kill('SIGTERM');
      await closed;
    }
    expect(fs.readdirSync(path.dirname(getDatabasePath(project))).sort()).toEqual(beforeEntries);
  }, 10_000);
});
