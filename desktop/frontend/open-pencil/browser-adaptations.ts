import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Plugin } from 'vite';
import { normalizeEagerImports } from './eager-imports';

const require = createRequire(import.meta.url);
const stylesheetId = '@cheshi/tailwind-styles';
const virtualStylesheetId = '\0cheshi-tailwind-styles';

/** Browser-only replacements for upstream helpers that also support Node hosts. */
export function browserEditorAdaptations(): Plugin {
  return {
    name: 'cheshi-editor-browser-runtime', enforce: 'pre',
    resolveId(id) { return id === stylesheetId ? virtualStylesheetId : null; },
    load(id) {
      if (id !== virtualStylesheetId) return null;
      const styles = Object.fromEntries(['index', 'theme', 'preflight', 'utilities'].map(name => [
        `${name}.css`, readFileSync(require.resolve(`tailwindcss/${name}.css`), 'utf8'),
      ]));
      return `const styles = ${JSON.stringify(styles)};
export async function loadTailwindStylesheet(id) {
  const key = id === 'tailwindcss' ? 'index.css' : id.startsWith('tailwindcss/') ? id.slice(12) : id.startsWith('./') ? id.slice(2) : id;
  if (!Object.hasOwn(styles, key)) throw new Error('Unsupported bundled Tailwind stylesheet: ' + id);
  return styles[key];
}`;
    },
    transform(source, id) {
      if (id.includes('?')) return null;
      let result = normalizeEagerImports(source, id);
      const replace = (pattern: RegExp, replacement: string) => {
        if (!pattern.test(result)) throw new Error(`OpenPencil browser integration needs review: ${id}`);
        result = result.replace(pattern, replacement);
      };
      if (id.endsWith('/vendor/open-pencil/packages/core/src/text/fonts.ts')) {
        replace(/    const \{ readFile \} = await import\(\/\* @vite-ignore \*\/ 'node:fs\/promises'\)[\s\S]*?    return buf\.buffer\.slice\(buf\.byteOffset, buf\.byteOffset \+ buf\.byteLength\)/,
          '    return null');
      } else if (id.endsWith('/vendor/open-pencil/packages/dom-css/src/import/tailwind.ts')) {
        replace(/async function loadTailwindStylesheet\(id: string\): Promise<string> \{[\s\S]*?\n\}/,
          '');
        result = `import { loadTailwindStylesheet } from '${stylesheetId}'\n${result}`;
      } else if (id.endsWith('/vendor/open-pencil/packages/dom-css/src/export/bundle.ts')) {
        replace(/  const \[\{ compile \}, \{ readFile \}\] = await Promise\.all\(\[[\s\S]*?    readFile\(new URL\(import\.meta\.resolve\('tailwindcss\/utilities\.css'\)\), 'utf8'\)\n  \]\)/,
          `  const [{ compile }, themeCSS, utilitiesCSS] = await Promise.all([
    import('tailwindcss'),
    loadTailwindStylesheet('tailwindcss/theme.css'),
    loadTailwindStylesheet('tailwindcss/utilities.css')
  ])`);
        result = `import { loadTailwindStylesheet } from '${stylesheetId}'\n${result}`;
      }
      return result === source ? null : { code: result, map: null };
    },
  };
}
