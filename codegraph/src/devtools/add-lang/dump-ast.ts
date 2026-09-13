#!/usr/bin/env bun

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Node as SyntaxNode } from 'web-tree-sitter';
import { Parser } from 'web-tree-sitter';

import { errorMessage } from '../cli-tooling';
import { initializeTreeSitter, loadGrammar } from '../grammar-tooling';

interface DumpAstOptions {
  grammar: string;
  sampleFile: string;
  maxDepth: number;
  showAll: boolean;
}

export function parseDumpAstArguments(args: readonly string[]): DumpAstOptions {
  const positional = args.filter((argument) => !argument.startsWith('--'));
  const [grammar, sampleFile, ...extraPositional] = positional;
  if (!grammar || !sampleFile || extraPositional.length > 0) {
    throw new Error('usage: dump-ast <lang|wasm-path> <sample-file> [--depth=N] [--full]');
  }

  const unknownFlag = args.find((argument) => (
    argument.startsWith('--') && argument !== '--full' && !argument.startsWith('--depth=')
  ));
  if (unknownFlag) throw new Error(`unknown option: ${unknownFlag}`);

  const showAll = args.includes('--full');
  const depthFlag = args.find((argument) => argument.startsWith('--depth='));
  const parsedDepth = depthFlag ? Number(depthFlag.slice('--depth='.length)) : null;
  if (parsedDepth !== null && (!Number.isInteger(parsedDepth) || parsedDepth < 0)) {
    throw new Error(`--depth must be a non-negative integer: ${depthFlag}`);
  }

  return {
    grammar,
    sampleFile: path.resolve(sampleFile),
    maxDepth: parsedDepth ?? (showAll ? Number.POSITIVE_INFINITY : 8),
    showAll,
  };
}

function snippet(node: SyntaxNode): string {
  const text = node.text.replace(/\s+/gu, ' ').trim();
  return text.length > 48 ? `${text.slice(0, 48)}…` : text;
}

export async function runDumpAst(args: readonly string[]): Promise<number> {
  const options = parseDumpAstArguments(args);
  if (!existsSync(options.sampleFile)) {
    throw new Error(`sample file not found: ${options.sampleFile}`);
  }

  await initializeTreeSitter();
  const { language, wasmPath } = await loadGrammar(options.grammar);
  const parser = new Parser();
  try {
    parser.setLanguage(language);
    const source = readFileSync(options.sampleFile, 'utf8');
    const tree = parser.parse(source);
    if (!tree) throw new Error(`parser returned no tree for ${options.sampleFile}`);
    try {
      const frequencies = new Map<string, number>();
      const walk = (node: SyntaxNode, depth: number, fieldName: string | null): void => {
        if (node.isNamed) frequencies.set(node.type, (frequencies.get(node.type) ?? 0) + 1);
        if ((node.isNamed || options.showAll) && depth <= options.maxDepth) {
          const field = fieldName ? `${fieldName}: ` : '';
          const leaf = node.childCount === 0 ? `  "${snippet(node)}"` : '';
          console.log(
            `${'  '.repeat(depth)}${field}${node.type}  `
            + `@${node.startPosition.row + 1}:${node.startPosition.column}${leaf}`,
          );
        }
        for (let index = 0; index < node.childCount; index += 1) {
          const child = node.child(index);
          if (child) walk(child, depth + 1, node.fieldNameForChild(index));
        }
      };

      console.log(`\n# AST for ${options.sampleFile}  (grammar: ${path.basename(wasmPath)})\n`);
      walk(tree.rootNode, 0, null);
      console.log(
        '\n# Node-type frequency (named nodes) — map the relevant ones in your extractor:\n',
      );
      [...frequencies.entries()]
        .sort((left, right) => right[1] - left[1])
        .forEach(([type, count]) => console.log(`  ${String(count).padStart(5)}  ${type}`));
      console.log();
    } finally {
      tree.delete();
    }
  } finally {
    parser.delete();
  }
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = await runDumpAst(process.argv.slice(2));
  } catch (error) {
    console.error(`[dump-ast] ${errorMessage(error)}`);
    process.exitCode = 1;
  }
}
