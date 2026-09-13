#!/usr/bin/env bun

import * as fs from 'node:fs';
import path from 'node:path';

import { isCodeGraphDataDir } from '../directory';
import { detectLanguage, initGrammars, loadGrammarsForLanguages } from '../extraction/grammars';
import { extractFromSource } from '../extraction/tree-sitter';
import { getKernel, tryKernelExtract } from '../extraction/kernel';
import type { Edge, Language, Node, UnresolvedReference } from '../types';
import { errorMessage } from './cli-tooling';

const codeGraphRoot = path.resolve(import.meta.dir, '..', '..');

const kernelLanguages = [
  'typescript',
  'tsx',
  'javascript',
  'jsx',
  'java',
  'python',
  'go',
  'c',
  'cpp',
  'rust',
  'csharp',
  'ruby',
  'php',
  'swift',
  'kotlin',
  'r',
  'lua',
  'luau',
  'scala',
  'dart',
] as const satisfies readonly Language[];

type KernelLanguage = (typeof kernelLanguages)[number];
type DetectedLanguage = KernelLanguage | 'detect';

const kernelLanguageSet = new Set<Language>(kernelLanguages);
const languageAliases: Readonly<Record<string, KernelLanguage>> = {
  ts: 'typescript',
  js: 'javascript',
  cs: 'csharp',
};
const extensions = new Map<string, DetectedLanguage>([
  ['.ts', 'typescript'], ['.mts', 'typescript'], ['.cts', 'typescript'],
  ['.tsx', 'tsx'], ['.js', 'javascript'], ['.mjs', 'javascript'],
  ['.cjs', 'javascript'], ['.jsx', 'jsx'], ['.java', 'java'], ['.py', 'python'],
  ['.pyw', 'python'], ['.go', 'go'], ['.c', 'c'], ['.h', 'detect'],
  ['.cpp', 'cpp'], ['.cc', 'cpp'], ['.cxx', 'cpp'], ['.hpp', 'cpp'],
  ['.hxx', 'cpp'], ['.metal', 'cpp'], ['.cu', 'cpp'], ['.cuh', 'cpp'],
  ['.rs', 'rust'], ['.cs', 'csharp'], ['.rb', 'ruby'], ['.rake', 'ruby'],
  ['.php', 'php'], ['.module', 'php'], ['.install', 'php'], ['.theme', 'php'],
  ['.inc', 'php'], ['.swift', 'swift'], ['.kt', 'kotlin'], ['.kts', 'kotlin'],
  ['.r', 'r'], ['.lua', 'lua'], ['.luau', 'luau'], ['.scala', 'scala'],
  ['.sc', 'scala'], ['.dart', 'dart'],
]);

interface KernelParityOptions {
  paths: string[];
  languages: Set<KernelLanguage> | null;
  maxSamples: number;
  listFiles: boolean;
  maxDeferral: number;
}

interface CandidateFile {
  file: string;
  language: DetectedLanguage;
}

interface DifferenceBucket {
  count: number;
  samples: string[];
}

function requireOptionValue(args: readonly string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
  return value;
}

function parsePositiveInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${option} must be a positive integer: ${value}`);
  }
  return parsed;
}

function parseDeferralRate(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`--max-deferral must be between 0 and 1: ${value}`);
  }
  return parsed;
}

function parseLanguageFilter(value: string): Set<KernelLanguage> {
  const languages = new Set<KernelLanguage>();
  for (const token of value.split(',')) {
    const normalized = token.trim().toLowerCase();
    const language = languageAliases[normalized]
      ?? kernelLanguages.find((candidate) => candidate === normalized);
    if (!language) throw new Error(`unsupported kernel language: ${token}`);
    languages.add(language);
  }
  if (languages.size === 0) throw new Error('--lang requires at least one language');
  return languages;
}

export function parseKernelParityArguments(args: readonly string[]): KernelParityOptions {
  const paths: string[] = [];
  let languages: Set<KernelLanguage> | null = null;
  let maxSamples = 5;
  let listFiles = false;
  let maxDeferral = 0.1;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--lang') {
      languages = parseLanguageFilter(requireOptionValue(args, index, argument));
      index += 1;
    } else if (argument === '--max-samples') {
      maxSamples = parsePositiveInteger(requireOptionValue(args, index, argument), argument);
      index += 1;
    } else if (argument === '--list-files') {
      listFiles = true;
    } else if (argument === '--max-deferral') {
      maxDeferral = parseDeferralRate(requireOptionValue(args, index, argument));
      index += 1;
    } else if (argument.startsWith('--')) {
      throw new Error(`unknown option: ${argument}`);
    } else {
      paths.push(path.resolve(argument));
    }
  }

  if (paths.length === 0) {
    throw new Error(
      'usage: kernel-parity <file-or-dir>... [--lang typescript,tsx] '
      + '[--max-samples N] [--list-files] [--max-deferral 0.1]',
    );
  }
  return { paths, languages, maxSamples, listFiles, maxDeferral };
}

function collectCandidateFiles(
  candidatePath: string,
  output: CandidateFile[],
  languageFilter: ReadonlySet<KernelLanguage> | null,
): void {
  let stats: fs.Stats;
  try {
    stats = fs.statSync(candidatePath);
  } catch {
    return;
  }

  if (stats.isDirectory()) {
    const baseName = path.basename(candidatePath);
    if (baseName === 'node_modules' || baseName === '.git' || baseName === 'dist'
      || isCodeGraphDataDir(baseName)) return;
    for (const entry of fs.readdirSync(candidatePath)) {
      collectCandidateFiles(path.join(candidatePath, entry), output, languageFilter);
    }
    return;
  }

  const language = extensions.get(path.extname(candidatePath).toLowerCase());
  if (!language) return;
  const passesFilter = !languageFilter || (language === 'detect'
    ? languageFilter.has('c') || languageFilter.has('cpp')
    : languageFilter.has(language));
  if (passesFilter) output.push({ file: candidatePath, language });
}

function canonicalNode(node: Node): string {
  const canonical: Record<string, unknown> = {
    id: node.id,
    kind: node.kind,
    name: node.name,
    qualifiedName: node.qualifiedName,
    filePath: node.filePath,
    language: node.language,
    startLine: node.startLine,
    endLine: node.endLine,
    startColumn: node.startColumn,
    endColumn: node.endColumn,
  };
  const optionalKeys = [
    'docstring', 'signature', 'visibility', 'isExported', 'isAsync',
    'isStatic', 'isAbstract', 'returnType', 'decorators', 'typeParameters',
  ] as const satisfies readonly (keyof Node)[];
  for (const key of optionalKeys) {
    if (node[key] !== undefined) canonical[key] = node[key];
  }
  return JSON.stringify(canonical);
}

function canonicalEdge(edge: Edge): string {
  const canonical: Record<string, unknown> = {
    source: edge.source,
    target: edge.target,
    kind: edge.kind,
  };
  const optionalKeys = (
    ['line', 'column', 'provenance', 'metadata'] as const
  ) satisfies readonly (keyof Edge)[];
  for (const key of optionalKeys) {
    if (edge[key] !== undefined) canonical[key] = edge[key];
  }
  return JSON.stringify(canonical);
}

function canonicalReference(reference: UnresolvedReference): string {
  const canonical: Record<string, unknown> = {
    from: reference.fromNodeId,
    name: reference.referenceName,
    kind: reference.referenceKind,
    line: reference.line,
    column: reference.column,
  };
  const optionalKeys = (
    ['filePath', 'language', 'candidates', 'rowId'] as const
  ) satisfies readonly (keyof UnresolvedReference)[];
  for (const key of optionalKeys) {
    if (reference[key] !== undefined) canonical[key] = reference[key];
  }
  return JSON.stringify(canonical);
}

function difference(left: readonly string[], right: readonly string[]): {
  onlyLeft: string[];
  onlyRight: string[];
} {
  const leftCounts = new Map<string, number>();
  const rightCounts = new Map<string, number>();
  for (const value of left) leftCounts.set(value, (leftCounts.get(value) ?? 0) + 1);
  for (const value of right) rightCounts.set(value, (rightCounts.get(value) ?? 0) + 1);

  const onlyLeft: string[] = [];
  const onlyRight: string[] = [];
  for (const [value, count] of leftCounts) {
    const differenceCount = count - (rightCounts.get(value) ?? 0);
    for (let index = 0; index < differenceCount; index += 1) onlyLeft.push(value);
  }
  for (const [value, count] of rightCounts) {
    const differenceCount = count - (leftCounts.get(value) ?? 0);
    for (let index = 0; index < differenceCount; index += 1) onlyRight.push(value);
  }
  return { onlyLeft, onlyRight };
}

export async function runKernelParity(args: readonly string[]): Promise<number> {
  const options = parseKernelParityArguments(args);
  const files: CandidateFile[] = [];
  for (const candidatePath of options.paths) {
    collectCandidateFiles(candidatePath, files, options.languages);
  }
  if (files.length === 0) throw new Error('no matching files');

  await initGrammars();
  await loadGrammarsForLanguages([...kernelLanguages]);
  if (!getKernel()) throw new Error('kernel .node not found — run: bun run build:kernel');

  const previousKernelLanguages = process.env.CODEGRAPH_KERNEL_LANGS;
  const previousKernelSetting = process.env.CODEGRAPH_KERNEL;
  const buckets = new Map<string, DifferenceBucket>();
  const report = (category: string, sample: string): void => {
    const bucket = buckets.get(category) ?? { count: 0, samples: [] };
    bucket.count += 1;
    if (bucket.samples.length < options.maxSamples) bucket.samples.push(sample);
    buckets.set(category, bucket);
  };

  let filesWithDifferences = 0;
  let matchingFiles = 0;
  let deferredFiles = 0;
  let processedFiles = 0;
  const totals = { nodes: 0, edges: 0, refs: 0 };

  try {
    process.env.CODEGRAPH_KERNEL_LANGS = 'all';
    for (const candidate of files) {
      const source = fs.readFileSync(candidate.file, 'utf8');
      const relativePath = path.relative(codeGraphRoot, candidate.file);
      const detected = candidate.language === 'detect'
        ? detectLanguage(relativePath, source)
        : candidate.language;
      if (!kernelLanguageSet.has(detected)) continue;
      const language = detected as KernelLanguage;
      if (options.languages && !options.languages.has(language)) continue;
      processedFiles += 1;

      delete process.env.CODEGRAPH_KERNEL;
      const kernelResult = tryKernelExtract(relativePath, source, language);
      if (!kernelResult) {
        deferredFiles += 1;
        report('kernel-deferred', relativePath);
        continue;
      }
      process.env.CODEGRAPH_KERNEL = '0';
      const wasmResult = extractFromSource(relativePath, source, language);
      delete process.env.CODEGRAPH_KERNEL;

      totals.nodes += wasmResult.nodes.length;
      totals.edges += wasmResult.edges.length;
      totals.refs += wasmResult.unresolvedReferences.length;

      let fileHasDifference = false;
      const tables: Array<[string, string[], string[]]> = [
        ['node', wasmResult.nodes.map(canonicalNode), kernelResult.nodes.map(canonicalNode)],
        ['edge', wasmResult.edges.map(canonicalEdge), kernelResult.edges.map(canonicalEdge)],
        [
          'ref',
          wasmResult.unresolvedReferences.map(canonicalReference),
          kernelResult.unresolvedReferences.map(canonicalReference),
        ],
      ];
      for (const [table, wasmRows, kernelRows] of tables) {
        const { onlyLeft, onlyRight } = difference(wasmRows, kernelRows);
        for (const serialized of onlyLeft) {
          fileHasDifference = true;
          const row = JSON.parse(serialized) as { kind?: string };
          report(`${table}:missing-in-kernel:${row.kind ?? ''}`, `${relativePath}: ${serialized}`);
        }
        for (const serialized of onlyRight) {
          fileHasDifference = true;
          const row = JSON.parse(serialized) as { kind?: string };
          report(`${table}:extra-in-kernel:${row.kind ?? ''}`, `${relativePath}: ${serialized}`);
        }
        if (onlyLeft.length === 0 && onlyRight.length === 0) {
          for (let index = 0; index < wasmRows.length; index += 1) {
            if (wasmRows[index] !== kernelRows[index]) {
              fileHasDifference = true;
              report(
                `${table}:order-mismatch`,
                `${relativePath}: index ${index}: wasm=${wasmRows[index]} kernel=${kernelRows[index]}`,
              );
              break;
            }
          }
        }
      }

      if (fileHasDifference) {
        filesWithDifferences += 1;
        if (options.listFiles) console.log(`DIFF ${relativePath}`);
      } else {
        matchingFiles += 1;
      }
    }
  } finally {
    if (previousKernelLanguages === undefined) delete process.env.CODEGRAPH_KERNEL_LANGS;
    else process.env.CODEGRAPH_KERNEL_LANGS = previousKernelLanguages;
    if (previousKernelSetting === undefined) delete process.env.CODEGRAPH_KERNEL;
    else process.env.CODEGRAPH_KERNEL = previousKernelSetting;
  }

  console.log(
    `\n=== kernel parity: ${matchingFiles}/${processedFiles} files byte-parity `
    + `(${filesWithDifferences} with diffs, ${deferredFiles} deferred-to-wasm) `
    + `| wasm totals: ${totals.nodes} nodes / ${totals.edges} edges / ${totals.refs} refs ===\n`,
  );
  const sortedBuckets = [...buckets.entries()].sort((left, right) => right[1].count - left[1].count);
  for (const [category, bucket] of sortedBuckets) {
    console.log(`--- ${category}: ${bucket.count}`);
    for (const sample of bucket.samples) {
      console.log(`    ${sample.length > 400 ? `${sample.slice(0, 400)}…` : sample}`);
    }
  }

  const deferralRate = deferredFiles / Math.max(processedFiles, 1);
  if (deferralRate > options.maxDeferral) {
    console.error(
      `deferral rate ${(deferralRate * 100).toFixed(1)}% exceeds `
      + `${(options.maxDeferral * 100).toFixed(0)}% — kernel likely broken`,
    );
    return 1;
  }
  return filesWithDifferences > 0 ? 1 : 0;
}

if (import.meta.main) {
  try {
    process.exitCode = await runKernelParity(process.argv.slice(2));
  } catch (error) {
    console.error(`[kernel-parity] ${errorMessage(error)}`);
    process.exitCode = 2;
  }
}
