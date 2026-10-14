import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import CodeGraph, { DatabaseConnection, getDatabasePath } from '../src';
import { MCPEngine } from '../src/mcp/engine';
import { ToolHandler } from '../src/mcp/tools';
import { getCodeGraphState, getToolHandlerState } from './helpers/internal-state';

const malformed = () => Object.assign(new Error('database disk image is malformed'), { code: 'SQLITE_CORRUPT', errno: 11 });

describe('read-only MCP connection recovery', () => {
  let temporary: string;
  let root: string;
  let previousDataRoot: string | undefined;
  const engines: MCPEngine[] = [];

  beforeEach(async () => {
    temporary = mkdtempSync(join(tmpdir(), 'codegraph-mcp-recovery-'));
    previousDataRoot = process.env.CODEGRAPH_DATA_ROOT;
    process.env.CODEGRAPH_DATA_ROOT = join(temporary, 'data');
    root = join(temporary, 'project');
    mkdirSync(root);
    writeFileSync(join(root, 'main.ts'), 'export function originalAnswer() { return 42; }\n');
    const writer = CodeGraph.initSync(root);
    try {
      await writer.indexAll();
      getCodeGraphState(writer).db.getDb().exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally { writer.close(); }
  });

  afterEach(() => {
    for (const engine of engines.splice(0)) engine.stop();
    if (previousDataRoot === undefined) delete process.env.CODEGRAPH_DATA_ROOT;
    else process.env.CODEGRAPH_DATA_ROOT = previousDataRoot;
    rmSync(temporary, { recursive: true, force: true });
  });

  async function reader(explicitProject = false) {
    const engine = new MCPEngine({ readOnly: true });
    engines.push(engine);
    if (!explicitProject) await engine.ensureInitialized(root);
    const handler = engine.getToolHandler();
    const graph = getToolHandlerState(handler).getCodeGraph(explicitProject ? root : undefined);
    return { handler, graph, args: explicitProject ? { projectPath: root } : {} };
  }

  for (const explicitProject of [false, true]) {
    it(`recovers the ${explicitProject ? 'cached project' : 'default'} connection without replacing or writing the database`, async () => {
      const { handler, graph, args } = await reader(explicitProject);
      const path = getDatabasePath(root), inode = statSync(path).ino, before = readFileSync(path);
      const stale = getCodeGraphState(graph).db;
      const failure = spyOn(stale.getDb(), 'prepare').mockImplementation(() => { throw malformed(); });
      try {
        const result = await handler.execute('codegraph_search', { ...args, query: 'originalAnswer' });
        expect(result.isError).not.toBe(true);
        expect(result.content[0]?.text).toContain('main.ts');
        expect(getCodeGraphState(graph).db).not.toBe(stale);
        expect(stale.getDb().open).toBe(false);
        expect(getCodeGraphState(graph).db.isReadOnly()).toBe(true);
        expect(getCodeGraphState(graph).db.isImmutable()).toBe(false);
        expect(() => graph.clear()).toThrow(/read-only/);
        expect(statSync(path).ino).toBe(inode);
        expect(readFileSync(path)).toEqual(before);
        expect((await handler.execute('codegraph_search', { ...args, query: 'originalAnswer' })).isError).not.toBe(true);
      } finally { failure.mockRestore(); }
    });

    it(`observes WAL updates after the ${explicitProject ? 'cached project' : 'default'} reader opens a clean database`, async () => {
      const wal = `${getDatabasePath(root)}-wal`;
      expect(existsSync(wal) ? statSync(wal).size : 0).toBe(0);
      const { handler, graph, args } = await reader(explicitProject);
      expect(graph.searchNodes('originalAnswer').length).toBeGreaterThan(0);
      const writer = CodeGraph.openSync(root);
      try {
        const key = 'read_recovery_wal_probe';
        const database = getCodeGraphState(writer).db;
        database.setWalAutocheckpoint(0);
        database.getDb().prepare('INSERT INTO project_metadata (key, value, updated_at) VALUES (?, ?, ?)').run(key, 'updated', Date.now());
        expect(statSync(wal).size).toBeGreaterThan(0);
        expect(getCodeGraphState(graph).db.getDb().prepare('SELECT value FROM project_metadata WHERE key = ?').get(key)?.value).toBe('updated');
        writeFileSync(join(root, 'main.ts'), 'export function freshlyUpdatedAnswer() { return 12345; }\n');
        await writer.sync();
        const result = await handler.execute('codegraph_search', { ...args, query: 'freshlyUpdatedAnswer' });
        expect(result.isError).not.toBe(true);
        expect(graph.searchNodes('freshlyUpdatedAnswer').length).toBeGreaterThan(0);
        expect(graph.searchNodes('originalAnswer')).toHaveLength(0);
      } finally { writer.close(); }
    });
  }

  it('also recovers status requests', async () => {
    const { handler, graph } = await reader();
    const failure = spyOn(getCodeGraphState(graph).db.getDb(), 'prepare').mockImplementation(() => { throw malformed(); });
    try { expect((await handler.execute('codegraph_status', {})).isError).not.toBe(true); }
    finally { failure.mockRestore(); }
  });

  it('keeps concurrent explore requests usable when they encounter the same failed connection', async () => {
    const { handler, graph } = await reader();
    const stale = getCodeGraphState(graph).db;
    const failure = spyOn(stale.getDb(), 'prepare').mockImplementation(() => { throw malformed(); });
    try {
      const results = await Promise.all(Array.from({ length: 3 }, () =>
        handler.execute('codegraph_explore', { query: 'originalAnswer', maxFiles: 1 })));
      for (const result of results) {
        expect(result.isError).not.toBe(true);
        expect(result.content[0]?.text).toContain('main.ts');
      }
      expect(stale.getDb().open).toBe(false);
    } finally { failure.mockRestore(); }
  });

  it('retries a persistent query failure only once', async () => {
    const { handler } = await reader();
    const dispatch = spyOn(getToolHandlerState(handler), 'dispatchTool').mockImplementation(async () => { throw malformed(); });
    const open = spyOn(DatabaseConnection, 'open');
    try {
      const result = await handler.execute('codegraph_search', { query: 'originalAnswer' });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('database disk image is malformed');
      expect(dispatch).toHaveBeenCalledTimes(2);
      expect(open).toHaveBeenCalledTimes(1);
    } finally { dispatch.mockRestore(); open.mockRestore(); }
  });

  it('preserves the existing handle if opening a replacement fails', async () => {
    const { handler, graph } = await reader();
    const stale = getCodeGraphState(graph).db;
    const failure = spyOn(stale.getDb(), 'prepare').mockImplementation(() => { throw malformed(); });
    const open = spyOn(DatabaseConnection, 'open').mockImplementation(() => { throw new Error('replacement unavailable'); });
    try {
      const result = await handler.execute('codegraph_search', { query: 'originalAnswer' });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('replacement unavailable');
      expect(open).toHaveBeenCalledTimes(1);
      expect(getCodeGraphState(graph).db).toBe(stale);
      expect(stale.getDb().open).toBe(true);
    } finally { failure.mockRestore(); open.mockRestore(); }
    expect((await handler.execute('codegraph_search', { query: 'originalAnswer' })).isError).not.toBe(true);
  });

  it('reports actual disk corruption without rebuilding or modifying the damaged file', async () => {
    const { handler, graph } = await reader();
    const path = getDatabasePath(root);
    const damaged = Buffer.alloc(256, 0x5a);
    writeFileSync(path, damaged);
    const failure = spyOn(getCodeGraphState(graph).db.getDb(), 'prepare').mockImplementation(() => { throw malformed(); });
    const open = spyOn(DatabaseConnection, 'open');
    try {
      const result = await handler.execute('codegraph_search', { query: 'originalAnswer' });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('not a database');
      expect(open).toHaveBeenCalledTimes(1);
      expect(readFileSync(path)).toEqual(damaged);
    } finally { failure.mockRestore(); open.mockRestore(); }
  });

  it('releases a replacement that fails layer setup and leaves the old layers usable', async () => {
    const { handler, graph } = await reader();
    const state = getCodeGraphState(graph), stale = state.db, queries = state.queries;
    const replacement = DatabaseConnection.open(getDatabasePath(root), { readOnly: true, immutable: false });
    const setup = spyOn(replacement, 'getDb').mockImplementation(() => { throw new Error('layer setup failed'); });
    const failure = spyOn(stale.getDb(), 'prepare').mockImplementation(() => { throw malformed(); });
    const open = spyOn(DatabaseConnection, 'open').mockReturnValue(replacement);
    try {
      const result = await handler.execute('codegraph_search', { query: 'originalAnswer' });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('layer setup failed');
      expect(state.db).toBe(stale);
      expect(state.queries).toBe(queries);
      expect(replacement.isOpen()).toBe(false);
    } finally { setup.mockRestore(); failure.mockRestore(); open.mockRestore(); replacement.close(); }
    expect((await handler.execute('codegraph_search', { query: 'originalAnswer' })).isError).not.toBe(true);
  });

  it('recovers a message-only SQLite error and keeps later WAL updates visible', async () => {
    const { handler, graph } = await reader();
    const stale = getCodeGraphState(graph).db;
    const failure = spyOn(stale.getDb(), 'prepare').mockImplementation(() => { throw new Error('database disk image is malformed'); });
    try { expect((await handler.execute('codegraph_search', { query: 'originalAnswer' })).isError).not.toBe(true); }
    finally { failure.mockRestore(); }
    const writer = DatabaseConnection.open(getDatabasePath(root));
    try {
      writer.getDb().prepare('INSERT INTO project_metadata (key, value, updated_at) VALUES (?, ?, ?)').run('after_recovery', 'visible', Date.now());
      expect(getCodeGraphState(graph).db.getDb().prepare('SELECT value FROM project_metadata WHERE key = ?').get('after_recovery')?.value).toBe('visible');
    } finally { writer.close(); }
  });

  it('does not retry unrelated errors or writable connections', async () => {
    const { handler } = await reader();
    const failure = spyOn(getToolHandlerState(handler), 'dispatchTool').mockImplementation(async () => { throw new Error('database is locked'); });
    const open = spyOn(DatabaseConnection, 'open');
    try {
      expect((await handler.execute('codegraph_search', { query: 'originalAnswer' })).isError).toBe(true);
      expect(failure).toHaveBeenCalledTimes(1);
      expect(open).not.toHaveBeenCalled();
    } finally { failure.mockRestore(); open.mockRestore(); }

    const writer = CodeGraph.openSync(root);
    expect(() => writer.reopenReadOnly()).toThrow(/requires a read-only/);
    const writableHandler = new ToolHandler(writer, { readOnly: false });
    const dispatch = spyOn(getToolHandlerState(writableHandler), 'dispatchTool').mockImplementation(async () => { throw malformed(); });
    const reopen = spyOn(DatabaseConnection, 'open');
    try {
      expect((await writableHandler.execute('codegraph_search', { query: 'originalAnswer' })).isError).toBe(true);
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(reopen).not.toHaveBeenCalled();
    } finally { dispatch.mockRestore(); reopen.mockRestore(); writer.close(); }
  });
});
