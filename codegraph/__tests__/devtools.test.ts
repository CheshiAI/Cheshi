import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';

import { codeGraphStorageDirectory } from '../../config/workspace-storage.mts';
import { parseCheckGrammarArguments } from '../src/devtools/add-lang/check-grammar';
import { parseDumpAstArguments } from '../src/devtools/add-lang/dump-ast';
import {
  parseExtractionLanguage,
  readExtractionMetrics,
} from '../src/devtools/add-lang/verify-extraction';
import { resolveGraphDatabasePath } from '../src/devtools/dump-graph';
import { parseKernelParityArguments } from '../src/devtools/kernel-parity';

const temporaryDirectories: string[] = [];

function createTemporaryDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('typed CodeGraph developer tools', () => {
  it('parses grammar tool arguments with validated numeric values', () => {
    expect(parseCheckGrammarArguments(['lua', 'sample.lua', '3'])).toEqual({
      grammar: 'lua',
      sampleFile: path.resolve('sample.lua'),
      iterations: 3,
    });
    expect(parseDumpAstArguments(['lua', 'sample.lua', '--depth=4', '--full'])).toEqual({
      grammar: 'lua',
      sampleFile: path.resolve('sample.lua'),
      maxDepth: 4,
      showAll: true,
    });
    expect(() => parseCheckGrammarArguments(['lua', 'sample.lua', '0'])).toThrow(
      'iterations must be a positive integer',
    );
    expect(() => parseCheckGrammarArguments(['lua', 'sample.lua', '1.5'])).toThrow(
      'iterations must be a positive integer',
    );
    expect(() => parseDumpAstArguments(['lua', 'sample.lua', '--depth=-1'])).toThrow(
      '--depth must be a non-negative integer',
    );
    expect(() => parseDumpAstArguments(['lua', 'sample.lua', '--depth=2x'])).toThrow(
      '--depth must be a non-negative integer',
    );
    expect(() => parseDumpAstArguments(['lua', 'sample.lua', 'extra.lua'])).toThrow(
      'usage: dump-ast',
    );
  });

  it('normalizes kernel language aliases and rejects unknown options', () => {
    const options = parseKernelParityArguments([
      'fixtures',
      '--lang',
      'ts,tsx',
      '--max-samples',
      '2',
      '--max-deferral',
      '0.3',
      '--list-files',
    ]);

    expect(options.paths).toEqual([path.resolve('fixtures')]);
    expect([...(options.languages ?? [])]).toEqual(['typescript', 'tsx']);
    expect(options.maxSamples).toBe(2);
    expect(options.maxDeferral).toBe(0.3);
    expect(options.listFiles).toBe(true);
    expect(() => parseKernelParityArguments(['fixtures', '--unknown'])).toThrow(
      'unknown option: --unknown',
    );
    expect(() => parseKernelParityArguments(['fixtures', '--max-samples', '1.5'])).toThrow(
      '--max-samples must be a positive integer',
    );
  });

  it('resolves a workspace through Cheshi central storage', () => {
    const previousDataRoot = process.env.CODEGRAPH_DATA_ROOT;
    const dataRoot = createTemporaryDirectory('codegraph-devtool-data-');
    const workspace = createTemporaryDirectory('codegraph-devtool-workspace-');
    const indexDirectory = codeGraphStorageDirectory(dataRoot, workspace);
    const databasePath = path.join(indexDirectory, 'codegraph.db');
    fs.mkdirSync(indexDirectory, { recursive: true });
    fs.writeFileSync(databasePath, 'fixture');
    try {
      process.env.CODEGRAPH_DATA_ROOT = dataRoot;
      expect(resolveGraphDatabasePath(workspace)).toBe(databasePath);
    } finally {
      if (previousDataRoot === undefined) delete process.env.CODEGRAPH_DATA_ROOT;
      else process.env.CODEGRAPH_DATA_ROOT = previousDataRoot;
    }
  });

  it('computes extraction health for only the requested language', () => {
    const directory = createTemporaryDirectory('codegraph-devtool-metrics-');
    const databasePath = path.join(directory, 'codegraph.db');
    const database = new Database(databasePath);
    try {
      database.exec(fs.readFileSync(path.resolve(import.meta.dir, '../src/db/schema.sql'), 'utf8'));

      const insertFile = database.prepare(
        `INSERT INTO files
           (path, content_hash, language, size, modified_at, indexed_at, node_count)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      insertFile.run('src/app.ts', 'ts-hash', 'typescript', 1, 1, 1, 2);
      insertFile.run('src/tool.py', 'py-hash', 'python', 1, 1, 1, 3);

      const insertNode = database.prepare(
        `INSERT INTO nodes
           (id, kind, name, qualified_name, file_path, language,
            start_line, end_line, start_column, end_column, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      insertNode.run(
        'ts-file', 'file', 'app.ts', 'app.ts', 'src/app.ts', 'typescript', 1, 1, 0, 0, 1,
      );
      insertNode.run(
        'ts-function', 'function', 'app', 'app', 'src/app.ts', 'typescript', 1, 1, 0, 0, 1,
      );
      insertNode.run(
        'py-file', 'file', 'tool.py', 'tool.py', 'src/tool.py', 'python', 1, 1, 0, 0, 1,
      );
      insertNode.run(
        'py-a', 'function', 'a', 'a', 'src/tool.py', 'python', 1, 1, 0, 0, 1,
      );
      insertNode.run(
        'py-b', 'class', 'B', 'B', 'src/tool.py', 'python', 1, 1, 0, 0, 1,
      );

      const insertEdge = database.prepare(
        'INSERT INTO edges (source, target, kind) VALUES (?, ?, ?)',
      );
      insertEdge.run('ts-function', 'external', 'calls');
      insertEdge.run('py-a', 'py-b', 'calls');
      insertEdge.run('py-b', 'py-a', 'calls');
    } finally {
      database.close();
    }

    expect(readExtractionMetrics(databasePath, 'typescript')).toEqual({
      files: 1,
      symbols: 1,
      edges: 1,
      nodesByKind: { file: 1, function: 1 },
    });
    expect(parseExtractionLanguage('typescript')).toBe('typescript');
    expect(() => parseExtractionLanguage('ts')).toThrow('unsupported language "ts"');
  });
});
