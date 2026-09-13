#!/usr/bin/env bun

import { Database } from 'bun:sqlite';
import path from 'node:path';

import { configureCheshiCodeGraphEnvironment } from '../../bin/cheshi-environment';
import { getCodeGraphDir, isInitialized } from '../../directory';
import CodeGraph from '../../index';
import { LANGUAGES, type Language, type NodeKind } from '../../types';
import { errorMessage } from '../cli-tooling';

const structuralSymbolKinds = [
  'module',
  'class',
  'struct',
  'interface',
  'trait',
  'protocol',
  'function',
  'method',
  'property',
  'field',
  'variable',
  'constant',
  'enum',
  'enum_member',
  'type_alias',
  'namespace',
  'route',
  'component',
] as const satisfies readonly NodeKind[];
const structuralSymbolKindSet = new Set<NodeKind>(structuralSymbolKinds);

interface CountRow {
  count: number;
}

interface KindCountRow extends CountRow {
  kind: NodeKind;
}

interface ExtractionMetrics {
  files: number;
  symbols: number;
  edges: number;
  nodesByKind: Partial<Record<NodeKind, number>>;
}

interface Check {
  severity: 'critical' | 'soft';
  ok: boolean;
  label: string;
  detail: string;
}

export function parseExtractionLanguage(value: string): Language {
  if ((LANGUAGES as readonly string[]).includes(value)) return value as Language;
  throw new Error(`unsupported language "${value}"`);
}

export function readExtractionMetrics(databasePath: string, language: Language): ExtractionMetrics {
  const database = new Database(databasePath, { readonly: true, strict: true });
  try {
    const files = database
      .query<CountRow, [Language]>('SELECT COUNT(*) AS count FROM files WHERE language = ?')
      .get(language)?.count ?? 0;
    const kindRows = database
      .query<KindCountRow, [Language]>(
        'SELECT kind, COUNT(*) AS count FROM nodes WHERE language = ? GROUP BY kind',
      )
      .all(language);
    const nodesByKind: Partial<Record<NodeKind, number>> = {};
    for (const row of kindRows) nodesByKind[row.kind] = row.count;
    const symbols = structuralSymbolKinds.reduce(
      (total, kind) => total + (nodesByKind[kind] ?? 0),
      0,
    );
    const edges = database
      .query<CountRow, [Language]>(
        `SELECT COUNT(*) AS count
         FROM edges
         JOIN nodes ON nodes.id = edges.source
         WHERE nodes.language = ?`,
      )
      .get(language)?.count ?? 0;
    return { files, symbols, edges, nodesByKind };
  } finally {
    database.close();
  }
}

export async function runVerifyExtraction(args: readonly string[]): Promise<number> {
  const [workspaceArgument, languageArgument, ...extra] = args;
  if (!workspaceArgument || !languageArgument || extra.length > 0) {
    throw new Error('usage: verify-extraction <workspace-path> <language>');
  }

  configureCheshiCodeGraphEnvironment();
  const workspace = path.resolve(workspaceArgument);
  const language = parseExtractionLanguage(languageArgument);
  if (isInitialized(workspace) !== true) {
    throw new Error(`CodeGraph is not initialized for workspace: ${workspace}`);
  }

  const codeGraph = await CodeGraph.open(workspace, { readOnly: true });
  let indexState: ReturnType<typeof codeGraph.getIndexState>;
  let pendingReferences: number;
  try {
    indexState = codeGraph.getIndexState();
    pendingReferences = codeGraph.getPendingReferenceCount();
  } finally {
    codeGraph.close();
  }

  const databasePath = path.join(getCodeGraphDir(workspace), 'codegraph.db');
  const metrics = readExtractionMetrics(databasePath, language);
  const symbolKinds = Object.entries(metrics.nodesByKind)
    .filter(([kind, count]) => (
      structuralSymbolKindSet.has(kind as NodeKind) && count !== undefined && count > 0
    ))
    .map(([kind]) => kind);

  const checks: Check[] = [];
  const add = (severity: Check['severity'], ok: boolean, label: string, detail: string): void => {
    checks.push({ severity, ok, label, detail });
  };
  add('critical', indexState === 'complete', 'index complete', `state=${indexState ?? 'unknown'}`);
  add('critical', pendingReferences === 0, 'references resolved', `pendingRefs=${pendingReferences}`);
  add('critical', metrics.files > 0, `language "${language}" detected`, `${metrics.files} files`);
  add(
    'critical',
    metrics.symbols > 0,
    'structural symbols extracted',
    `${metrics.symbols} symbols (${symbolKinds.join(', ') || 'NONE — only file/import nodes!'})`,
  );
  add(
    'soft',
    metrics.symbols >= metrics.files,
    'symbol density >= 1/file',
    `${metrics.symbols} symbols across ${metrics.files} ${language} files`,
  );
  add(
    'soft',
    metrics.edges > metrics.files,
    'edges resolved',
    `${metrics.edges} edges sourced from ${metrics.files} ${language} files`,
  );

  console.log(`\n# Extraction check — ${workspace}  (lang=${language})`);
  console.log(`  files=${metrics.files} symbols=${metrics.symbols} edges=${metrics.edges}`);
  console.log(`  nodesByKind: ${JSON.stringify(metrics.nodesByKind)}\n`);
  for (const check of checks) {
    console.log(`  ${check.ok ? '✓' : '✗'} ${check.label} — ${check.detail}`);
  }

  const criticalFailures = checks.filter((check) => !check.ok && check.severity === 'critical');
  const softFailures = checks.filter((check) => !check.ok && check.severity === 'soft');
  console.log();
  if (criticalFailures.length > 0) {
    console.log(
      `RESULT: FAIL (${criticalFailures.length} critical) — extractor or grammar wiring is broken. `
      + 'Run the typed dump-ast tool and fix the node-type mappings.',
    );
    return 1;
  }
  if (softFailures.length > 0) {
    console.log(
      `RESULT: WARN (${softFailures.length} soft) — extraction works but looks thin; `
      + 'inspect the language-specific counts above.',
    );
    return 0;
  }
  console.log('RESULT: PASS — extraction looks healthy.');
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = await runVerifyExtraction(process.argv.slice(2));
  } catch (error) {
    console.error(`[verify-extraction] ${errorMessage(error)}`);
    process.exitCode = 2;
  }
}
