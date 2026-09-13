#!/usr/bin/env bun

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Language, Parser } from 'web-tree-sitter';

import { errorMessage } from '../cli-tooling';
import { initializeTreeSitter, loadGrammar } from '../grammar-tooling';

const require = createRequire(import.meta.url);

interface CheckGrammarOptions {
  grammar: string;
  sampleFile: string;
  iterations: number;
}

export function parseCheckGrammarArguments(args: readonly string[]): CheckGrammarOptions {
  const [grammar, sampleFile, iterationsArgument, ...extra] = args;
  if (!grammar || !sampleFile || extra.length > 0) {
    throw new Error('usage: check-grammar <lang|wasm-path> <valid-sample> [iterations]');
  }
  const iterations = iterationsArgument === undefined
    ? 20
    : Number(iterationsArgument);
  if (!Number.isInteger(iterations) || iterations <= 0) {
    throw new Error(`iterations must be a positive integer: ${iterationsArgument}`);
  }
  return { grammar, sampleFile: path.resolve(sampleFile), iterations };
}

export async function runCheckGrammar(args: readonly string[]): Promise<number> {
  const options = parseCheckGrammarArguments(args);
  if (!existsSync(options.sampleFile)) {
    throw new Error(`sample file not found: ${options.sampleFile}`);
  }

  await initializeTreeSitter();
  try {
    await Language.load(require.resolve('tree-sitter-wasms/out/tree-sitter-python.wasm'));
  } catch {
    // The second grammar only reproduces shared-runtime corruption; failure to
    // preload it should not hide the target grammar's own health result.
  }

  const { language, wasmPath } = await loadGrammar(options.grammar);
  const parser = new Parser();
  let cleanParses = 0;
  let errorParses = 0;
  try {
    parser.setLanguage(language);
    const source = readFileSync(options.sampleFile, 'utf8');
    for (let iteration = 0; iteration < options.iterations; iteration += 1) {
      const tree = parser.parse(source);
      if (!tree) throw new Error(`parser returned no tree for ${options.sampleFile}`);
      if (tree.rootNode.hasError) errorParses += 1;
      else cleanParses += 1;
      tree.delete();
    }
  } finally {
    parser.delete();
  }

  console.log(`grammar: ${path.basename(wasmPath)}`);
  console.log(`  ABI version: ${language.abiVersion}`);
  console.log(`  parses: ${cleanParses} clean / ${errorParses} with errors (of ${options.iterations})`);
  if (errorParses > 0) {
    console.log(
      `RESULT: FAIL — ${errorParses}/${options.iterations} parses produced ERROR trees on a valid sample. `
      + 'This grammar is incompatible or corrupts the shared Tree-sitter runtime; use a newer grammar '
      + 'build and confirm that the sample is syntactically valid.',
    );
    return 1;
  }
  console.log('RESULT: PASS — grammar parses cleanly and reuses safely.');
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = await runCheckGrammar(process.argv.slice(2));
  } catch (error) {
    console.error(`[check-grammar] ${errorMessage(error)}`);
    process.exitCode = 2;
  }
}
