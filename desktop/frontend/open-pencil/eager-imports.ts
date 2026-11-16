const importsByFile: Record<string, string> = {
  'src/app/ai/agents/discovery.ts': '@/app/automation/mcp/runtime',
  'packages/core/src/canvas/renderer/fonts.ts': '#core/layout',
  'packages/core/src/io/formats.ts': '#core/io/formats/html/vectors',
  'src/app/diagnostics/settings.ts': './recorder',
  'src/app/integrations/storage/s3/fetch.ts': '@/app/tauri/http',
  'src/app/integrations/storage/s3/client.ts': '@/app/integrations/storage/s3/cors',
  'src/app/shell/menu/app-menu.ts': '@/app/tabs',
  'src/app/shell/menu/navigation.ts': '@/app/tabs',
  'src/components/MobileHud/context.ts': '@/app/tabs',
};

/** These modules are already required by the embedded editor's static imports. */
export function normalizeEagerImports(source: string, id: string): string {
  const file = id.split('/vendor/open-pencil/')[1];
  if (!file || id.includes('?')) return source;
  const specifier = importsByFile[file];
  if (!specifier) return source;
  const expression = `import('${specifier}')`;
  if (!source.includes(expression)) throw new Error(`OpenPencil import integration needs review: ${id}`);
  // Retain the Promise API and live namespace bindings. The deferred callback
  // reads the module only when invoked, including through an import cycle.
  return `import * as cheshiEagerModule from '${specifier}'\n${source.replaceAll(expression,
    'Promise.resolve().then(() => cheshiEagerModule)')}`;
}
