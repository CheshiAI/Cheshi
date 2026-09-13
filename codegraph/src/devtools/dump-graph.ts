#!/usr/bin/env bun

import { Database } from 'bun:sqlite';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

import { configureCheshiCodeGraphEnvironment } from '../bin/cheshi-environment';
import { getCodeGraphDir } from '../directory';
import { errorMessage } from './cli-tooling';

type DumpRow = Record<string, unknown>;

export function resolveGraphDatabasePath(argument: string): string {
  configureCheshiCodeGraphEnvironment();
  const resolvedInput = path.resolve(argument);
  if (!existsSync(resolvedInput)) throw new Error(`path not found: ${resolvedInput}`);
  if (!statSync(resolvedInput).isDirectory()) return resolvedInput;

  const directDatabase = path.join(resolvedInput, 'codegraph.db');
  if (existsSync(directDatabase)) return directDatabase;

  const workspaceDatabase = path.join(getCodeGraphDir(resolvedInput), 'codegraph.db');
  if (existsSync(workspaceDatabase)) return workspaceDatabase;
  throw new Error(`CodeGraph database not found for workspace: ${resolvedInput}`);
}

function writeTable(database: Database, title: string, sql: string): void {
  const rows = database.prepare(sql).all() as DumpRow[];
  const lines = rows.map((row) => JSON.stringify(row)).sort();
  process.stdout.write(`== ${title} (${lines.length})\n`);
  for (const line of lines) process.stdout.write(`${line}\n`);
}

export function runDumpGraph(args: readonly string[]): number {
  const [input, ...extra] = args;
  if (!input || extra.length > 0) {
    throw new Error('usage: dump-graph <workspace-or-db-path>');
  }

  const database = new Database(resolveGraphDatabasePath(input), {
    readonly: true,
    strict: true,
  });
  try {
    writeTable(
      database,
      'nodes',
      `SELECT id, kind, name, qualified_name, file_path, language, start_line, end_line,
              start_column, end_column, docstring, signature, visibility, is_exported,
              is_async, is_static, is_abstract, decorators, type_parameters, return_type
       FROM nodes`,
    );
    writeTable(
      database,
      'edges',
      'SELECT source, target, kind, metadata, line, col, provenance FROM edges',
    );
    writeTable(
      database,
      'refs',
      `SELECT from_node_id, reference_name, reference_kind, line, col, candidates,
              file_path, language, status, name_tail
       FROM unresolved_refs`,
    );
    writeTable(database, 'files', 'SELECT path, language, node_count FROM files');
  } finally {
    database.close();
  }
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = runDumpGraph(process.argv.slice(2));
  } catch (error) {
    console.error(`[dump-graph] ${errorMessage(error)}`);
    process.exitCode = 2;
  }
}
