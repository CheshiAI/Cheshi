import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Language, Parser } from 'web-tree-sitter';

const require = createRequire(import.meta.url);
const wasmNameOverrides: Readonly<Record<string, string>> = {
  csharp: 'c_sharp',
  'c#': 'c_sharp',
};

export function resolveGrammarWasm(token: string): string {
  if (token.endsWith('.wasm')) {
    const explicitPath = path.resolve(token);
    if (!existsSync(explicitPath)) throw new Error(`wasm not found: ${explicitPath}`);
    return explicitPath;
  }

  const normalizedToken = token.toLowerCase();
  const grammarName = wasmNameOverrides[normalizedToken] ?? normalizedToken;
  try {
    return require.resolve(`tree-sitter-wasms/out/tree-sitter-${grammarName}.wasm`);
  } catch {
    // Some grammars are newer vendored builds that are not in tree-sitter-wasms.
  }

  const vendoredPath = path.resolve(
    import.meta.dir,
    '..',
    'extraction',
    'wasm',
    `tree-sitter-${grammarName}.wasm`,
  );
  if (existsSync(vendoredPath)) return vendoredPath;
  throw new Error(
    `no grammar for "${token}" — not in tree-sitter-wasms and not vendored at ${vendoredPath}`,
  );
}

export async function initializeTreeSitter(): Promise<void> {
  try {
    await Parser.init();
  } catch {
    await Parser.init({
      locateFile: () => require.resolve('web-tree-sitter/tree-sitter.wasm'),
    });
  }
}

export async function loadGrammar(token: string): Promise<{ language: Language; wasmPath: string }> {
  const wasmPath = resolveGrammarWasm(token);
  try {
    return { language: await Language.load(wasmPath), wasmPath };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to load grammar ${wasmPath}: ${reason}`, { cause: error });
  }
}
