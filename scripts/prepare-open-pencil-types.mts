import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareOpenPencilSource } from './open-pencil-source.mts';
import { originalEditorAdaptations } from '../desktop/frontend/open-pencil/source-adaptations.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const vendor = path.join(root, 'vendor/open-pencil');
const cache = path.join(root, 'node_modules/.cache/cheshi-open-pencil');
const output = path.join(cache, 'types');

interface TypeConfiguration {
  compilerOptions: Record<string, unknown> & { paths: Record<string, string[]> };
}

async function emitDeclarations(config: string) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['run', 'vue-tsc', '-p', config], { cwd: root, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`OpenPencil declarations failed (${code}).`)));
  });
}

function declarationTransform() {
  const transform = originalEditorAdaptations().transform;
  if (typeof transform !== 'function') throw new Error('OpenPencil source transform is unavailable.');
  return transform;
}

function inlineSelectProps(source: string) {
  // Preserve the generic public contract while avoiding a private interface in
  // the dependency's generated Vue declaration.
  const props = source.match(/interface AppSelectProps<TValue extends string \| number> \{([\s\S]*?)\n\}/);
  if (!props?.[1]) throw new Error('OpenPencil select props need declaration review.');
  return source.replace(props[0], '').replace('defineProps<AppSelectProps<T>>()',
    `defineProps<{${props[1].replaceAll('TValue', 'T')}\n}>()`);
}

async function prepare() {
  await prepareOpenPencilSource(root);
  const configuration = JSON.parse(await readFile(path.join(vendor, 'tsconfig.json'), 'utf8')) as TypeConfiguration;
  const fingerprint = createHash('sha256').update(await readFile(path.join(root, 'vendor/open-pencil.version.json')))
    .update(await readFile(path.join(root, 'bun.lock')))
    .update(await readFile(path.join(root, 'desktop/frontend/package.json')))
    .update(await readFile(fileURLToPath(import.meta.url)))
    .update(await readFile(path.join(root, 'desktop/frontend/open-pencil/source-adaptations.ts')))
    .update(require('vue-tsc/package.json').version)
    .update(require('typescript/package.json').version).digest('hex');
  try {
    if (await readFile(path.join(output, '.stamp'), 'utf8') === fingerprint
      && (await readFile(path.join(output, 'src/app/tabs/index.d.ts'))).length > 0) return;
  } catch { /* A missing dependency declaration cache is regenerated. */ }
  await mkdir(cache, { recursive: true });
  const temporary = await mkdtemp(path.join(cache, 'types-'));
  try {
    const sourceRoot = path.join(temporary, 'source');
    const config = path.join(temporary, 'tsconfig.json');
    const declarations = path.join(temporary, 'declarations');
    const transform = declarationTransform();
    const sourceFiles = (await readdir(vendor, { recursive: true }))
      .filter(file => /^(?:src\/|packages\/[^/]+\/src\/)/.test(file) && /\.(?:ts|vue)$/.test(file));
    for (const file of sourceFiles) {
      const destination = path.join(sourceRoot, file);
      await mkdir(path.dirname(destination), { recursive: true });
      let source = await readFile(path.join(vendor, file), 'utf8');
      const result = await Reflect.apply(transform, {}, [source, path.join(vendor, file)]);
      if (result) source = typeof result === 'string' ? result : result.code;
      if (file === 'src/components/ui/select/AppSelect.vue') source = inlineSelectProps(source);
      await writeFile(destination, source);
    }
    // The pinned third-party source is compiled to dependency declarations, like
    // the published SDK. Cheshi's TS and Vue files are then checked separately
    // with strict/noUnused/noUncheckedIndexedAccess; none use noCheck.
    await writeFile(config, JSON.stringify({
      compilerOptions: {
        ...configuration.compilerOptions,
        paths: Object.fromEntries(Object.entries(configuration.compilerOptions.paths)
          .filter(([name]) => name !== 'tinykeys')
          .map(([name, paths]) => [name, paths.map(file => path.resolve(sourceRoot, file))])),
        typeRoots: [path.join(root, 'node_modules/@types')],
        declaration: true, emitDeclarationOnly: true, noEmit: false, noCheck: true,
        rootDir: sourceRoot, outDir: declarations,
      },
      include: ['src/**/*.ts', 'src/**/*.vue', 'packages/*/src/**/*.ts', 'packages/*/src/**/*.vue']
        .map(pattern => path.join(sourceRoot, pattern)),
    }));
    await emitDeclarations(config);
    for (const file of sourceFiles) {
      if (!file.endsWith('.d.ts')) continue;
      const destination = path.join(declarations, file);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(path.join(sourceRoot, file), destination);
    }
    await writeFile(path.join(declarations, '.stamp'), fingerprint);
    await rm(output, { recursive: true, force: true });
    await rename(declarations, output);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

await prepare();
